"""Exercise camera evidence export, offline verification, and the CLI."""

import subprocess
import sys
from hashlib import sha256
from io import BytesIO
from pathlib import Path
from time import monotonic, sleep
from zipfile import ZipFile

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import package_verifier
from app.main import create_app
from app.models import ExportResult, VerificationReport
from app.package_verifier import frame_name


def _download(client: TestClient, export: ExportResult) -> bytes:
    """Fetch an exported ZIP and confirm its content matches the advertised digest."""
    response = client.get(export.download_url)
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/zip"
    assert len(response.content) == export.size_bytes
    assert sha256(response.content).hexdigest() == export.package_sha256
    return response.content


def _verify(client: TestClient, data: bytes, name: str = "evidence.zip") -> VerificationReport:
    """Verify via the multipart endpoint and check that the report can be fetched."""
    response = client.post("/api/evidence/verify", files={"file": (name, data, "application/zip")})
    assert response.status_code == 200, response.text
    report = VerificationReport.model_validate(response.json())
    assert report.package_filename == name
    assert report.package_sha256 == sha256(data).hexdigest()
    assert client.get(f"/api/reports/{report.report_id}").json() == response.json()
    return report


def _remove_member(data: bytes, filename: str) -> bytes:
    """Make a ZIP with one member omitted and all other bytes copied."""
    output = BytesIO()
    with ZipFile(BytesIO(data)) as source, ZipFile(output, "w") as destination:
        for name in source.namelist():
            if name != filename:
                destination.writestr(name, source.read(name))
    return output.getvalue()


def test_evidence_workflow(tmp_path: Path) -> None:
    """Record six seconds and check the export, live diff, and all sample verdicts."""
    with TestClient(create_app(tmp_path)) as client:
        assert client.post("/api/evidence/export").status_code == 409
        assert client.post("/api/evidence/tamper-sample", json={"mode": "delete"}).status_code == 409
        response = client.post("/api/session/start", json={"source": "synthetic", "width": 320, "height": 240})
        assert response.status_code == 200
        started = monotonic()
        session = response.json()

        snapshot = ExportResult.model_validate(client.post("/api/evidence/export").json())
        snapshot_data = _download(client, snapshot)
        assert _verify(client, snapshot_data, snapshot.filename).verdict == "INCOMPLETE"
        with ZipFile(BytesIO(snapshot_data)) as archive:
            assert "seal.json" not in archive.namelist()
            assert len(archive.read("ledger.jsonl").splitlines()) == snapshot.frame_count
            assert sum(name.startswith("frames/") for name in archive.namelist()) == snapshot.frame_count
        assert client.get("/api/session").json()["status"] == "running"

        with client.websocket_connect("/ws/live") as socket:
            assert socket.receive_json()["type"] == "hello"
            response = client.post("/api/attacks", json={"type": "PIXEL_TAMPER", "params": {"frames": 1}})
            assert response.status_code == 200
            for _ in range(40):
                message = socket.receive_json()
                if message["type"] == "incident":
                    incident = message["incident"]
                    assert incident["kind"] == "FRAME_MODIFIED"
                    seq = incident["evidence"]["sample_seq"]
                    break
            else:
                pytest.fail("No incident for the live pixel tamper")

            diff = client.get(f"/api/frames/{seq}/diff.png")
            assert diff.status_code == 200
            assert diff.headers["content-type"] == "image/png"
            blended = cv2.imdecode(np.frombuffer(diff.content, np.uint8), cv2.IMREAD_COLOR)
            assert blended.shape == (240, 320, 3)
            original = _download_jpeg(client, seq, "original")
            received = _download_jpeg(client, seq, "received")
            gray = cv2.cvtColor(cv2.absdiff(original, received), cv2.COLOR_BGR2GRAY)
            amplified = np.minimum(gray.astype(np.uint16) * 4, 255).astype(np.uint8)
            jet = cv2.applyColorMap(amplified, cv2.COLORMAP_JET)
            assert np.array_equal(blended, cv2.addWeighted(original, 0.5, jet, 0.5, 0))

        sleep(max(0, 6 - (monotonic() - started)))
        stopped = client.post("/api/session/stop").json()
        export = ExportResult.model_validate(client.post("/api/evidence/export").json())
        assert export.filename == f"frameseal_{session['session_id']}.zip"
        data = _download(client, export)
        count = stopped["seal"]["frame_count"]
        assert export.frame_count == count > 30
        report = _verify(client, data, export.filename)
        assert report.verdict == "AUTHENTIC"
        assert report.seal_valid and report.chain_head == stopped["seal"]["chain_hash"]
        assert report.frames_total == report.frames_ok == count
        assert report.checkpoints_total == report.checkpoints_valid == count // session["checkpoint_interval"]
        assert report.incidents == []
        with ZipFile(BytesIO(data)) as archive:
            assert set(archive.namelist()) == {
                "session.json", "README.txt", "ledger.jsonl", "seal.json",
                *(frame_name(seq) for seq in range(count)),
            }
            seal = archive.read("seal.json")
            lines = archive.read("ledger.jsonl").splitlines()

        for mode, expected in (("modify", "TAMPERED"), ("delete", "TAMPERED"), ("truncate", "INCOMPLETE")):
            sample = ExportResult.model_validate(
                client.post("/api/evidence/tamper-sample", json={"mode": mode}).json()
            )
            sample_data = _download(client, sample)
            result = _verify(client, sample_data, sample.filename)
            assert result.verdict == expected
            with ZipFile(BytesIO(sample_data)) as archive:
                assert archive.read("seal.json") == seal
                sample_lines = archive.read("ledger.jsonl").splitlines()
                if mode == "modify":
                    [incident] = result.incidents
                    seq = count * 2 // 5
                    assert incident.kind == "FRAME_MODIFIED"
                    assert incident.seq_from == incident.seq_to == incident.evidence.sample_seq == seq
                    assert result.frames_tampered == 1 and result.frames_missing == 0
                    assert result.seal_valid and sample_lines == lines
                elif mode == "delete":
                    [incident] = result.incidents
                    first = count // 2
                    assert incident.kind == "FRAME_DELETED"
                    assert (incident.seq_from, incident.seq_to) == (first, first + 9)
                    assert result.frames_missing == 10 and result.frames_tampered == 0
                    assert sample_lines == lines[:first] + lines[first + 10:]
                    assert all(frame_name(seq) not in archive.NameToInfo for seq in range(first, first + 10))
                else:
                    assert result.frames_total == count - 30
                    assert not result.seal_valid and not result.incidents
                    assert result.frames_missing == 0 and sample_lines == lines[:-30]
                    assert all(frame_name(seq) not in archive.NameToInfo for seq in range(count - 30, count))
            _check_cli(tmp_path / "exports" / sample.filename, expected, {"modify": 1, "delete": 1, "truncate": 2}[mode])

        assert _download(client, export) == data
        _check_cli(tmp_path / "exports" / export.filename, "AUTHENTIC", 0)
        no_tail_image = _verify(client, _remove_member(data, frame_name(count - 1)))
        assert no_tail_image.verdict == "TAMPERED"
        assert no_tail_image.frames_missing == 1
        assert no_tail_image.incidents[0].seq_from == count - 1
        assert no_tail_image.incidents[0].kind == "FRAME_DELETED"
        assert _verify(client, _remove_member(data, "seal.json")).verdict == "INCOMPLETE"


def _download_jpeg(client: TestClient, seq: int, copy: str) -> np.ndarray:
    """Decode a JPEG from one of the frame endpoints."""
    response = client.get(f"/api/frames/{seq}/{copy}.jpg")
    assert response.status_code == 200
    return cv2.imdecode(np.frombuffer(response.content, np.uint8), cv2.IMREAD_COLOR)


def _check_cli(package: Path, verdict: str, exit_code: int) -> None:
    """Run the standalone CLI entry point against the same archive."""
    script = Path(__file__).resolve().parents[1] / "tools" / "verify_package.py"
    run = subprocess.run([sys.executable, str(script), str(package)], capture_output=True, text=True, timeout=15)
    assert run.returncode == exit_code, run.stdout + run.stderr
    assert verdict in run.stdout
    assert "first bad frames=" in run.stdout


@pytest.mark.parametrize("name", ["../x", "/x", "C:/x", r"frames\..\x"])
def test_reject_unsafe_zip_paths(tmp_path: Path, name: str) -> None:
    """Reject unsafe paths before opening any ZIP members."""
    data = BytesIO()
    with ZipFile(data, "w") as archive:
        archive.writestr(name, b"hello")
    with TestClient(create_app(tmp_path)) as client:
        response = client.post("/api/evidence/verify", files={"file": ("unsafe.zip", data.getvalue())})
        assert response.status_code == 400
        assert "Unsafe ZIP member path" in response.json()["detail"]


def test_reject_invalid_or_oversized_archive(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Check upload errors and the combined uncompressed-size limit."""
    monkeypatch.setattr(package_verifier, "MAX_UNCOMPRESSED_BYTES", 5)
    data = BytesIO()
    with ZipFile(data, "w") as archive:
        archive.writestr("one", b"123")
        archive.writestr("two", b"456")
    with TestClient(create_app(tmp_path)) as client:
        for contents, error in ((b"bad zip", "Could not read evidence ZIP"), (data.getvalue(), "size limit")):
            response = client.post("/api/evidence/verify", files={"file": ("invalid.zip", contents)})
            assert response.status_code == 400
            assert error in response.json()["detail"]
