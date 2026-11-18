"""Frame hashing, chain construction, and signing."""

import hashlib
from pathlib import Path
from tempfile import NamedTemporaryFile

import cv2
import numpy as np
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)


def sha256(data: bytes) -> bytes:
    """Return the raw SHA-256 digest of the supplied bytes."""
    return hashlib.sha256(data).digest()


def dhash_from_gray(gray: np.ndarray) -> bytes:
    """Compute an eight-byte dHash from an image's grayscale pixels."""
    resized = cv2.resize(gray, (9, 8), interpolation=cv2.INTER_AREA)
    comparisons = resized[:, 1:] > resized[:, :-1]
    return np.packbits(comparisons, bitorder="big").tobytes()


def dhash_from_jpeg(jpeg: bytes) -> bytes:
    """Decode the JPEG payload to grayscale and compute its dHash."""
    if not jpeg:
        raise ValueError("Empty JPEG payload")
    gray = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
    if gray is None:
        raise ValueError("Could not decode JPEG payload")
    return dhash_from_gray(gray)


def _u64(value: int) -> bytes:
    """Encode a nonnegative integer as eight big-endian bytes."""
    return value.to_bytes(8, byteorder="big")


def genesis(session_id: str, pk_raw: bytes) -> bytes:
    """Compute the opening chain hash for the session and signing device."""
    return sha256(b"FS1-GENESIS" + session_id.encode("utf-8") + pk_raw)


def link(prev: bytes, frame_hash: bytes, dhash: bytes, seq: int, ts_ns: int) -> bytes:
    """Compute a frame's chain hash from its predecessor and header fields."""
    return sha256(b"FS1-LINK" + prev + frame_hash + dhash + _u64(seq) + _u64(ts_ns))


def checkpoint_message(session_id: str, seq: int, chain_hash: bytes) -> bytes:
    """Build the message to sign at a checkpoint."""
    return b"FS1-CKPT" + session_id.encode("utf-8") + _u64(seq) + chain_hash


def seal_message(
    session_id: str, last_seq: int, chain_hash: bytes, frame_count: int
) -> bytes:
    """Build the message to sign when sealing a session."""
    return (
        b"FS1-SEAL"
        + session_id.encode("utf-8")
        + _u64(last_seq)
        + chain_hash
        + _u64(frame_count)
    )


def sign(sk: Ed25519PrivateKey, msg: bytes) -> bytes:
    """Sign a message with the device's Ed25519 private key."""
    return sk.sign(msg)


def verify(pk_raw: bytes, sig: bytes | None, msg: bytes) -> bool:
    """Return whether the signature is present and valid for the message."""
    if sig is None:
        return False
    try:
        Ed25519PublicKey.from_public_bytes(pk_raw).verify(sig, msg)
    except (InvalidSignature, TypeError, ValueError):
        return False
    return True


def load_or_create_device_key(path: str | Path) -> tuple[Ed25519PrivateKey, bytes]:
    """Read the device key, or create it once, and return its raw public key."""
    key_path = Path(path)
    try:
        pem = key_path.read_bytes()
    except FileNotFoundError:
        key_path.parent.mkdir(parents=True, exist_ok=True)
        sk = Ed25519PrivateKey.generate()
        pem = sk.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
        # Publish a complete PEM without replacing a key created by another caller.
        temporary = NamedTemporaryFile(dir=key_path.parent, delete=False)
        temp_path = Path(temporary.name)
        try:
            with temporary:
                temporary.write(pem)
            key_path.hardlink_to(temp_path)
        except FileExistsError:
            pem = key_path.read_bytes()
        finally:
            temp_path.unlink(missing_ok=True)

    private_key = serialization.load_pem_private_key(pem, password=None)
    if not isinstance(private_key, Ed25519PrivateKey):
        raise ValueError("Device key must be an Ed25519 private key")
    public_key = private_key.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    return private_key, public_key


def device_id(pk_raw: bytes) -> str:
    """Return the first sixteen lowercase hex digits of the public key digest."""
    return sha256(pk_raw).hex()[:16]


def hamming(a: bytes, b: bytes) -> int:
    """Count differing bits in two equal-length byte strings."""
    return sum((left ^ right).bit_count() for left, right in zip(a, b, strict=True))


def short(hex_str: str) -> str:
    """Keep the first and last four hex digits of a long value."""
    if len(hex_str) <= 8:
        return hex_str
    return f"{hex_str[:4]}…{hex_str[-4:]}"
