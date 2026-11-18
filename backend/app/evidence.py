"""Evidence package export and verification."""

import re
from collections import OrderedDict
from collections.abc import Iterator
from contextlib import contextmanager
from hashlib import file_digest
from pathlib import Path
from shutil import copyfileobj
from tempfile import NamedTemporaryFile
from threading import Lock
from typing import BinaryIO
from zipfile import ZIP_DEFLATED, ZipFile

import cv2
import numpy as np

from app.models import Device, ExportResult, TamperMode, VerificationReport
from app.package_verifier import PackageMetadata, frame_name, verify_package
from app.vault import CaptureSnapshot

_BASE_NAME = r"frameseal_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"
_RECORDING_NAME = re.compile(_BASE_NAME + r"\.zip")
_DOWNLOAD_NAME = re.compile(_BASE_NAME + r"(?:_(?:modify|delete|truncate))?\.zip")
_REPORT_LIMIT = 128
_README = """FrameSeal evidence package

From the FrameSeal backend directory, run:
    python tools/verify_package.py path/to/package.zip

The verifier checks original camera JPEGs, the ledger, checkpoint signatures,
and the final seal against the device public key in session.json. Compare
the packaged device ID and public key with a trusted copy from the camera.
Running-session snapshots have no final seal.

Exit codes: 0 AUTHENTIC, 1 TAMPERED, 2 INCOMPLETE.
"""


class EvidenceConflict(RuntimeError):
    """The requested evidence operation has no suitable source recording."""


@contextmanager
def _temporary_zip(directory: Path) -> Iterator[Path]:
    """Reserve a temporary ZIP that can be atomically published on Windows."""
    with NamedTemporaryFile(dir=directory, suffix=".tmp", delete=False) as temporary:
        path = Path(temporary.name)
    try:
        yield path
    finally:
        path.unlink(missing_ok=True)


def _publish_export(
    temporary: Path, destination: Path, count: int, description: str | None = None,
) -> ExportResult:
    """Hash the completed archive and replace the published ZIP atomically."""
    with temporary.open("rb") as stream:
        digest = file_digest(stream, "sha256").hexdigest()
    size = temporary.stat().st_size
    temporary.replace(destination)
    return ExportResult(
        filename=destination.name,
        download_url=f"/api/evidence/download/{destination.name}",
        size_bytes=size,
        package_sha256=digest,
        frame_count=count,
        description=description,
    )


def _decode(payload: bytes) -> np.ndarray:
    """Decode stored JPEG bytes without depending on the OS path encoding."""
    try:
        image = cv2.imdecode(np.frombuffer(payload, dtype=np.uint8), cv2.IMREAD_COLOR)
    except cv2.error as error:
        raise ValueError("Could not decode JPEG") from error
    if image is None:
        raise ValueError("Could not decode JPEG")
    return image


def diff_png(original: Path, received: Path) -> bytes:
    """Overlay a 50 percent JET heatmap on the original frame."""
    original_bytes = original.read_bytes()
    received_bytes = received.read_bytes()
    before, after = _decode(original_bytes), _decode(received_bytes)
    if before.shape != after.shape:
        raise ValueError("Original and received frames have different dimensions")
    delta = cv2.cvtColor(cv2.absdiff(before, after), cv2.COLOR_BGR2GRAY)
    heatmap = cv2.applyColorMap(cv2.convertScaleAbs(delta, alpha=4), cv2.COLORMAP_JET)
    combined = cv2.addWeighted(before, 0.5, heatmap, 0.5, 0)
    ok, encoded = cv2.imencode(".png", combined)
    if not ok:
        raise RuntimeError("Could not encode frame diff")
    return encoded.tobytes()


def _blur_frame(payload: bytes) -> bytes:
    """Blur the selected camera frame and encode a distinct JPEG."""
    image = cv2.GaussianBlur(_decode(payload), (51, 51), 0)
    for quality in (80, 100, 1):
        ok, encoded = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, quality])
        if ok:
            altered = encoded.tobytes()
            if altered != payload:
                return altered
    raise RuntimeError("Could not encode a distinct blurred frame")


def _sample_plan(mode: TamperMode, count: int) -> tuple[int | None, range, str]:
    """Select the frame to blur or the contiguous group to remove."""
    if mode == "modify":
        seq = count * 2 // 5
        return seq, range(0), f"Frame #{seq} blurred (40% into the recording)"
    if mode == "delete":
        first = count // 2
        if first + 10 >= count:
            raise EvidenceConflict("Record at least 21 frames to demonstrate a 10-frame interior gap")
        return None, range(first, first + 10), f"Frames #{first}–#{first + 9} removed from footage and ledger"
    return None, range(max(0, count - 30), count), "Last 30 frames and their ledger lines dropped"


class EvidenceStore:
    """Manage exported archives and a bounded cache of verification reports."""

    def __init__(self, directory: Path) -> None:
        """Create the export directory and independent locks for writes and reports."""
        self._directory = directory
        directory.mkdir(parents=True, exist_ok=True)
        self._write_lock = Lock()
        self._report_lock = Lock()
        self._reports: OrderedDict[str, VerificationReport] = OrderedDict()

    def export(self, snapshot: CaptureSnapshot, device: Device) -> ExportResult:
        """Export the original camera frames and the matching ledger prefix."""
        session = snapshot.session
        destination = self._directory / f"frameseal_{session.session_id}.zip"
        metadata = PackageMetadata(session=session, device=device, capture_settings=snapshot.settings)
        with self._write_lock, _temporary_zip(self._directory) as temporary:
            with ZipFile(temporary, "w", ZIP_DEFLATED) as archive:
                archive.writestr("session.json", metadata.model_dump_json())
                archive.writestr("README.txt", _README)
                if session.seal is not None:
                    archive.writestr("seal.json", session.seal.model_dump_json())
                ledger_path = snapshot.vault.folder / "ledger.jsonl"
                with ledger_path.open("rb") as ledger, archive.open("ledger.jsonl", "w") as member:
                    for _ in range(snapshot.frame_count):
                        line = ledger.readline()
                        if not line.endswith(b"\n"):
                            raise OSError("The committed ledger prefix is unreadable")
                        member.write(line)
                for seq in range(snapshot.frame_count):
                    archive.write(snapshot.vault.frame_path(seq, "original"), frame_name(seq))
            return _publish_export(temporary, destination, snapshot.frame_count)

    def download(self, filename: str) -> Path | None:
        """Resolve a published package filename within the export directory."""
        if not _DOWNLOAD_NAME.fullmatch(filename):
            return None
        path = self._directory / filename
        return path if path.is_file() and path.resolve().parent == self._directory.resolve() else None

    def verify(self, package: Path | BinaryIO, filename: str | None = None) -> VerificationReport:
        """Verify a ZIP and retain its result for the reports API."""
        if isinstance(package, Path):
            with package.open("rb") as stream:
                result = verify_package(stream, filename or package.name)
        else:
            result = verify_package(package, filename or "evidence.zip")
        report = result.report
        with self._report_lock:
            self._reports[report.report_id] = report
            if len(self._reports) > _REPORT_LIMIT:
                self._reports.popitem(last=False)
        return report

    def report(self, report_id: str) -> VerificationReport | None:
        """Return a report retained by this server process."""
        with self._report_lock:
            return self._reports.get(report_id)

    def _latest_export(self) -> Path:
        """Find the latest published camera archive, excluding tamper samples."""
        exports = (
            path for path in self._directory.iterdir()
            if _RECORDING_NAME.fullmatch(path.name) and self.download(path.name) is not None
        )
        latest = max(exports, key=lambda path: (path.stat().st_mtime_ns, path.name), default=None)
        if latest is None:
            raise EvidenceConflict("Export a recording before creating a tamper sample")
        return latest

    def tamper_sample(self, mode: TamperMode) -> ExportResult:
        """Make a separate altered copy of the latest exported recording."""
        with self._write_lock:
            source = self._latest_export()
            destination = source.with_name(f"{source.stem}_{mode}.zip")
            with _temporary_zip(self._directory) as temporary:
                count, description = self._write_sample(source, temporary, mode)
                return _publish_export(temporary, destination, count, description)

    @staticmethod
    def _write_sample(source: Path, temporary: Path, mode: TamperMode) -> tuple[int, str]:
        """Copy the package while applying the selected frame and ledger changes."""
        with ZipFile(source) as base, ZipFile(temporary, "w", ZIP_DEFLATED) as sample:
            with base.open("ledger.jsonl") as ledger:
                count = sum(1 for _ in ledger)
            modified, removed, description = _sample_plan(mode, count)
            with base.open("ledger.jsonl") as ledger, sample.open("ledger.jsonl", "w") as member:
                for seq, line in enumerate(ledger):
                    if seq not in removed:
                        member.write(line)
            for name in ("session.json", "seal.json", "README.txt"):
                if name in base.NameToInfo:
                    sample.writestr(name, base.read(name))
            for seq in range(count):
                if seq in removed:
                    continue
                name = frame_name(seq)
                if seq == modified:
                    sample.writestr(name, _blur_frame(base.read(name)))
                else:
                    with base.open(name) as original, sample.open(name, "w") as copied:
                        copyfileobj(original, copied)
        return count - len(removed), description
