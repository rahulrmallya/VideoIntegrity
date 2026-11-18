"""Exercise the live pipeline through the REST API and WebSocket."""

from base64 import b64decode
from dataclasses import replace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import crypto
from app.broadcaster import Broadcaster, QUEUE_SIZE
from app.channel import Channel
from app.main import create_app
from app.models import ChainRecord, Seal, Session
from app.producer import Packet


def test_live_capture_delivers_signed_frames_and_final_seal(tmp_path: Path) -> None:
    """Start synthetic capture, receive live messages, and verify the final seal."""
    with TestClient(create_app(tmp_path)) as client:
        assert client.get("/api/session").json()["status"] == "idle"
        response = client.post("/api/session/start", json={"source": "synthetic"})
        assert response.status_code == 200
        running = Session.model_validate(response.json())
        assert running.status == "running"
        assert running.source == "synthetic"
        assert running.source_label == "Synthetic camera"
        assert running.session_id is not None

        with client.websocket_connect("/ws/live") as websocket:
            hello = websocket.receive_json()
            assert hello["type"] == "hello"
            assert Session.model_validate(hello["session"]) == running
            pk_raw = bytes.fromhex(hello["device"]["public_key_hex"])

            frames = seals = stats = 0
            sample = None
            for _ in range(200):
                message = websocket.receive_json()
                assert "payload" not in message
                kind = message["type"]
                if kind == "frame":
                    assert message["verdict"] == "ok"
                    assert message["reasons"] == []
                    assert message["frame_hash"] == message["computed_hash"]
                    frames += 1
                    if sample is None:
                        sample = message
                elif kind == "seal":
                    assert message["valid"]
                    assert crypto.verify(
                        pk_raw,
                        bytes.fromhex(message["signature"]),
                        crypto.checkpoint_message(
                            running.session_id, message["seq"], bytes.fromhex(message["chain_hash"])
                        ),
                    )
                    seals += 1
                elif kind == "stats":
                    assert message["stats"]["integrity"] == "SECURE"
                    assert message["stats"]["checkpoints_failed"] == 0
                    stats += 1
                else:
                    assert kind == "status"
                if frames >= 20 and seals and stats:
                    break
            assert frames >= 20 and seals >= 1 and stats >= 1
            assert sample is not None
            seq = sample["seq"]
            saved = client.get(f"/api/frames/{seq}/original.jpg")
            assert saved.status_code == 200
            assert saved.headers["content-type"] == "image/jpeg"
            assert saved.content == b64decode(sample["jpeg_b64"])
            assert client.get(f"/api/frames/{seq}/received.jpg").status_code == 404
            assert client.get("/api/incidents").json() == []
            assert client.get("/api/stats").json()["frames_delivered"] >= frames

            stopped_response = client.post("/api/session/stop")
            assert stopped_response.status_code == 200
            stopped = Session.model_validate(stopped_response.json())
            assert stopped.status == "stopped"
            for _ in range(200):
                message = websocket.receive_json()
                if message["type"] == "session":
                    assert Session.model_validate(message["session"]) == stopped
                    break
            else:
                pytest.fail("No stopped session message")

        assert stopped.seal is not None and stopped.seal.signature is not None
        assert stopped.seal.frame_count == stopped.seal.last_seq + 1
        assert crypto.verify(
            pk_raw,
            bytes.fromhex(stopped.seal.signature),
            crypto.seal_message(
                running.session_id, stopped.seal.last_seq,
                bytes.fromhex(stopped.seal.chain_hash), stopped.seal.frame_count,
            ),
        )
        assert client.get("/api/session").json() == stopped_response.json()
        assert client.post("/api/session/stop").json() == stopped_response.json()
        recent = client.get("/api/chain", params={"limit": 2}).json()
        assert [record["seq"] for record in recent] == [
            stopped.seal.last_seq, stopped.seal.last_seq - 1
        ]
        assert recent[0]["chain_hash"] == stopped.seal.chain_hash

    folder = tmp_path / "sessions" / running.session_id
    assert Session.model_validate_json((folder / "session.json").read_bytes()) == stopped
    assert Seal.model_validate_json((folder / "seal.json").read_bytes()) == stopped.seal
    ledger = [ChainRecord.model_validate_json(line) for line in (folder / "ledger.jsonl").read_bytes().splitlines()]
    assert len(ledger) == stopped.seal.frame_count
    assert [record.seq for record in ledger] == list(range(stopped.seal.frame_count))
    assert (folder / "frames" / f"{seq:08d}.jpg").read_bytes() == saved.content
    assert list((folder / "received").iterdir()) == []


def test_start_replaces_running_session_and_falls_back(tmp_path: Path) -> None:
    """Seal a running session before switching to a missing file's fallback."""
    with TestClient(create_app(tmp_path)) as client:
        first = client.post("/api/session/start", json={"source": "synthetic"})
        assert first.status_code == 200
        first_id = first.json()["session_id"]

        second = client.post(
            "/api/session/start",
            json={"source": "file", "file_path": str(tmp_path / "missing.mp4")},
        )
        assert second.status_code == 200
        assert second.json()["session_id"] != first_id
        assert second.json()["source"] == "synthetic"
        assert (tmp_path / "sessions" / first_id / "seal.json").is_file()

        assert client.post("/api/session/start", json={"source": "synthetic", "fps": 0}).status_code == 422
        assert client.get("/api/frames/0/diff.png").status_code == 501
        assert client.post("/api/evidence/verify").status_code == 501
        assert client.get("/api/reports/unused").status_code == 501
        assert client.get("/api/frames/999999/original.jpg").status_code == 404
        assert client.post("/api/incidents/unknown/ack").status_code == 404

    assert (tmp_path / "sessions" / second.json()["session_id"] / "seal.json").is_file()


def test_tampered_delivery_is_stored_and_can_be_acknowledged(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Exercise the received-frame and acknowledgment routes with a test packet."""
    modified = b"test payload"

    def test_delivery(self: Channel, packet: Packet) -> list[Packet]:
        """Replace only the first packet's bytes for this test."""
        return [replace(packet, payload=modified) if packet.header.seq == 0 else packet]

    monkeypatch.setattr(Channel, "process", test_delivery)
    with TestClient(create_app(tmp_path)) as client:
        with client.websocket_connect("/ws/live") as websocket:
            assert websocket.receive_json()["type"] == "hello"
            assert client.post("/api/session/start", json={"source": "synthetic"}).status_code == 200
            [incident] = client.get("/api/incidents").json()
            assert incident["kind"] == "FRAME_MODIFIED"
            assert client.get("/api/frames/0/received.jpg").content == modified

            response = client.post(f"/api/incidents/{incident['id']}/ack")
            assert response.status_code == 200
            assert response.json()["acknowledged"] is True
            for _ in range(20):
                message = websocket.receive_json()
                if message["type"] == "incident" and message["incident"]["acknowledged"]:
                    assert message["incident"]["id"] == incident["id"]
                    break
            else:
                pytest.fail("No acknowledged incident event")


def test_broadcaster_drops_oldest_frame_before_control_messages() -> None:
    """Keep a slow client's queue bounded and preserve queued control messages."""
    broadcaster = Broadcaster()
    queue = broadcaster.register()
    broadcaster.publish({"type": "session"})
    for seq in range(QUEUE_SIZE):
        broadcaster.publish({"type": "frame", "seq": seq})
    assert queue.qsize() == QUEUE_SIZE
    assert queue.get_nowait() == {"type": "session"}
    assert queue.get_nowait() == {"type": "frame", "seq": 1}
    broadcaster.unregister(queue)
