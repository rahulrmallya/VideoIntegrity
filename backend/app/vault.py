"""Session ledger and frame storage."""

from collections import deque
from pathlib import Path
from typing import Literal

from app.models import ChainRecord, Seal, Session
from app.producer import Packet

FrameCopy = Literal["original", "received"]


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
            lines = deque((line for line in ledger if line.endswith(b"\n")), maxlen=limit)
        return [ChainRecord.model_validate_json(line) for line in reversed(lines)]
