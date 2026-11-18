"""Frame encoding and packet production."""

from dataclasses import dataclass
from time import perf_counter

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from app import crypto
from app.models import ChainRecord


@dataclass(frozen=True)
class Packet:
    """A frame header and its exact JPEG payload."""

    header: ChainRecord
    payload: bytes


class Producer:
    """Build the camera's hash chain and sign its periodic checkpoints."""

    def __init__(
        self,
        session_id: str,
        sk: Ed25519PrivateKey,
        pk_raw: bytes,
        checkpoint_interval: int,
    ) -> None:
        """Start a chain at genesis with zero-based sequence numbers."""
        if checkpoint_interval <= 0:
            raise ValueError("checkpoint_interval must be positive")
        self.session_id = session_id
        self._sk = sk
        self._checkpoint_interval = checkpoint_interval
        self._prev = crypto.genesis(session_id, pk_raw)
        self._seq = 0
        self.hash_ms = 0.0
        self.sign_ms = 0.0

    def make_packet(self, jpeg_bytes: bytes, ts_ns: int) -> Packet:
        """Hash and link a JPEG, signing the chain if this is a checkpoint."""
        seq = self._seq
        started = perf_counter()
        frame_hash = crypto.sha256(jpeg_bytes)
        dhash = crypto.dhash_from_jpeg(jpeg_bytes)
        chain_hash = crypto.link(self._prev, frame_hash, dhash, seq, ts_ns)
        hash_ms = (perf_counter() - started) * 1000

        is_checkpoint = (seq + 1) % self._checkpoint_interval == 0
        signature = None
        sign_ms = 0.0
        if is_checkpoint:
            started = perf_counter()
            signature = crypto.sign(
                self._sk, crypto.checkpoint_message(self.session_id, seq, chain_hash)
            ).hex()
            sign_ms = (perf_counter() - started) * 1000

        header = ChainRecord(
            session_id=self.session_id,
            seq=seq,
            ts_ns=ts_ns,
            prev_hash=self._prev.hex(),
            frame_hash=frame_hash.hex(),
            dhash=dhash.hex(),
            chain_hash=chain_hash.hex(),
            is_checkpoint=is_checkpoint,
            signature=signature,
        )
        self._prev = chain_hash
        self._seq += 1
        self.hash_ms = hash_ms
        self.sign_ms = sign_ms
        return Packet(header, jpeg_bytes)
