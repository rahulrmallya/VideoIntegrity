"""Check capture limits, retention, and demo routing."""

import asyncio
import time
from os import utime
from pathlib import Path
from unittest.mock import Mock
from uuid import uuid4

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import pipeline
from app.broadcaster import HANDOFF_SIZE, Broadcaster
from app.main import create_app


def test_camera_disconnect_switches_to_synthetic(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture,
) -> None:
    """Keep the same signed session alive when the camera reader fails."""
    class DisconnectingCamera:
        """Deliver one frame and then simulate an I/O error."""

        kind = "webcam"
        label = "Test camera"
        first = True
        closed = False

        def read(self) -> np.ndarray:
            """Simulate a camera disconnect immediately after its first frame."""
            if not self.first:
                raise OSError("camera unplugged")
            self.first = False
            return np.zeros((60, 80, 3), dtype=np.uint8)

        def close(self) -> None:
            """Record camera release."""
            self.closed = True

    camera = DisconnectingCamera()
    original_open = pipeline.open_source

    def open_source(request: pipeline.StartRequest) -> tuple[pipeline.FrameSource, str]:
        """Intercept the camera open and use the real synthetic fallback."""
        if request.source == "webcam":
            return camera, camera.label
        assert request.source == "synthetic"
        return original_open(request)

    monkeypatch.setattr(pipeline, "open_source", open_source)
    with TestClient(create_app(tmp_path)) as client:
        started = client.post("/api/session/start", json={"source": "webcam", "width": 80, "height": 60}).json()
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            session = client.get("/api/session").json()
            if session["source"] == "synthetic" and client.get("/api/stats").json()["frames_produced"] >= 2:
                break
            time.sleep(0.02)
        else:
            pytest.fail("Capture did not recover on the synthetic source")
        assert session["status"] == "running" and session["session_id"] == started["session_id"]
        stopped = client.post("/api/session/stop").json()
        assert stopped["seal"]["frame_count"] >= 2
    assert camera.closed
    assert "Switching to synthetic" in caplog.text


@pytest.mark.parametrize(
    ("setting", "limit", "fps", "expected_frames"),
    [("SESSION_MAX_FRAMES", 3, 30, 3), ("SESSION_MAX_SECONDS", 0.3, 1, 1)],
)
def test_auto_stop_seals_at_both_limits(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, setting: str,
    limit: int | float, fps: int, expected_frames: int,
) -> None:
    """Seal on either cap without waiting an extra low-FPS interval."""
    monkeypatch.setattr(pipeline, setting, limit)
    with TestClient(create_app(tmp_path)) as client:
        response = client.post("/api/session/start", json={"source": "synthetic", "fps": fps})
        identity = response.json()["session_id"]
        capture = client.app.state.pipeline._thread
        assert capture is not None and capture.daemon
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            session = client.get("/api/session").json()
            if session["status"] == "stopped":
                break
            time.sleep(0.02)
        else:
            pytest.fail("Capture did not stop at its limit")
        assert session["seal"]["frame_count"] == expected_frames
        assert (tmp_path / "sessions" / identity / "seal.json").is_file()
        assert client.post("/api/session/stop").json() == session
        assert not capture.is_alive()


def test_startup_retains_ten_newest_recordings(tmp_path: Path) -> None:
    """Prune older UUID4 session directories while preserving unrelated files."""
    root = tmp_path / "sessions"
    folders = [root / str(uuid4()) for _ in range(12)]
    for index, folder in enumerate(folders):
        folder.mkdir(parents=True)
        (folder / "ledger.jsonl").write_text("", encoding="utf-8")
        timestamp = (1_700_000_000 + index) * 10**9
        utime(folder, ns=(timestamp, timestamp))
    unrelated = root / "keep-me"
    unrelated.mkdir()
    with TestClient(create_app(tmp_path)):
        assert set(root.iterdir()) == {*folders[-10:], unrelated}


def test_demo_serves_spa_assets_api_and_socket(tmp_path: Path) -> None:
    """Route the frontend, REST, and WebSocket through the same ASGI app."""
    frontend = tmp_path / "dist"
    assets = frontend / "assets"
    assets.mkdir(parents=True)
    index = "<!DOCTYPE html><title>FrameSeal</title>"
    (frontend / "index.html").write_text(index, encoding="utf-8")
    (assets / "app.js").write_text("export {};", encoding="utf-8")
    with TestClient(create_app(tmp_path, frontend_dir=frontend)) as client:
        assert client.get("/").text == index
        assert client.get("/evidence/history").text == index
        assert client.head("/evidence/history").status_code == 200
        assert client.get("/assets/app.js").text == "export {};"
        assert client.get("/assets/missing.js").status_code == 404
        assert client.get("/api/missing").status_code == 404
        assert client.get("/api/health").json()["status"] == "ok"
        with client.websocket_connect("/ws/live") as websocket:
            assert websocket.receive_json()["type"] == "hello"


def test_capture_handoff_stays_bounded_when_loop_is_delayed() -> None:
    """Schedule one drain and keep control messages when frames overflow."""
    loop = Mock(spec=asyncio.AbstractEventLoop)
    broadcaster = Broadcaster()
    client = broadcaster.register()
    broadcaster.submit(loop, {"type": "session"})
    for seq in range(HANDOFF_SIZE * 2):
        broadcaster.submit(loop, {"type": "frame", "seq": seq})
    assert broadcaster.queue_sizes() == (HANDOFF_SIZE, [0])
    loop.call_soon_threadsafe.assert_called_once()
    drain = loop.call_soon_threadsafe.call_args.args[0]
    drain()
    assert broadcaster.queue_sizes() == (0, [60])
    assert client.get_nowait() == {"type": "session"}
