"""Exercise every demo attack against a signed synthetic stream."""

from dataclasses import dataclass
from pathlib import Path

import cv2
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi.testclient import TestClient

from app import sources
from app.channel import CATALOG, Channel
from app.main import create_app
from app.models import AttackType, Incident, IncidentKind
from app.producer import Packet, Producer
from app.sources import SyntheticSource
from app.verifier import TimelineStatus, Verifier

FPS = 15
SESSION_ID = "00000000-0000-4000-8000-000000000000"
EPOCH_NS = 1_700_000_000_000_000_000


@dataclass
class FakeClock:
    """Advance monotonic time one producer tick at a time."""

    now: float = 0.0

    def __call__(self) -> float:
        """Return the current simulated time."""
        return self.now


def make_packet(producer: Producer, source: SyntheticSource, now: float) -> Packet:
    """Produce a signed-stream packet from a synthetic image."""
    ok, encoded = cv2.imencode(".jpg", source.read(), [cv2.IMWRITE_JPEG_QUALITY, 80])
    assert ok
    return producer.make_packet(encoded.tobytes(), EPOCH_NS + round(now * 1e9))


@pytest.mark.parametrize(
    ("kind", "expected_kind", "max_latency_ms"),
    [
        ("PIXEL_TAMPER", "FRAME_MODIFIED", 100),
        ("FRAME_DROP", "FRAME_DELETED", None),
        ("FRAME_INSERT", "FRAME_INSERTED", 100),
        ("FRAME_REORDER", "FRAME_REORDERED", 100),
        ("LOOP_REPLAY", "REPLAY_DETECTED", 100),
        ("CHAIN_FORGE", "CHAIN_FORGED", 1100),
        ("STREAM_CUT", "STREAM_INTERRUPTED", None),
    ],
)
def test_attack_and_recovery(
    kind: AttackType,
    expected_kind: IncidentKind,
    max_latency_ms: int | None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Run 12 simulated seconds and verify classification, latency, and recovery."""
    clock = FakeClock()
    monkeypatch.setattr(sources, "monotonic", clock)
    key = Ed25519PrivateKey.generate()
    public_key = key.public_key().public_bytes_raw()
    source = SyntheticSource(320, 240)
    producer = Producer(SESSION_ID, key, public_key, FPS)
    channel = Channel(clock=clock)
    events: list[tuple[float, Incident]] = []

    def on_incident(incident: Incident) -> None:
        """Capture the simulated time of each incident snapshot."""
        events.append((clock.now, incident))

    verifier = Verifier(SESSION_ID, public_key, FPS, FPS, clock, on_incident=on_incident)
    verifier.incident_manager.attack_context = channel.attacks.incident_context
    statuses: dict[int, TimelineStatus] = {}
    attack_end = None
    ack = None
    for seq in range(12 * FPS):
        clock.now = seq / FPS
        if seq == 3 * FPS:
            ack = channel.attacks.start(kind, {})
            assert ack.attack_id == "atk_0001"
            assert ack.expected_kind == expected_kind
            assert channel.attacks.incident_context() is None
        packet = make_packet(producer, source, clock.now)
        was_active = channel.attacks.active is not None
        for incoming in channel.process(packet):
            result = verifier.process(incoming)
            statuses.update(result.status_updates)
        verifier.tick(clock.now)
        if was_active and channel.attacks.active is None:
            attack_end = clock.now

    assert ack is not None
    assert attack_end is not None
    assert verifier.incident_manager.total == 1
    [incident] = verifier.incidents
    assert incident.kind == expected_kind
    assert incident.attack_id == ack.attack_id
    assert incident.attack_type == kind
    assert incident.status == "closed"
    assert incident.closed_at is not None
    assert events[0][1].status == "open"
    assert events[0][1].detection_latency_ms == incident.detection_latency_ms
    assert events[-1][1] == incident
    assert events[-1][0] - attack_end <= 2 + 1 / FPS
    latency = incident.detection_latency_ms
    assert latency is not None
    assert latency == pytest.approx((events[0][0] - 3) * 1000, abs=0.001)
    if max_latency_ms is not None:
        assert latency <= max_latency_ms
    assert all(statuses[seq] == "sealed" for seq in range(11 * FPS, 12 * FPS))


def test_insert_at_checkpoint() -> None:
    """Insert an unsigned fake even though the genuine sequence has a signature."""
    clock = FakeClock()
    key = Ed25519PrivateKey.generate()
    public_key = key.public_key().public_bytes_raw()
    source = SyntheticSource(320, 240)
    producer = Producer(SESSION_ID, key, public_key, 2)
    channel = Channel(clock=clock)
    verifier = Verifier(SESSION_ID, public_key, 2, FPS, clock)
    [previous] = channel.process(make_packet(producer, source, clock.now))
    verifier.process(previous)
    channel.attacks.start("FRAME_INSERT", {})
    checkpoint = make_packet(producer, source, clock.now)
    fake, genuine = channel.process(checkpoint)

    assert not fake.header.is_checkpoint
    assert fake.header.signature is None
    assert fake.header.prev_hash == previous.header.chain_hash
    assert fake.payload != genuine.payload
    assert genuine == checkpoint and genuine.header.signature is not None
    assert verifier.process(fake).reasons == []
    assert verifier.process(genuine).reasons == ["FRAME_INSERTED"]
    assert verifier.incidents[0].kind == "FRAME_INSERTED"


def test_replay_warmup_and_long_override() -> None:
    """Wait for 45 forwarded packets, then cycle that snapshot for a 90-frame replay."""
    clock = FakeClock()
    key = Ed25519PrivateKey.generate()
    source = SyntheticSource(160, 120)
    producer = Producer(SESSION_ID, key, key.public_key().public_bytes_raw(), FPS)
    channel = Channel(clock=clock)
    channel.attacks.start("LOOP_REPLAY", {"frames": 90})
    originals = []
    for seq in range(45):
        clock.now = seq / FPS
        packet = make_packet(producer, source, clock.now)
        originals.append(packet)
        assert channel.process(packet) == [packet]
        assert channel.attacks.incident_context() is None
    for index, expected in enumerate(originals * 2):
        clock.now = (45 + index) / FPS
        packet = make_packet(producer, source, clock.now)
        assert channel.process(packet) == [expected]
        context = channel.attacks.incident_context()
        assert context is not None
        assert context[1] == pytest.approx(index / FPS * 1000, abs=0.001)
    assert channel.attacks.active is None


def test_stream_cut_waits_for_first_delivery() -> None:
    """Arm the verifier with the original frame before dropping any packets."""
    clock = FakeClock()
    key = Ed25519PrivateKey.generate()
    source = SyntheticSource(160, 120)
    producer = Producer(SESSION_ID, key, key.public_key().public_bytes_raw(), FPS)
    channel = Channel(clock=clock)
    channel.attacks.start("STREAM_CUT", {"seconds": 2.5})
    first = make_packet(producer, source, clock.now)
    assert channel.process(first) == [first]
    assert channel.attacks.incident_context() is None
    clock.now = 1
    assert channel.process(make_packet(producer, source, clock.now)) == []
    clock.now = 3.499
    assert channel.process(make_packet(producer, source, clock.now)) == []
    clock.now = 3.5
    resumed = make_packet(producer, source, clock.now)
    assert channel.process(resumed) == [resumed]
    assert channel.attacks.active is None


def test_attack_routes_and_websocket_phases(tmp_path: Path) -> None:
    """Validate attack payloads and broadcast the same acknowledgment on both phases."""
    with TestClient(create_app(tmp_path)) as client:
        catalog = client.get("/api/attacks/catalog").json()
        assert catalog == [info.model_dump() for info in CATALOG]
        assert len(catalog) == 7
        assert client.post("/api/attacks", json={"type": "FRAME_DROP"}).status_code == 409
        assert client.post("/api/session/start", json={"source": "synthetic", "fps": 5}).is_success
        invalid = [
            ("PIXEL_TAMPER", {"frames": 0}),
            ("PIXEL_TAMPER", {"frames": 1.0}),
            ("FRAME_DROP", {"count": True}),
            ("FRAME_DROP", {"count": 61}),
            ("FRAME_INSERT", {"frames": 1}),
            ("FRAME_REORDER", {"count": 2}),
            ("LOOP_REPLAY", {"frames": 91}),
            ("CHAIN_FORGE", {"min_frames": "5"}),
            ("STREAM_CUT", {"seconds": 2}),
            ("STREAM_CUT", {"second": 4}),
            ("UNKNOWN", {}),
        ]
        for kind, params in invalid:
            response = client.post("/api/attacks", json={"type": kind, "params": params})
            assert response.status_code == 422
            assert isinstance(response.json()["detail"], str)

        with client.websocket_connect("/ws/live") as ws:
            assert ws.receive_json()["catalog"] == catalog
            response = client.post("/api/attacks", json={"type": "LOOP_REPLAY", "params": {"frames": 15}})
            assert response.status_code == 200
            ack = response.json()
            assert ack["attack_id"] == "atk_0001"
            assert client.post("/api/attacks", json={"type": "STREAM_CUT"}).status_code == 409
            assert client.post("/api/session/stop").is_success
            phases = []
            for _ in range(40):
                message = ws.receive_json()
                if message["type"] == "attack":
                    assert message["attack"] == ack
                    phases.append(message["phase"])
                if message["type"] == "session":
                    break
            assert phases == ["started", "ended"]
        assert client.post("/api/attacks", json={"type": "FRAME_DROP"}).status_code == 409


def test_insert_stores_linked_incident_and_fake_jpeg(tmp_path: Path) -> None:
    """Expose the persisted attribution and the inserted bytes through the API."""
    with TestClient(create_app(tmp_path)) as client:
        assert client.post("/api/session/start", json={"source": "synthetic"}).is_success
        with client.websocket_connect("/ws/live") as ws:
            assert ws.receive_json()["type"] == "hello"
            response = client.post("/api/attacks", json={"type": "FRAME_INSERT"})
            assert response.status_code == 200
            ack = response.json()
            for _ in range(40):
                message = ws.receive_json()
                if message["type"] == "incident":
                    incident = message["incident"]
                    break
            else:
                pytest.fail("No incident event for the inserted frame")
        assert incident["attack_id"] == ack["attack_id"]
        assert incident["kind"] == "FRAME_INSERTED"
        assert incident["detection_latency_ms"] is not None
        latest = client.get("/api/incidents").json()[0]
        assert latest["attack_id"] == incident["attack_id"]
        assert latest["detection_latency_ms"] == incident["detection_latency_ms"]
        assert client.get("/api/stats").json()["last_detection_latency_ms"] == incident["detection_latency_ms"]
        seq = incident["evidence"]["sample_seq"]
        fake = client.get(f"/api/frames/{seq}/received.jpg")
        genuine = client.get(f"/api/frames/{seq}/original.jpg")
        assert fake.is_success and genuine.is_success
        assert fake.content != genuine.content
