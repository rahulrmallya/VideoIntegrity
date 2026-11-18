"""Frame and checkpoint verification."""

import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

import cv2

from app import crypto
from app.incidents import IncidentManager
from app.models import ChainRecord, Incident, IncidentEvidence, IncidentKind
from app.producer import Packet

SEEN_LIMIT = 900
TimelineStatus = Literal["pending", "sealed", "unverified", "tampered", "missing"]


@dataclass(frozen=True)
class SealResult:
    """The verification outcome for a checkpoint and its window."""

    seq: int
    valid: bool
    window_from: int
    window_to: int
    chain_hash: str
    signature: str | None
    verify_ms: float


@dataclass(frozen=True)
class VerifyResult:
    """The verdict and timeline changes produced by a single delivery."""

    verdict: Literal["ok", "tampered"]
    reasons: list[IncidentKind]
    computed_hash: str
    status_updates: list[tuple[int, TimelineStatus]]
    seal: SealResult | None
    verify_ms: float


def _recompute_link(header: ChainRecord) -> str | None:
    """Recompute a header's chain hash, rejecting incorrectly sized fields."""
    try:
        prev = bytes.fromhex(header.prev_hash)
        frame_hash = bytes.fromhex(header.frame_hash)
        dhash = bytes.fromhex(header.dhash)
        if (len(prev), len(frame_hash), len(dhash)) != (32, 32, 8):
            return None
        return crypto.link(prev, frame_hash, dhash, header.seq, header.ts_ns).hex()
    except (ValueError, OverflowError):
        return None


class Verifier:
    """Verify the delivered packet sequence and group integrity failures."""

    def __init__(
        self,
        session_id: str,
        pk_raw: bytes,
        checkpoint_interval: int,
        fps: float,
        clock: Callable[[], float] = time.monotonic,
        *,
        on_incident: Callable[[Incident], None] | None = None,
        offline: bool = False,
    ) -> None:
        """Start at genesis and arm the watchdog on the first delivery."""
        if checkpoint_interval <= 0 or fps <= 0:
            raise ValueError("checkpoint_interval and fps must be positive")
        self.session_id = session_id
        self.pk_raw = pk_raw
        self.checkpoint_interval = checkpoint_interval
        self.anchor = crypto.genesis(session_id, pk_raw).hex()
        self.expected_seq = 0
        self.seen: dict[int, str] = {}
        self.window: dict[int, TimelineStatus] = {}
        self.window_failures = 0
        self.reanchored_in_window = False
        self.incident_manager = IncidentManager(on_incident)
        self.last_delivery_time: float | None = None
        self._clock = clock
        self._offline = offline
        self._silence_limit = 2 * checkpoint_interval / fps
        self._silence_reported = False

    @property
    def incidents(self) -> list[Incident]:
        """Return the recent incident records, newest first."""
        return self.incident_manager.incidents

    @property
    def open_incident(self) -> Incident | None:
        """Return the incident currently awaiting a clean checkpoint."""
        return self.incident_manager.open_incident

    def process(self, packet: Packet) -> VerifyResult:
        """Apply the contract's packet checks in order."""
        started = time.perf_counter()
        header = packet.header
        seq = header.seq
        self.last_delivery_time = self._clock()
        self._silence_reported = False

        reasons: list[IncidentKind] = []
        updates: list[tuple[int, TimelineStatus]] = []

        # 1. Late or repeated packets never enter the chain.
        if seq < self.expected_seq:
            reason = self._check_late(header, updates)
            return VerifyResult(
                "tampered",
                [reason],
                crypto.sha256(packet.payload).hex(),
                updates,
                None,
                (time.perf_counter() - started) * 1000,
            )

        # 2. Report a gap before evaluating the delivered packet.
        gap = seq > self.expected_seq
        if gap:
            first = self.expected_seq
            self.report_gap(seq)
            reasons.append("FRAME_DELETED")
            if not self._offline:
                updates.extend((missing, "missing") for missing in range(first, seq))

        # 3. Compare the actual payload with the recorded frame fingerprint.
        computed = crypto.sha256(packet.payload).hex()
        payload_changed = computed != header.frame_hash
        if payload_changed:
            self._check_modified(packet, computed)
            reasons.append("FRAME_MODIFIED")

        # 4. Check the arithmetic of the delivered header.
        recomputed = _recompute_link(header)
        if recomputed != header.chain_hash:
            recorded = crypto.short(header.chain_hash)
            proof = (
                f"Recomputed chain hash {crypto.short(recomputed)} ≠ recorded {recorded}"
                if recomputed is not None
                else f"Invalid chain header; recorded chain hash {recorded}"
            )
            self._fail(
                "CHAIN_BROKEN", seq, proof,
                expected_hash=recomputed, actual_hash=header.chain_hash,
            )
            reasons.append("CHAIN_BROKEN")

        checkpoint = header.is_checkpoint
        if self._offline:
            checkpoint = (seq + 1) % self.checkpoint_interval == 0
            if (header.session_id != self.session_id or header.is_checkpoint != checkpoint
                    or (not checkpoint and header.signature is not None)):
                self._fail("CHAIN_BROKEN", seq, f"Invalid producer header at frame #{seq}")
                if "CHAIN_BROKEN" not in reasons:
                    reasons.append("CHAIN_BROKEN")

        # 5. Re-anchor at a broken predecessor, even when a gap explains it.
        if header.prev_hash != self.anchor:
            if not gap:
                self._fail(
                    "CHAIN_BROKEN",
                    seq,
                    f"Previous hash {crypto.short(header.prev_hash)} ≠ expected {crypto.short(self.anchor)}",
                    expected_prev=self.anchor,
                    actual_prev=header.prev_hash,
                )
                reasons.append("CHAIN_BROKEN")
            updates.extend(
                (pending_seq, "unverified")
                for pending_seq, status in self.window.items()
                if status == "pending"
            )
            self.window.clear()
            self.reanchored_in_window = True

        # 6. Accept the delivered header and track the frame in this window.
        self.anchor = header.chain_hash
        self.expected_seq = seq + 1
        self.seen[seq] = header.chain_hash
        if len(self.seen) > SEEN_LIMIT:
            del self.seen[next(iter(self.seen))]
        if len(self.window) >= self.checkpoint_interval:
            # A conforming stream always checkpoints before the window gets this large.
            oldest = next(iter(self.window))
            if self.window.pop(oldest) == "pending":
                updates.append((oldest, "unverified"))
            self.reanchored_in_window = True
        status = "tampered" if payload_changed else "pending"
        self.window[seq] = status
        updates.append((seq, status))

        # 7. Resolve the window when a checkpoint arrives.
        seal = None
        if checkpoint:
            seal = self._check_checkpoint(header, updates)
            if not seal.valid:
                reasons.append("CHAIN_FORGED")

        verdict = "tampered" if any(reason != "FRAME_DELETED" for reason in reasons) else "ok"
        return VerifyResult(
            verdict, reasons, computed, updates, seal, (time.perf_counter() - started) * 1000
        )

    def tick(self, now: float) -> Incident | None:
        """Report at most one interruption until another packet is delivered."""
        # 8. The watchdog runs on producer ticks, including ticks with no delivery.
        if self._offline or self.last_delivery_time is None or self._silence_reported:
            return None
        elapsed = now - self.last_delivery_time
        if elapsed < self._silence_limit:
            return None
        self._silence_reported = True
        return self._fail(
            "STREAM_INTERRUPTED",
            self.expected_seq - 1,
            f"No delivery for {elapsed:g} s; last chain hash {crypto.short(self.anchor)}",
            seq_from=self.expected_seq,
            seq_to=self.expected_seq,
            silence_s=elapsed,
        )

    def report_gap(self, next_seq: int) -> Incident:
        """Report the missing range before the next known sequence boundary."""
        first = self.expected_seq
        return self._fail(
            "FRAME_DELETED",
            first,
            f"Expected frame #{first}; missing through #{next_seq - 1}; prior hash {crypto.short(self.anchor)}",
            seq_to=next_seq - 1,
        )

    def _check_late(
        self, header: ChainRecord, updates: list[tuple[int, TimelineStatus]]
    ) -> IncidentKind:
        """Classify a sequence that cannot be accepted into the chain."""
        seq = header.seq
        prior = self.seen.get(seq)
        delivered = crypto.short(header.chain_hash)
        if prior == header.chain_hash:
            kind = "REPLAY_DETECTED"
            proof = f"Frame #{seq} repeats chain hash {delivered}"
        elif prior is not None:
            kind = "FRAME_INSERTED"
            proof = f"Frame #{seq} chain hash {delivered} ≠ first seen {crypto.short(prior)}"
        else:
            kind = "FRAME_REORDERED"
            proof = f"Frame #{seq} ({delivered}) arrived after #{self.expected_seq - 1}"

        if kind != "REPLAY_DETECTED":
            updates.append((seq, "tampered"))
            if seq in self.window:
                self.window[seq] = "tampered"
        self._fail(kind, seq, proof, expected_hash=prior, actual_hash=header.chain_hash)
        return kind

    def _check_modified(self, packet: Packet, computed: str) -> None:
        """Capture the changed payload hash and any available visual comparison."""
        header = packet.header
        try:
            received_dhash = crypto.dhash_from_jpeg(packet.payload)
            pct = crypto.hamming(received_dhash, bytes.fromhex(header.dhash)) / 64 * 100
        except (ValueError, cv2.error):
            pct = None
        self._fail(
            "FRAME_MODIFIED",
            header.seq,
            f"SHA-256(received) {crypto.short(computed)} ≠ recorded {crypto.short(header.frame_hash)}",
            expected_hash=header.frame_hash,
            actual_hash=computed,
            visual_change_pct=pct,
        )

    def _check_checkpoint(
        self, header: ChainRecord, updates: list[tuple[int, TimelineStatus]]
    ) -> SealResult:
        """Verify the signature, resolve timeline entries, and reset the window."""
        started = time.perf_counter()
        valid = self._verify_checkpoint_signature(header)
        verify_ms = (time.perf_counter() - started) * 1000
        first = next(iter(self.window))
        if valid:
            updates.extend(
                (seq, "sealed") for seq, status in self.window.items() if status == "pending"
            )
            if self.window_failures == 0 and not self.reanchored_in_window:
                self.incident_manager.close()
        else:
            updates.extend((seq, "tampered") for seq in self.window)
            self._fail(
                "CHAIN_FORGED",
                header.seq,
                f"Ed25519 signature failed for chain hash {crypto.short(header.chain_hash)}",
                seq_from=first,
                actual_hash=header.chain_hash,
            )
        self.window.clear()
        self.window_failures = 0
        self.reanchored_in_window = False
        return SealResult(
            header.seq, valid, first, header.seq, header.chain_hash, header.signature, verify_ms
        )

    def _verify_checkpoint_signature(self, header: ChainRecord) -> bool:
        """Verify a checkpoint against the session's public key."""
        try:
            chain_hash = bytes.fromhex(header.chain_hash)
            if len(chain_hash) != 32:
                return False
            signature = bytes.fromhex(header.signature) if header.signature is not None else None
            message = crypto.checkpoint_message(self.session_id, header.seq, chain_hash)
        except (ValueError, OverflowError):
            return False
        return crypto.verify(self.pk_raw, signature, message)

    def _fail(
        self,
        kind: IncidentKind,
        seq: int,
        proof: str,
        *,
        seq_from: int | None = None,
        seq_to: int | None = None,
        expected_hash: str | None = None,
        actual_hash: str | None = None,
        expected_prev: str | None = None,
        actual_prev: str | None = None,
        visual_change_pct: float | None = None,
        silence_s: float = 0.0,
    ) -> Incident:
        """Count a failure and report evidence to the incident manager."""
        self.window_failures += 1
        evidence = IncidentEvidence(
            sample_seq=seq,
            expected_hash=expected_hash,
            actual_hash=actual_hash,
            expected_prev=expected_prev,
            actual_prev=actual_prev,
            visual_change_pct=visual_change_pct,
        )
        return self.incident_manager.report(
            kind,
            seq if seq_from is None else seq_from,
            seq if seq_to is None else seq_to,
            evidence,
            proof,
            silence_s=silence_s,
        )
