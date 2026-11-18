"""Smoke tests for the FrameSeal backend scaffold."""

from fastapi.testclient import TestClient

from app.main import app
from app.models import Device, Session


def test_health() -> None:
    """Return the contract version and allow the frontend origin."""
    with TestClient(app) as client:
        response = client.get(
            "/api/health", headers={"Origin": "http://localhost:5173"}
        )

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "version": "1.0"}
    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"


def test_live_hello() -> None:
    """Send an idle session and placeholder device on connection."""
    with TestClient(app) as client:
        with client.websocket_connect("/ws/live") as websocket:
            hello = websocket.receive_json()

    assert hello.keys() == {"type", "session", "device", "catalog"}
    assert hello["type"] == "hello"
    assert hello["catalog"] == []

    session = Session.model_validate(hello["session"])
    device = Device.model_validate(hello["device"])
    assert session.status == "idle"
    assert session.session_id is None
    assert session.source is None
    assert session.device_id == device.device_id
    assert device.algorithm == "Ed25519"
