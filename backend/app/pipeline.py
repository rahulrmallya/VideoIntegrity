"""Background capture and verification pipeline."""

import asyncio
import logging
import time
from base64 import b64encode
from collections import Counter, OrderedDict
from dataclasses import asdict, dataclass, field
from itertools import count
from pathlib import Path
from threading import Event, Lock, Thread
from typing import Literal
from uuid import uuid4

import cv2
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from app import crypto
from app.broadcaster import Broadcaster, Message
from app.channel import AttackConflict, Channel
from app.config import utc_timestamp
from app.models import (
    AttackAck, AttackRequest, ChainRecord, Device, Incident, Seal, Session, StartRequest, Stats,
)
from app.producer import Packet, Producer
from app.sources import FrameSource, open_source
from app.vault import FrameCopy, Vault
from app.verifier import SEEN_LIMIT, TimelineStatus, Verifier, VerifyResult

logger = logging.getLogger(__name__)


@dataclass
class _Metrics:
    """Bounded timeline bookkeeping and cumulative stream counters."""

    frames_produced: int = 0
    frames_delivered: int = 0
    signed: int = 0
    checkpoints_ok: int = 0
    checkpoints_failed: int = 0
    hash_ms: float = 0.0
    sign_ms: float = 0.0
    verify_ms: float = 0.0
    fps_actual: float = 0.0
    sample_time: float = 0.0
    sample_frames: int = 0
    counts: Counter[TimelineStatus] = field(default_factory=Counter)
    recent: OrderedDict[int, TimelineStatus] = field(default_factory=OrderedDict)

    def apply(self, result: VerifyResult, limit: int) -> None:
        """Count a delivery and reflect its timeline transitions."""
        self.frames_delivered += 1
        self.verify_ms += result.verify_ms
        if result.seal is not None:
            if result.seal.valid:
                self.checkpoints_ok += 1
            else:
                self.checkpoints_failed += 1
        for seq, status in result.status_updates:
            previous = self.recent.pop(seq, None)
            if previous is not None:
                self.counts[previous] -= 1
            self.recent[seq] = status
            self.counts[status] += 1
            if len(self.recent) > limit:
                self.recent.popitem(last=False)


@dataclass
class _Run:
    """Capture and verification state for one session."""

    vault: Vault
    producer: Producer
    channel: Channel
    verifier: Verifier
    started: float
    metrics: _Metrics
    incident_events: list[Incident]
    stopped: float | None = None
    pending: dict[int, bytes] = field(default_factory=dict)


@dataclass
class _Startup:
    """Signal the first persisted frame or a startup error to the caller."""

    ready: Event = field(default_factory=Event)
    error: Exception | None = None


class Pipeline:
    """Own one capture thread and expose session snapshots to the API."""

    def __init__(
        self,
        loop: asyncio.AbstractEventLoop,
        broadcaster: Broadcaster,
        data_dir: Path,
        device: Device,
        sk: Ed25519PrivateKey,
        pk_raw: bytes,
    ) -> None:
        """Initialize an idle pipeline using the persistent device key."""
        self._loop = loop
        self._broadcaster = broadcaster
        self._sessions_dir = data_dir / "sessions"
        self.device = device
        self._sk = sk
        self._pk_raw = pk_raw
        self._lifecycle = Lock()
        self._state = Lock()
        self._attack_ids = count(1)
        self._thread: Thread | None = None
        self._stop_signal = Event()
        self._seal_error: Exception | None = None
        self._run: _Run | None = None
        defaults = StartRequest(source="webcam")
        self._session = Session(
            session_id=None,
            status="idle",
            source=None,
            source_label=None,
            fps=defaults.fps,
            width=defaults.width,
            height=defaults.height,
            checkpoint_interval=defaults.checkpoint_interval,
            started_at=None,
            stopped_at=None,
            device_id=device.device_id,
            seal=None,
        )

    def session(self) -> Session:
        """Return the current session snapshot."""
        with self._state:
            return self._session.model_copy(deep=True)

    def start(self, request: StartRequest) -> Session:
        """Stop the previous capture and start a new one with a fresh chain."""
        with self._lifecycle:
            self._join_capture()
            self._stop_signal.clear()
            self._seal_error = None
            startup = _Startup()
            self._thread = Thread(
                target=self._capture, args=(request, startup), name="frameseal-capture", daemon=True
            )
            self._thread.start()
            startup.ready.wait()
            if startup.error is not None:
                self._join_capture()
                raise RuntimeError("Could not start capture") from startup.error
            return self.session()

    def stop(self) -> Session:
        """Wait for capture to finish and return the stopped session."""
        with self._lifecycle:
            self._join_capture()
            if self._seal_error is not None:
                raise RuntimeError("Could not persist the session seal") from self._seal_error
            return self.session()

    def _join_capture(self) -> None:
        """Signal and join the capture thread while holding the lifecycle lock."""
        if self._thread is not None:
            self._stop_signal.set()
            self._thread.join()
            self._thread = None

    def chain(self, limit: int) -> list[ChainRecord]:
        """Read the current session's recent ledger records."""
        with self._state:
            run = self._run
        return [] if run is None else run.vault.recent_chain(limit)

    def frame_path(self, seq: int, copy: FrameCopy) -> Path | None:
        """Locate a frame file in the current session, if it exists."""
        with self._state:
            run = self._run
        if run is None:
            return None
        path = run.vault.frame_path(seq, copy)
        return path if path.is_file() else None

    def incidents(self) -> list[Incident]:
        """Return the current session's incident history."""
        with self._state:
            return [] if self._run is None else self._run.verifier.incidents

    def start_attack(self, request: AttackRequest) -> AttackAck:
        """Schedule an attack on the current session's capture channel."""
        with self._state:
            run = self._run
            if (run is None or self._session.status != "running"
                    or run.stopped is not None or self._stop_signal.is_set()):
                raise AttackConflict("No session is running")
            ack = run.channel.attacks.start(request.type, request.params)
            self._publish_attack(ack, "started")
            return ack

    def acknowledge(self, incident_id: str) -> Incident | None:
        """Acknowledge an incident and publish it to listeners."""
        with self._state:
            run = self._run
            if run is None:
                return None
            incident = run.verifier.incident_manager.acknowledge(incident_id)
            self._publish_incidents(run)
            return incident

    def stats(self) -> Stats:
        """Return a consistent snapshot of live counters and integrity."""
        with self._state:
            return self._stats(time.monotonic())

    def _stats(self, now: float) -> Stats:
        """Build stats while the state lock is held."""
        run = self._run
        metrics = run.metrics if run is not None else _Metrics()
        incident = run.verifier.open_incident if run is not None else None
        latency = None
        if run is not None and run.verifier.incident_manager.total:
            latest = run.verifier.incidents[0]
            latency = latest.detection_latency_ms
        integrity = "IDLE"
        if self._session.status == "running":
            integrity = "COMPROMISED" if incident is not None else "SECURE"
        return Stats(
            integrity=integrity,
            fps_actual=metrics.fps_actual,
            uptime_s=((run.stopped if run.stopped is not None else now) - run.started) if run else 0,
            frames_produced=metrics.frames_produced,
            frames_delivered=metrics.frames_delivered,
            frames_sealed=metrics.counts["sealed"],
            frames_pending=metrics.counts["pending"],
            frames_unverified=metrics.counts["unverified"],
            frames_tampered=metrics.counts["tampered"],
            frames_missing=metrics.counts["missing"],
            checkpoints_ok=metrics.checkpoints_ok,
            checkpoints_failed=metrics.checkpoints_failed,
            avg_hash_ms=metrics.hash_ms / max(1, metrics.frames_produced),
            avg_sign_ms=metrics.sign_ms / max(1, metrics.signed),
            avg_verify_ms=metrics.verify_ms / max(1, metrics.frames_delivered),
            chain_head=run.verifier.anchor if run and metrics.frames_delivered else None,
            open_incident_id=incident.id if incident else None,
            incidents_total=run.verifier.incident_manager.total if run else 0,
            last_detection_latency_ms=latency,
        )

    def _publish(self, message: Message) -> None:
        """Schedule a notification without waiting for the loop or its clients."""
        self._loop.call_soon_threadsafe(self._broadcaster.publish, message)

    def _publish_incidents(self, run: _Run) -> None:
        """Emit incident snapshots in the order they were recorded."""
        for incident in run.incident_events:
            self._publish({"type": "incident", "incident": incident.model_dump(mode="json")})
        run.incident_events.clear()

    def _publish_attack(self, ack: AttackAck, phase: Literal["started", "ended"]) -> None:
        """Enqueue a contract attack lifecycle message."""
        self._publish({"type": "attack", "attack": ack.model_dump(mode="json"), "phase": phase})

    def _capture(self, request: StartRequest, startup: _Startup) -> None:
        """Read, persist, and deliver frames on a paced daemon thread."""
        source: FrameSource | None = None
        run: _Run | None = None
        try:
            source, label = open_source(request)
            session = Session(
                session_id=str(uuid4()),
                status="running",
                source=source.kind,
                source_label=label,
                fps=request.fps,
                width=request.width,
                height=request.height,
                checkpoint_interval=request.checkpoint_interval,
                started_at=utc_timestamp(),
                stopped_at=None,
                device_id=self.device.device_id,
                seal=None,
            )
            session_id = session.session_id
            assert session_id is not None
            started = time.monotonic()
            incidents: list[Incident] = []
            channel = Channel(jpeg_quality=request.jpeg_quality, attack_ids=self._attack_ids)
            verifier = Verifier(session_id, self._pk_raw, request.checkpoint_interval, request.fps,
                                on_incident=incidents.append)
            verifier.incident_manager.attack_context = channel.attacks.incident_context
            run = _Run(
                Vault(self._sessions_dir, session),
                Producer(session_id, self._sk, self._pk_raw, request.checkpoint_interval),
                channel,
                verifier,
                started,
                _Metrics(sample_time=started),
                incidents,
            )
            period = 1 / request.fps
            deadline = started
            encode_options = [cv2.IMWRITE_JPEG_QUALITY, request.jpeg_quality]
            while not self._stop_signal.is_set():
                try:
                    image = source.read()
                except cv2.error:
                    image = None
                if image is None:
                    self._tick(run)
                    fallback = "file" if source.kind == "webcam" else "synthetic"
                    logger.warning("%s stopped delivering frames. Trying %s.", source.label, fallback)
                    source.close()
                    source, label = open_source(request.model_copy(update={
                        "source": fallback, "file_path": None,
                    }))
                    session = session.model_copy(update={"source": source.kind, "source_label": label})
                    run.vault.save_session(session)
                    if startup.ready.is_set():
                        self._publish_session(run, session)
                else:
                    timestamp = time.time_ns()
                    ok, encoded = cv2.imencode(".jpg", image, encode_options)
                    if not ok:
                        raise RuntimeError("Could not encode the captured frame")
                    packet = run.producer.make_packet(encoded.tobytes(), timestamp)
                    run.vault.save_original(packet)
                    if not startup.ready.is_set():
                        self._publish_session(run, session)
                    self._forward(run, packet)
                    startup.ready.set()

                now = time.monotonic()
                self._maybe_publish_stats(run, now)
                deadline += period
                if deadline < now:
                    deadline += (int((now - deadline) / period) + 1) * period
                self._stop_signal.wait(max(0.0, deadline - now))
        except Exception as error:
            logger.exception("Capture failed")
            if not startup.ready.is_set():
                startup.error = error
        finally:
            try:
                if source is not None:
                    source.close()
            except cv2.error:
                logger.exception("Could not release the capture source")
            try:
                if run is not None and run is self._run:
                    self._finish(run)
            except Exception as error:
                self._seal_error = error
                logger.exception("Could not persist the session seal")
            finally:
                startup.ready.set()

    def _forward(self, run: _Run, packet: Packet) -> None:
        """Process each channel delivery and publish its corresponding updates."""
        with self._state:
            attacks = run.channel.attacks
            active = attacks.active
            delivered = run.channel.process(packet)
            metrics = run.metrics
            metrics.frames_produced += 1
            metrics.hash_ms += run.producer.hash_ms
            if packet.header.is_checkpoint:
                metrics.signed += 1
                metrics.sign_ms += run.producer.sign_ms
            for incoming in delivered:
                result = run.verifier.process(incoming)
                limit = max(SEEN_LIMIT, self._session.checkpoint_interval)
                metrics.apply(result, limit)
                self._publish_frame(run, incoming, result, packet)
            if not delivered:
                run.verifier.tick(time.monotonic())
                self._publish_incidents(run)
            if active is not None and attacks.active is None:
                self._publish_attack(active, "ended")

    def _publish_frame(self, run: _Run, packet: Packet, result: VerifyResult, original: Packet) -> None:
        """Store tampered bytes before publishing the frame and timeline updates."""
        header = packet.header
        if result.verdict == "tampered":
            payload = packet.payload
            if packet is original and "FRAME_INSERTED" in result.reasons:
                # The genuine packet arrived second. Keep the earlier fake as evidence.
                payload = run.pending.get(header.seq, payload)
            run.vault.save_received(header.seq, payload)
        for seq, status in result.status_updates:
            if status == "pending" and seq == header.seq:
                run.pending[seq] = packet.payload
            else:
                payload = run.pending.pop(seq, None)
                if status == "tampered":
                    if seq == header.seq and result.verdict != "tampered":
                        run.vault.save_received(seq, packet.payload)
                    elif seq != header.seq and payload is not None:
                        run.vault.save_received(seq, payload)
        self._publish({
            "type": "frame",
            "seq": header.seq,
            "ts_ns": header.ts_ns,
            "jpeg_b64": b64encode(packet.payload).decode("ascii"),
            "verdict": result.verdict,
            "reasons": result.reasons,
            "frame_hash": header.frame_hash,
            "computed_hash": result.computed_hash,
            "prev_hash": header.prev_hash,
            "chain_hash": header.chain_hash,
            "dhash": header.dhash,
            "is_checkpoint": header.is_checkpoint,
            "hash_ms": run.producer.hash_ms,
            "verify_ms": result.verify_ms,
        })
        if result.status_updates:
            self._publish({
                "type": "status",
                "updates": [{"seq": seq, "status": status} for seq, status in result.status_updates],
            })
        if result.seal is not None:
            self._publish({"type": "seal", **asdict(result.seal)})
        self._publish_incidents(run)

    def _tick(self, run: _Run) -> None:
        """Give the verifier a watchdog tick when capture returns no frame."""
        with self._state:
            run.verifier.tick(time.monotonic())
            self._publish_incidents(run)

    def _maybe_publish_stats(self, run: _Run, now: float) -> None:
        """Sample actual FPS and send stats about once a second."""
        with self._state:
            metrics = run.metrics
            elapsed = now - metrics.sample_time
            if elapsed < 1:
                return
            metrics.fps_actual = (metrics.frames_produced - metrics.sample_frames) / elapsed
            metrics.sample_frames = metrics.frames_produced
            metrics.sample_time = now
            if self._run is run:
                self._publish({"type": "stats", "stats": self._stats(now).model_dump(mode="json")})

    def _publish_session(self, run: _Run, session: Session) -> None:
        """Swap in the current session and enqueue its snapshot."""
        with self._state:
            self._run = run
            self._session = session
            self._publish({"type": "session", "session": session.model_dump(mode="json")})

    def _finish(self, run: _Run) -> None:
        """Seal the last persisted camera frame and publish the stopped session."""
        header = run.vault.last_header
        assert header is not None
        frame_count = header.seq + 1
        message = crypto.seal_message(
            header.session_id, header.seq, bytes.fromhex(header.chain_hash), frame_count
        )
        seal = Seal(
            last_seq=header.seq,
            chain_hash=header.chain_hash,
            frame_count=frame_count,
            signature=crypto.sign(self._sk, message).hex(),
        )
        stopped = self.session().model_copy(update={
            "status": "stopped",
            "stopped_at": utc_timestamp(),
            "seal": seal,
        })
        try:
            run.vault.save_seal(seal)
            run.vault.save_session(stopped)
        except OSError:
            stopped = stopped.model_copy(update={"seal": None})
            raise
        finally:
            with self._state:
                run.stopped = time.monotonic()
                run.pending.clear()
                attack = run.channel.attacks.cancel()
                if attack is not None:
                    self._publish_attack(attack, "ended")
            self._publish_session(run, stopped)
