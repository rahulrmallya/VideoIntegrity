"""Synthetic frame tests for the producer, verifier, and incident lifecycle."""

from collections.abc import Iterable
from dataclasses import dataclass, replace

import cv2
import numpy as np
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from app import crypto
from app.models import Incident, IncidentKind
from app.producer import Packet, Producer
from app.verifier import Verifier, VerifyResult

SESSION_ID = "00000000-0000-4000-8000-000000000000"
CHECKPOINT_INTERVAL = 15
FPS = 15
START_NS = 1_700_000_000_000_000_000


@dataclass
class FakeClock:
    """Manually advance the verifier's monotonic clock."""

    now: float = 0.0

    def __call__(self) -> float:
        """Return the simulated time."""
        return self.now


@dataclass
class Stream:
    """A producer, verifier, and in-memory observer for a synthetic stream."""

    packets: list[Packet]
    changed_jpeg: bytes
    verifier: Verifier
    clock: FakeClock
    events: list[Incident]
    timeline: dict[int, str]

    def send(self, packet: Packet) -> VerifyResult:
        """Deliver a packet and apply the verifier's timeline updates."""
        result = self.verifier.process(packet)
        self.timeline.update(result.status_updates)
        return result

    def send_all(self, packets: Iterable[Packet]) -> None:
        """Deliver a sequence of packets in the given order."""
        for packet in packets:
            self.send(packet)

    def confirm_recovery(self, kind: IncidentKind, first: int, last: int) -> Incident:
        """Confirm one closed incident and resumed sealing of honest frames."""
        [incident] = self.verifier.incidents
        assert incident.id == "inc_0001"
        assert incident.kind == kind
        assert incident.status == "closed"
        assert incident.closed_at is not None
        assert self.verifier.open_incident is None
        assert {event.id for event in self.events} == {incident.id}
        assert self.events[0].status == "open"
        assert self.events[-1] == incident
        assert [self.timeline[seq] for seq in range(first, last + 1)] == ["sealed"] * (
            last - first + 1
        )
        return incident


def _jpeg(gray: np.ndarray) -> bytes:
    """Encode a synthetic test image as JPEG."""
    ok, encoded = cv2.imencode(".jpg", gray)
    assert ok
    return encoded.tobytes()


@pytest.fixture
def stream() -> Stream:
    """Create 120 packets and an edited image with a different dHash."""
    sk = Ed25519PrivateKey.from_private_bytes(bytes(range(32)))
    pk = sk.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    producer = Producer(SESSION_ID, sk, pk, CHECKPOINT_INTERVAL)
    gray = np.tile(np.arange(64, dtype=np.uint8) * 4, (48, 1))
    original = _jpeg(gray)
    changed = _jpeg(np.fliplr(gray))
    packets = []
    for seq in range(120):
        timestamp = START_NS + seq * 1_000_000_000 // FPS
        packets.append(producer.make_packet(original, timestamp))
        assert producer.hash_ms >= 0.0
        assert producer.sign_ms >= 0.0
        if not packets[-1].header.is_checkpoint:
            assert producer.sign_ms == 0.0
    clock = FakeClock()
    events: list[Incident] = []
    verifier = Verifier(SESSION_ID, pk, CHECKPOINT_INTERVAL, FPS, clock, on_incident=events.append)
    return Stream(packets, changed, verifier, clock, events, {})


def _changed_header(packet: Packet, payload: bytes, prev_hash: str) -> Packet:
    """Build an internally consistent synthetic replacement for a test packet."""
    header = packet.header
    frame_hash = crypto.sha256(payload)
    dhash = crypto.dhash_from_jpeg(payload)
    chain_hash = crypto.link(bytes.fromhex(prev_hash), frame_hash, dhash, header.seq, header.ts_ns)
    return Packet(
        header.model_copy(update={
            "prev_hash": prev_hash,
            "frame_hash": frame_hash.hex(),
            "dhash": dhash.hex(),
            "chain_hash": chain_hash.hex(),
        }),
        payload,
    )


def test_honest_stream_seals_every_frame(stream: Stream) -> None:
    """Verify 120 honest frames and each signed checkpoint."""
    previous = crypto.genesis(SESSION_ID, stream.verifier.pk_raw).hex()
    for seq, packet in enumerate(stream.packets):
        header = packet.header
        assert header.seq == seq
        assert header.session_id == SESSION_ID
        assert header.prev_hash == previous
        assert header.frame_hash == crypto.sha256(packet.payload).hex()
        assert header.dhash == crypto.dhash_from_jpeg(packet.payload).hex()
        previous = header.chain_hash

        result = stream.send(packet)
        assert result.reasons == []
        assert result.verdict == "ok"
        assert result.computed_hash == header.frame_hash
        assert result.verify_ms >= 0.0
        is_checkpoint = (seq + 1) % CHECKPOINT_INTERVAL == 0
        assert header.is_checkpoint == is_checkpoint
        if is_checkpoint:
            assert result.seal is not None and result.seal.valid
            assert result.seal.window_from == seq - CHECKPOINT_INTERVAL + 1
            assert result.seal.window_to == result.seal.seq == seq
            assert result.seal.signature == header.signature
            assert header.signature is not None and len(header.signature) == 128
        else:
            assert result.seal is None
            assert header.signature is None
            assert stream.timeline[seq] == "pending"

    assert stream.timeline == dict.fromkeys(range(120), "sealed")
    assert stream.verifier.incidents == []
    assert stream.events == []


@pytest.mark.parametrize("decodable", [True, False])
def test_modified_payload(stream: Stream, decodable: bool) -> None:
    """Detect modified JPEG bytes whether or not they still decode."""
    stream.send_all(stream.packets[:18])
    payload = stream.changed_jpeg if decodable else bytes.fromhex("ffd8") + b"invalid JPEG"
    changed = replace(stream.packets[18], payload=payload)
    result = stream.send(changed)
    assert result.verdict == "tampered"
    assert result.reasons == ["FRAME_MODIFIED"]
    assert result.computed_hash == crypto.sha256(payload).hex()
    [incident] = stream.verifier.incidents
    assert incident.status == "open"
    assert incident.title == "Frame content altered"
    assert incident.evidence.expected_hash == changed.header.frame_hash
    assert incident.evidence.actual_hash == result.computed_hash
    assert incident.evidence.visual_change_pct == (100.0 if decodable else None)
    assert incident.proof == (
        f"SHA-256(received) {crypto.short(result.computed_hash)} "
        f"≠ recorded {crypto.short(changed.header.frame_hash)}"
    )

    stream.send_all(stream.packets[19:30])
    assert stream.verifier.open_incident is not None
    stream.send_all(stream.packets[30:45])
    incident = stream.confirm_recovery("FRAME_MODIFIED", 30, 44)
    assert incident.affected_count == 1 and incident.detection_latency_ms is None
    assert stream.timeline[18] == "tampered"


def test_dropped_packet(stream: Stream) -> None:
    """Mark the gap and abandon pending frames before the broken link."""
    stream.send_all(stream.packets[:18])
    result = stream.send(stream.packets[19])
    assert result.reasons == ["FRAME_DELETED"]
    assert result.status_updates == [
        (18, "missing"),
        (15, "unverified"),
        (16, "unverified"),
        (17, "unverified"),
        (19, "pending"),
    ]
    stream.send_all(stream.packets[20:45])
    incident = stream.confirm_recovery("FRAME_DELETED", 30, 44)
    assert incident.seq_from == incident.seq_to == 18
    assert incident.affected_count == incident.missing_count == 1
    assert stream.timeline[18] == "missing"


def test_gap_is_reported_before_a_modified_delivery(stream: Stream) -> None:
    """Group multiple failures without including an arrived frame in the gap proof."""
    stream.send_all(stream.packets[:18])
    changed = replace(stream.packets[19], payload=stream.changed_jpeg)
    result = stream.send(changed)

    assert result.reasons == ["FRAME_DELETED", "FRAME_MODIFIED"]
    assert stream.timeline[18] == "missing"
    assert stream.timeline[19] == "tampered"
    stream.send_all(stream.packets[20:45])
    incident = stream.confirm_recovery("FRAME_DELETED", 30, 44)
    assert incident.kinds_seen == result.reasons
    assert (incident.seq_from, incident.seq_to) == (18, 19)
    assert incident.affected_count == 2
    assert incident.missing_count == 1
    assert incident.explanation.startswith("1 frames (#18–#18) never arrived.")


def test_swapped_pair_reclassifies_existing_incident(stream: Stream) -> None:
    """Change the original deletion alert to a reorder alert under the same ID."""
    stream.send_all(stream.packets[:18])
    stream.send(stream.packets[19])
    result = stream.send(stream.packets[18])
    assert result.reasons == ["FRAME_REORDERED"]
    assert result.verdict == "tampered"
    assert result.status_updates == [(18, "tampered")]
    assert [event.kind for event in stream.events] == ["FRAME_DELETED", "FRAME_REORDERED"]
    assert stream.events[0].missing_count == 1
    assert stream.events[1].missing_count == 0

    stream.send_all(stream.packets[20:45])
    incident = stream.confirm_recovery("FRAME_REORDERED", 30, 44)
    assert incident.kinds_seen == ["FRAME_DELETED", "FRAME_REORDERED"]
    assert incident.evidence.sample_seq == 18
    assert incident.affected_count == 1
    assert stream.timeline[18] == "tampered"


def test_replay_does_not_change_original_status(stream: Stream) -> None:
    """Recognize a repeated checkpoint without accepting or verifying it again."""
    stream.send_all(stream.packets[:19])
    prior_anchor = stream.verifier.anchor
    result = stream.send(stream.packets[14])
    assert result.reasons == ["REPLAY_DETECTED"]
    assert result.verdict == "tampered"
    assert result.status_updates == []
    assert result.seal is None
    assert stream.verifier.anchor == prior_anchor
    assert stream.verifier.expected_seq == 19
    assert stream.timeline[14] == "sealed"

    stream.send_all(stream.packets[19:45])
    stream.confirm_recovery("REPLAY_DETECTED", 30, 44)


def test_inserted_packet_is_detected_on_duplicate_sequence(stream: Stream) -> None:
    """Detect two chain hashes for one sequence, including a consistent first header."""
    stream.send_all(stream.packets[:18])
    genuine = stream.packets[18]
    inserted = _changed_header(genuine, stream.changed_jpeg, stream.verifier.anchor)
    assert stream.send(inserted).reasons == []

    result = stream.send(genuine)
    assert result.reasons == ["FRAME_INSERTED"]
    assert result.verdict == "tampered"
    assert result.status_updates == [(18, "tampered")]
    assert stream.verifier.anchor == inserted.header.chain_hash
    assert stream.verifier.expected_seq == 19
    stream.send_all(stream.packets[19:45])
    incident = stream.confirm_recovery("FRAME_INSERTED", 30, 44)
    assert incident.kinds_seen == ["FRAME_INSERTED", "CHAIN_BROKEN"]
    assert stream.timeline[18] == "tampered"


def test_forgery_fails_at_checkpoint(stream: Stream) -> None:
    """Check that an original signature cannot authenticate a changed test chain."""
    stream.send_all(stream.packets[:24])
    prev = stream.verifier.anchor
    for original in stream.packets[24:30]:
        forged = _changed_header(original, stream.changed_jpeg, prev)
        prev = forged.header.chain_hash
        result = stream.send(forged)
        assert forged.header.signature == original.header.signature
        if original.header.is_checkpoint:
            assert result.reasons == ["CHAIN_FORGED"]
            assert result.seal is not None and not result.seal.valid
            assert result.seal.window_from == 15
            assert result.seal.window_to == 29
        else:
            assert result.verdict == "ok" and result.reasons == []
            assert stream.verifier.incidents == []

    assert all(stream.timeline[seq] == "tampered" for seq in range(15, 30))
    stream.send_all(stream.packets[30:45])
    assert stream.verifier.open_incident is not None
    stream.send_all(stream.packets[45:60])
    stream.confirm_recovery("CHAIN_FORGED", 45, 59)


def test_missing_checkpoint_signature(stream: Stream) -> None:
    """Reject a designated checkpoint that arrives without a signature."""
    stream.send_all(stream.packets[:14])
    checkpoint = stream.packets[14]
    result = stream.send(replace(checkpoint, header=checkpoint.header.model_copy(
        update={"signature": None}
    )))
    assert result.reasons == ["CHAIN_FORGED"]
    assert result.seal is not None and not result.seal.valid
    assert all(stream.timeline[seq] == "tampered" for seq in range(15))

    stream.send_all(stream.packets[15:30])
    stream.confirm_recovery("CHAIN_FORGED", 15, 29)


def test_inconsistent_header_reports_chain_broken(stream: Stream) -> None:
    """Recompute the chain hash before checking the header's predecessor."""
    stream.send_all(stream.packets[:18])
    packet = stream.packets[18]
    changed = packet.header.model_copy(update={"ts_ns": packet.header.ts_ns + 1})
    result = stream.send(replace(packet, header=changed))
    assert result.reasons == ["CHAIN_BROKEN"]
    assert result.verdict == "tampered"

    stream.send_all(stream.packets[19:45])
    stream.confirm_recovery("CHAIN_BROKEN", 30, 44)


def test_watchdog_arms_on_first_packet_and_reports_once(stream: Stream) -> None:
    """Ignore startup silence and report an interruption once per delivery gap."""
    stream.clock.now = 3.0
    assert stream.verifier.tick(stream.clock.now) is None
    assert stream.verifier.incidents == []
    stream.send(stream.packets[0])

    stream.clock.now = 4.9
    assert stream.verifier.tick(stream.clock.now) is None
    stream.clock.now = 6.0
    event = stream.verifier.tick(stream.clock.now)
    assert event is not None
    assert event.severity == "warning"
    assert event.evidence.sample_seq == 0
    assert event.seq_from == event.seq_to == 1
    assert event.explanation == "No signed frames reached the viewer for 3 s."
    stream.clock.now = 7.0
    assert stream.verifier.tick(stream.clock.now) is None
    assert len(stream.events) == 1

    stream.send_all(stream.packets[1:30])
    stream.confirm_recovery("STREAM_INTERRUPTED", 15, 29)


def test_seen_retains_only_last_900_sequences(stream: Stream) -> None:
    """Evict old sequence hashes while sealing all honest checkpoints."""
    sk = Ed25519PrivateKey.from_private_bytes(bytes(range(32)))
    producer = Producer(SESSION_ID, sk, stream.verifier.pk_raw, CHECKPOINT_INTERVAL)
    jpeg = stream.packets[0].payload
    for seq in range(915):
        stream.send(producer.make_packet(jpeg, START_NS + seq * 1_000_000_000 // FPS))

    assert list(stream.verifier.seen) == list(range(15, 915))
    assert stream.verifier.incidents == []
    assert set(stream.timeline.values()) == {"sealed"}
