"""Smoke tests for the FrameSeal backend."""

from pathlib import Path

from fastapi.testclient import TestClient

from app import crypto
from app.main import create_app
from app.models import Device, Session


def test_health(tmp_path: Path) -> None:
    """Return the contract version and allow the frontend origin."""
    with TestClient(create_app(tmp_path)) as client:
        response = client.get(
            "/api/health", headers={"Origin": "http://localhost:5173"}
        )

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "version": "1.0"}
    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"


def test_live_hello(tmp_path: Path) -> None:
    """Send the idle state and persistent device identity on connection."""
    with TestClient(create_app(tmp_path)) as client:
        expected_catalog = client.get("/api/attacks/catalog").json()
        expected_device = client.get("/api/device").json()
        with client.websocket_connect("/ws/live") as websocket:
            hello = websocket.receive_json()

    assert hello.keys() == {"type", "session", "device", "catalog"}
    assert hello["type"] == "hello"
    assert len(expected_catalog) == 7
    assert hello["catalog"] == expected_catalog
    assert hello["device"] == expected_device

    session = Session.model_validate(hello["session"])
    device = Device.model_validate(hello["device"])
    assert session.status == "idle"
    assert session.session_id is None
    assert session.source is None
    assert session.device_id == device.device_id
    assert device.algorithm == "Ed25519"
    assert device.device_id == crypto.device_id(bytes.fromhex(device.public_key_hex))
    assert (tmp_path / "keys" / "device_ed25519.pem").is_file()
