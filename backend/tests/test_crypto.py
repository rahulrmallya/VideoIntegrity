"""Behavior tests for the FrameSeal crypto primitives."""

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier

import cv2
import numpy as np
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from app import crypto


def test_payload_bit_flip_changes_frame_hash() -> None:
    """Hash the exact payload bytes."""
    assert crypto.sha256(b"frame\x00") != crypto.sha256(b"frame\x01")


def test_link_commits_to_sequence_and_timestamp() -> None:
    """Changing either link counter changes the chain digest."""
    prev = bytes(32)
    frame_hash = crypto.sha256(b"frame")
    dhash = bytes(8)
    baseline = crypto.link(prev, frame_hash, dhash, 1, 100)
    assert crypto.link(prev, frame_hash, dhash, 2, 100) != baseline
    assert crypto.link(prev, frame_hash, dhash, 1, 101) != baseline


def test_seal_message_layout() -> None:
    """Encode the final sequence and frame count around the chain hash."""
    session_id = "00000000-0000-4000-8000-000000000000"
    chain_hash = bytes(range(32))
    expected = (
        b"FS1-SEAL"
        b"00000000-0000-4000-8000-000000000000"
        b"\x00\x00\x00\x00\x00\x00\x01\x02"
        + chain_hash
        + b"\x00\x00\x00\x00\x00\x00\x01\x03"
    )
    assert crypto.seal_message(session_id, 258, chain_hash, 259) == expected


def test_verify_rejects_invalid_or_missing_signatures() -> None:
    """Return false for modified messages, malformed values, and absent signatures."""
    sk = Ed25519PrivateKey.generate()
    pk_raw = sk.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    message = b"checkpoint"
    signature = crypto.sign(sk, message)

    assert crypto.verify(pk_raw, signature, message)
    assert not crypto.verify(pk_raw, signature, b"changed checkpoint")
    assert not crypto.verify(pk_raw, signature[:-1], message)
    assert not crypto.verify(pk_raw, None, message)
    assert not crypto.verify(pk_raw[:-1], signature, message)


def test_jpeg_dhash_is_deterministic() -> None:
    """Hash two grayscale decodes of the same encoded JPEG payload."""
    gray = np.tile(np.arange(36, dtype=np.uint8) * 7, (32, 1))
    success, encoded = cv2.imencode(".jpg", gray)
    assert success
    jpeg = encoded.tobytes()

    assert crypto.dhash_from_jpeg(jpeg) == crypto.dhash_from_jpeg(jpeg) == b"\xff" * 8


def test_hamming_counts_different_bits() -> None:
    """Compare bits at matching positions in each byte."""
    assert crypto.hamming(b"\x00\xff", b"\xff\x0f") == 12
    assert crypto.hamming(b"\xab", b"\xab") == 0


def test_short_uses_ellipsis() -> None:
    """Keep four hex digits at each end."""
    assert crypto.short("9f3a12345678c71e") == "9f3a…c71e"


def test_device_key_is_created_once(tmp_path: Path) -> None:
    """Store a PKCS8 PEM and reload the same signing key."""
    path = tmp_path / "keys" / "device_ed25519.pem"
    first_key, first_public = crypto.load_or_create_device_key(path)
    original_pem = path.read_bytes()
    assert original_pem.startswith(b"-----BEGIN PRIVATE KEY-----")
    assert len(first_public) == 32

    second_key, second_public = crypto.load_or_create_device_key(path)
    assert second_public == first_public
    assert crypto.sign(second_key, b"test") == crypto.sign(first_key, b"test")
    assert path.read_bytes() == original_pem


def test_concurrent_device_key_creation_uses_one_identity(tmp_path: Path) -> None:
    """Read the same completed PEM when callers start together."""
    path = tmp_path / "device_ed25519.pem"
    ready = Barrier(2, timeout=5)

    def load_public_key() -> bytes:
        """Wait for the other caller and request the shared key."""
        ready.wait()
        return crypto.load_or_create_device_key(path)[1]

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(load_public_key)
        second = pool.submit(load_public_key)
        assert first.result() == second.result()
    assert list(tmp_path.iterdir()) == [path]
