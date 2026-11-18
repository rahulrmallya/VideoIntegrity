"""Session ledger and frame storage."""

import logging
from collections import deque
from dataclasses import dataclass
from heapq import nlargest
from os import stat_result
from pathlib import Path
from shutil import rmtree
from stat import FILE_ATTRIBUTE_REPARSE_POINT, S_ISDIR
from typing import Literal
from uuid import UUID

from app.config import SESSION_MAX_FRAMES
from app.models import ChainRecord, Seal, Session, StartRequest
from app.producer import Packet

FrameCopy = Literal["original", "received"]
SESSION_RETENTION = 10
logger = logging.getLogger(__name__)


def _session_folder(root: Path, folder: Path) -> stat_result | None:
    """Recognize an ordinary UUID4 session directory inside the session root."""
    try:
        identity = UUID(folder.name)
        if identity.version != 4 or str(identity) != folder.name:
            return None
        info = folder.lstat()
        if (S_ISDIR(info.st_mode)
                and not getattr(info, "st_file_attributes", 0) & FILE_ATTRIBUTE_REPARSE_POINT
                and folder.resolve() == root / folder.name):
            return info
    except (ValueError, OSError):
        return None
    return None


def prune_sessions(sessions_dir: Path) -> None:
    """Keep the ten newest session folders without following directory links."""
    try:
        info = sessions_dir.lstat()
    except FileNotFoundError:
        return
    if not S_ISDIR(info.st_mode) or getattr(info, "st_file_attributes", 0) & FILE_ATTRIBUTE_REPARSE_POINT:
        return
    root = sessions_dir.resolve()
    candidates = (
        (info.st_mtime_ns, folder.name) for folder in root.iterdir()
        if (info := _session_folder(root, folder)) is not None
    )
    keep = {name for _, name in nlargest(SESSION_RETENTION, candidates)}
    for folder in root.iterdir():
        if folder.name not in keep and _session_folder(root, folder) is not None:
            try:
                rmtree(folder)
                logger.info("Removed old session %s", folder.name)
            except OSError:
                logger.warning("Could not remove old session %s", folder.name, exc_info=True)


@dataclass(frozen=True)
class CaptureSnapshot:
    """A committed prefix of the append-only camera recording."""

    vault: "Vault"
    session: Session
    settings: StartRequest
    frame_count: int


def _write(path: Path, data: bytes) -> None:
    """Publish a complete file using a same-directory replacement."""
    temporary = path.with_suffix(path.suffix + ".tmp")
    try:
        temporary.write_bytes(data)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


class Vault:
    """Write one session's ledger and frame files under the data directory."""

    def __init__(self, sessions_dir: Path, session: Session) -> None:
        """Create an empty session folder and persist its initial metadata."""
        if session.session_id is None:
            raise ValueError("A vault requires a session ID")
        self.folder = sessions_dir / session.session_id
        self.folder.mkdir(parents=True, exist_ok=False)
        (self.folder / "frames").mkdir()
        (self.folder / "received").mkdir()
        self._ledger_path = self.folder / "ledger.jsonl"
        self._ledger_path.touch()
        self.save_session(session)
        self.last_header: ChainRecord | None = None

    def save_session(self, session: Session) -> None:
        """Replace the current on-disk session snapshot."""
        _write(self.folder / "session.json", session.model_dump_json().encode("utf-8"))

    def frame_path(self, seq: int, copy: FrameCopy) -> Path:
        """Return the original or received JPEG path for a sequence."""
        directory = "frames" if copy == "original" else "received"
        return self.folder / directory / f"{seq:08d}.jpg"

    def save_original(self, packet: Packet) -> None:
        """Store the camera bytes and append the corresponding header."""
        header = packet.header
        frame_path = self.frame_path(header.seq, "original")
        _write(frame_path, packet.payload)
        line = header.model_dump_json().encode("utf-8") + b"\n"
        try:
            with self._ledger_path.open("ab", buffering=0) as ledger:
                offset = ledger.tell()
                try:
                    if ledger.write(line) != len(line):
                        raise OSError("Could not write the complete ledger record")
                except OSError:
                    ledger.truncate(offset)
                    raise
        except OSError:
            frame_path.unlink(missing_ok=True)
            raise
        self.last_header = header

    def save_received(self, seq: int, payload: bytes) -> None:
        """Store the JPEG bytes associated with a tampered delivery."""
        _write(self.frame_path(seq, "received"), payload)

    def save_seal(self, seal: Seal) -> None:
        """Persist the session's final signed chain state."""
        _write(self.folder / "seal.json", seal.model_dump_json().encode("utf-8"))

    def recent_chain(self, limit: int) -> list[ChainRecord]:
        """Read up to the requested number of complete headers, newest first."""
        if limit == 0:
            return []
        with self._ledger_path.open("rb") as ledger:
            lines = deque((line for line in ledger if line.endswith(b"\n")),
                          maxlen=min(limit, SESSION_MAX_FRAMES))
        return [ChainRecord.model_validate_json(line) for line in reversed(lines)]
