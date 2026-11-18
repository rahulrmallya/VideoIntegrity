"""Verify a FrameSeal evidence archive using only the packaged public key."""

import math
import re
import struct
import time
import zlib
from dataclasses import dataclass, field
from hashlib import file_digest
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import BinaryIO
from uuid import uuid4
from zipfile import BadZipFile, ZipFile

from pydantic import BaseModel, ValidationError

from app import crypto
from app.config import utc_timestamp
from app.models import ChainRecord, Device, Seal, Session, StartRequest, VerificationReport
from app.producer import Packet
from app.verifier import Verifier, VerifyResult

MAX_UNCOMPRESSED_BYTES = 2 * 1024**3
MAX_METADATA_BYTES = 64 * 1024
MAX_FRAME_BYTES = 64 * 1024**2
FRAME_NAME = re.compile(r"frames/([0-9]{8,20})\.jpg")
U64_MAX = (1 << 64) - 1
BAD_FRAME_LIMIT = 10


class InvalidPackage(ValueError):
    """An archive cannot be read as a FrameSeal evidence package."""


class PackageMetadata(BaseModel):
    """Session, device identity, and capture settings stored in session.json."""

    session: Session
    device: Device
    capture_settings: StartRequest


@dataclass(frozen=True)
class PackageVerification:
    """The contract report and a bounded list for the command-line summary."""

    report: VerificationReport
    first_bad_frames: tuple[int, ...]


def frame_name(seq: int) -> str:
    """Return the ZIP member name for a frame sequence."""
    return f"frames/{seq:08d}.jpg"


def _check_members(archive: ZipFile) -> int:
    """Validate every member name and size, and find the last archived JPEG."""
    total = 0
    last_frame = -1
    for member in archive.infolist():
        name = member.orig_filename
        if ("\x00" in name or "\\" in name or PurePosixPath(name).is_absolute()
                or PureWindowsPath(name).drive or ".." in PurePosixPath(name).parts):
            raise InvalidPackage(f"Unsafe ZIP member path: {name!r}")
        total += member.file_size
        if total > MAX_UNCOMPRESSED_BYTES:
            raise InvalidPackage("ZIP exceeds the 2 GB uncompressed size limit")
        match = FRAME_NAME.fullmatch(name)
        if match:
            seq = int(match[1])
            if name != frame_name(seq) or seq > U64_MAX:
                raise InvalidPackage(f"Invalid frame filename: {name!r}")
            if member.file_size > MAX_FRAME_BYTES:
                raise InvalidPackage(f"Frame #{seq} exceeds the per-frame size limit")
            last_frame = max(last_frame, seq)
    if len(archive.NameToInfo) != len(archive.infolist()):
        raise InvalidPackage("ZIP contains duplicate member names")
    return last_frame


def _read_metadata(archive: ZipFile, name: str) -> bytes:
    """Read a small JSON member with a size bound."""
    member = archive.getinfo(name)
    if member.file_size > MAX_METADATA_BYTES:
        raise InvalidPackage(f"{name} exceeds the metadata size limit")
    return archive.read(member)


def _read_identity(archive: ZipFile) -> tuple[Session, Device, bytes]:
    """Load and validate the session's public identity and timing settings."""
    try:
        metadata = PackageMetadata.model_validate_json(_read_metadata(archive, "session.json"), strict=True)
    except ValidationError as error:
        raise InvalidPackage("Invalid session.json metadata") from error
    session, device = metadata.session, metadata.device
    if not re.fullmatch(r"[0-9a-f]{64}", device.public_key_hex):
        raise InvalidPackage("session.json does not contain a valid Ed25519 public key")
    public_key = bytes.fromhex(device.public_key_hex)
    if device.device_id != crypto.device_id(public_key) or session.device_id != device.device_id:
        raise InvalidPackage("Session device ID does not match the packaged public key")
    if (not session.session_id or not math.isfinite(session.fps) or session.fps <= 0
            or not 1 <= session.checkpoint_interval <= U64_MAX):
        raise InvalidPackage("Invalid session ID or timing settings")
    return session, device, public_key


def _seal_matches(
    archive: ZipFile, session_id: str, public_key: bytes, last: ChainRecord | None,
) -> bool:
    """Validate the signed ending against the last ledger record and logical length."""
    if last is None or "seal.json" not in archive.NameToInfo:
        return False
    try:
        seal = Seal.model_validate_json(_read_metadata(archive, "seal.json"), strict=True)
        if (seal.last_seq, seal.chain_hash, seal.frame_count) != (last.seq, last.chain_hash, last.seq + 1):
            return False
        if not seal.signature or not re.fullmatch(r"[0-9a-f]{128}", seal.signature):
            return False
        chain_hash = bytes.fromhex(seal.chain_hash)
        if len(chain_hash) != 32:
            return False
        message = crypto.seal_message(session_id, seal.last_seq, chain_hash, seal.frame_count)
        return crypto.verify(public_key, bytes.fromhex(seal.signature), message)
    except (ValueError, OverflowError):
        return False


@dataclass
class _FrameCounts:
    """Accumulate report counts with only the current checkpoint window in memory."""

    delivered: int = 0
    tampered: int = 0
    unverified: int = 0
    checkpoints: int = 0
    valid_checkpoints: int = 0
    first_bad: list[int] = field(default_factory=list)
    _bad_in_window: set[int] = field(default_factory=set)

    def flag_range(self, first: int, stop: int) -> None:
        """Keep the first flagged sequences without enumerating large gaps."""
        candidates = range(first, min(stop, first + BAD_FRAME_LIMIT))
        self.first_bad = sorted(set(self.first_bad).union(candidates))[:BAD_FRAME_LIMIT]

    def _mark_tampered(self, seq: int) -> None:
        """Record a damaged sequence once even if its checkpoint also fails."""
        if seq not in self._bad_in_window:
            self._bad_in_window.add(seq)
            self.tampered += 1
            self.flag_range(seq, seq + 1)

    def apply(self, seq: int, result: VerifyResult, expected: int, verifier: Verifier) -> None:
        """Reduce a delivery's verdict and timeline updates to report counters."""
        fresh = seq >= expected
        self.delivered += fresh
        if result.verdict == "tampered":
            self.flag_range(seq, seq + 1)
            if fresh:
                self._mark_tampered(seq)
        for update_seq, status in result.status_updates:
            if status == "tampered":
                self._mark_tampered(update_seq)
            elif status == "unverified" and update_seq not in self._bad_in_window:
                self.unverified += 1
            if status == "unverified":
                self._bad_in_window.discard(update_seq)
        if result.seal is not None:
            self.checkpoints += 1
            self.valid_checkpoints += result.seal.valid
            self._bad_in_window.intersection_update({seq})
        elif fresh and expected - 1 not in verifier.window:
            self._bad_in_window = {
                bad for bad in self._bad_in_window if bad == seq or bad in verifier.window
            }


def _verify_ledger(
    archive: ZipFile, verifier: Verifier, last_frame: int, counts: _FrameCounts,
) -> tuple[int, ChainRecord | None, ChainRecord | None]:
    """Walk ledger records in sequence order and feed available JPEGs to the verifier."""
    first = last = None
    with archive.open("ledger.jsonl") as ledger:
        while line := ledger.readline(MAX_METADATA_BYTES + 1):
            if len(line) > MAX_METADATA_BYTES:
                raise InvalidPackage("An evidence ledger line exceeds the size limit")
            try:
                header = ChainRecord.model_validate_json(line, strict=True)
            except ValidationError as error:
                raise InvalidPackage("Invalid chain record in ledger.jsonl") from error
            if (not 0 <= header.seq <= U64_MAX or not 0 <= header.ts_ns <= U64_MAX
                    or (last is not None and header.seq < last.seq)):
                raise InvalidPackage("Ledger records must be in sequence order with valid timestamps")
            if first is None:
                first = header
            last = header
            member = archive.NameToInfo.get(frame_name(header.seq))
            if member is None:
                continue
            expected = verifier.expected_seq
            if header.seq > expected:
                counts.flag_range(expected, header.seq)
            result = verifier.process(Packet(header, archive.read(member)))
            counts.apply(header.seq, result, expected, verifier)
    observed = max(last_frame, last.seq if last is not None else -1) + 1
    if observed > verifier.expected_seq:
        counts.flag_range(verifier.expected_seq, observed)
        verifier.report_gap(observed)
    return observed, first, last


def verify_package(stream: BinaryIO, filename: str) -> PackageVerification:
    """Verify an open ZIP stream, returning a report or a readable format error."""
    started = time.perf_counter()
    try:
        with ZipFile(stream) as archive:
            last_frame = _check_members(archive)
            session, device, public_key = _read_identity(archive)
            session_id = session.session_id
            assert session_id is not None
            # Use sequence time for the offline replay, with no delivery watchdog.
            verifier = Verifier(session_id, public_key, session.checkpoint_interval, session.fps,
                                lambda: verifier.expected_seq / session.fps, offline=True)
            counts = _FrameCounts()
            total, first, last = _verify_ledger(archive, verifier, last_frame, counts)
            seal_valid = last is not None and total == last.seq + 1 and _seal_matches(
                archive, session_id, public_key, last
            )
        stream.seek(0)
        digest = file_digest(stream, "sha256").hexdigest()
    except KeyError as error:
        raise InvalidPackage(f"Missing required package member: {error.args[0]}") from error
    except (BadZipFile, OSError, EOFError, RuntimeError, UnicodeError, struct.error, zlib.error) as error:
        raise InvalidPackage(f"Could not read evidence ZIP: {error}") from error

    missing = total - counts.delivered
    verdict = "TAMPERED" if verifier.incident_manager.total else ("AUTHENTIC" if seal_valid else "INCOMPLETE")
    report = VerificationReport(
        report_id=f"rpt_{uuid4().hex}",
        verdict=verdict,
        package_filename=PureWindowsPath(filename).name,
        package_sha256=digest,
        session_id=session_id,
        device_id=device.device_id,
        public_key_hex=device.public_key_hex,
        first_frame_at=utc_timestamp(first.ts_ns / 1e9) if first is not None else None,
        last_frame_at=utc_timestamp(last.ts_ns / 1e9) if last is not None else None,
        frames_total=total,
        frames_ok=counts.delivered - counts.tampered - counts.unverified,
        frames_tampered=counts.tampered,
        frames_missing=missing,
        checkpoints_total=counts.checkpoints,
        checkpoints_valid=counts.valid_checkpoints,
        seal_valid=seal_valid,
        chain_head=last.chain_hash if last is not None else None,
        incidents=verifier.incidents,
        verified_at=utc_timestamp(),
        verify_ms=round((time.perf_counter() - started) * 1000, 3),
    )
    return PackageVerification(report, tuple(counts.first_bad))
