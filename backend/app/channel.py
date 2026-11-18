"""Packet forwarding and demo attack simulation."""

import time
from collections import deque
from collections.abc import Callable, Iterator
from dataclasses import dataclass, replace
from itertools import count

import cv2
import numpy as np

from app import crypto
from app.config import utc_timestamp
from app.models import AttackAck, AttackInfo, AttackType
from app.producer import Packet

REPLAY_HISTORY = 45
CATALOG = (
    AttackInfo(type="PIXEL_TAMPER", label="Erase an object",
               description="Blurs the central region of the next 30 frames.",
               expected_kind="FRAME_MODIFIED"),
    AttackInfo(type="FRAME_DROP", label="Delete frames",
               description="Silently drops the next 10 packets.",
               expected_kind="FRAME_DELETED"),
    AttackInfo(type="FRAME_INSERT", label="Insert a fake frame",
               description="Sends a synthetic frame claiming the next genuine sequence.",
               expected_kind="FRAME_INSERTED"),
    AttackInfo(type="FRAME_REORDER", label="Swap two frames",
               description="Delivers the next two packets out of order.",
               expected_kind="FRAME_REORDERED"),
    AttackInfo(type="LOOP_REPLAY", label="Loop old footage",
               description="Replays the last 45 forwarded packets instead of live footage.",
               expected_kind="REPLAY_DETECTED"),
    AttackInfo(type="CHAIN_FORGE", label="Smart forgery",
               description="Alters frames and recomputes hashes while retaining the original signature.",
               expected_kind="CHAIN_FORGED"),
    AttackInfo(type="STREAM_CUT", label="Cut the feed",
               description="Drops all packets for four seconds.",
               expected_kind="STREAM_INTERRUPTED"),
)
_CATALOG_BY_TYPE = {attack.type: attack for attack in CATALOG}
_PARAMETERS: dict[AttackType, tuple[str, int, int | float, int]] = {
    "PIXEL_TAMPER": ("frames", 1, 150, 30),
    "FRAME_DROP": ("count", 1, 60, 10),
    "LOOP_REPLAY": ("frames", 15, 90, 45),
    "CHAIN_FORGE": ("min_frames", 1, 30, 5),
    "STREAM_CUT": ("seconds", 2.5, 10, 4),
}


class AttackConflict(RuntimeError):
    """The session cannot accept a new attack."""


def _attack_limit(kind: AttackType, params: dict[str, object]) -> int | float:
    """Validate the optional count or duration for an attack."""
    spec = _PARAMETERS.get(kind)
    if spec is None:
        if params:
            raise ValueError(f"{kind} does not accept params")
        return 0
    name, minimum, maximum, default = spec
    if params.keys() - {name}:
        raise ValueError(f"{kind} only accepts the '{name}' parameter")
    value = params.get(name, default)
    valid_type = type(value) is int or (kind == "STREAM_CUT" and type(value) is float)
    if not valid_type or not isinstance(value, (int, float)) or not minimum <= value <= maximum:
        number_type = "a number" if kind == "STREAM_CUT" else "an integer"
        raise ValueError(f"{name} must be {number_type} between {minimum} and {maximum}")
    return value


@dataclass
class _Attack:
    """Runtime state for one launched attack."""

    ack: AttackAck
    limit: int | float
    first_effect_at: float | None = None
    processed: int = 0
    held: Packet | None = None
    replay: tuple[Packet, ...] = ()


class AttackEngine:
    """Apply one scripted packet transform at a time."""

    def __init__(
        self, clock: Callable[[], float], jpeg_quality: int, ids: Iterator[int],
    ) -> None:
        """Start with no active attack or forwarding history."""
        self._clock = clock
        self._encode_options = [cv2.IMWRITE_JPEG_QUALITY, jpeg_quality]
        self._ids = ids
        self._active: _Attack | None = None
        self._effect: _Attack | None = None
        self._history: deque[Packet] = deque(maxlen=REPLAY_HISTORY)
        self._last_chain_hash: str | None = None

    @property
    def active(self) -> AttackAck | None:
        """Return the acknowledgment for the current attack, including warmup."""
        return self._active.ack.model_copy() if self._active is not None else None

    def start(self, kind: AttackType, params: dict[str, object]) -> AttackAck:
        """Reserve the channel and return an acknowledgment before any effect."""
        if self._active is not None:
            raise AttackConflict("An attack is already active")
        limit = _attack_limit(kind, params)
        info = _CATALOG_BY_TYPE[kind]
        ack = AttackAck(
            attack_id=f"atk_{next(self._ids):04d}",
            type=info.type,
            label=info.label,
            started_at=utc_timestamp(),
            expected_kind=info.expected_kind,
        )
        self._active = _Attack(ack, limit)
        return ack.model_copy()

    def cancel(self) -> AttackAck | None:
        """End any active attack when the capture session stops."""
        ack = self.active
        self._active = self._effect = None
        return ack

    def incident_context(self) -> tuple[AttackAck, float] | None:
        """Return attribution and latency when the verifier opens an incident."""
        attack = self._effect
        if attack is None or attack.first_effect_at is None:
            return None
        return attack.ack, round((self._clock() - attack.first_effect_at) * 1000, 3)

    def record_forwarded(self, packet: Packet) -> None:
        """Remember the most recent outgoing header and bounded replay history."""
        self._last_chain_hash = packet.header.chain_hash
        self._history.append(packet)

    def process(self, packet: Packet) -> list[Packet]:
        """Transform a producer packet and expose its effect to the verifier."""
        self._effect = None
        attack = self._active
        if attack is None:
            return [packet]
        kind = attack.ack.type
        if kind == "LOOP_REPLAY" and len(self._history) < REPLAY_HISTORY:
            return [packet]
        if kind == "STREAM_CUT" and not self._history:
            return [packet]

        now = self._clock()
        if attack.first_effect_at is None:
            attack.first_effect_at = now
            if kind == "LOOP_REPLAY":
                attack.replay = tuple(self._history)[-int(attack.limit):]
        self._effect = attack
        attack.processed += 1

        match kind:
            case "PIXEL_TAMPER":
                image = self._decode(packet)
                region = self._central_region(image)
                region[:] = cv2.GaussianBlur(region, (51, 51), 0)
                payload = self._encode(image, packet.payload)
                if attack.processed == attack.limit:
                    self._active = None
                return [replace(packet, payload=payload)]
            case "FRAME_DROP":
                if attack.processed <= attack.limit:
                    return []
                # Keep the attack active until the delivery that exposes the gap.
                self._active = None
                return [packet]
            case "FRAME_INSERT":
                fake = self._insert(packet)
                self._active = None
                return [fake, packet]
            case "FRAME_REORDER":
                if attack.held is None:
                    attack.held = packet
                    return []
                self._active = None
                return [packet, attack.held]
            case "LOOP_REPLAY":
                replay = attack.replay[(attack.processed - 1) % len(attack.replay)]
                if attack.processed == attack.limit:
                    self._active = None
                return [replay]
            case "CHAIN_FORGE":
                image = self._decode(packet)
                self._central_region(image)[:] = 0
                forged = self._relink(packet, self._encode(image, packet.payload))
                if attack.processed >= attack.limit and packet.header.is_checkpoint:
                    self._active = None
                return [forged]
            case "STREAM_CUT":
                if now < attack.first_effect_at + attack.limit:
                    return []
                self._active = None
                return [packet]

    @staticmethod
    def _decode(packet: Packet) -> np.ndarray:
        """Decode the camera's JPEG to an editable image."""
        return cv2.imdecode(np.frombuffer(packet.payload, dtype=np.uint8), cv2.IMREAD_COLOR)

    @staticmethod
    def _central_region(image: np.ndarray) -> np.ndarray:
        """Select the central 40 percent on each axis."""
        height, width = image.shape[:2]
        region_width, region_height = max(1, round(width * 0.4)), max(1, round(height * 0.4))
        x, y = (width - region_width) // 2, (height - region_height) // 2
        return image[y:y + region_height, x:x + region_width]

    def _encode(self, image: np.ndarray, original: bytes) -> bytes:
        """Encode altered pixels, even if the source already looks identical."""
        for options in (self._encode_options, [cv2.IMWRITE_JPEG_QUALITY, 100],
                        [cv2.IMWRITE_JPEG_QUALITY, 1]):
            ok, encoded = cv2.imencode(".jpg", image, options)
            if not ok:
                break
            payload = encoded.tobytes()
            if payload != original:
                return payload
        raise RuntimeError("Could not encode a distinct altered frame")

    def _insert(self, packet: Packet) -> Packet:
        """Create an unsigned synthetic frame claiming the incoming sequence."""
        image = np.empty_like(self._decode(packet))
        image[:] = (32, 85, 24)
        height, width = image.shape[:2]
        font = cv2.FONT_HERSHEY_SIMPLEX
        text = "ALL CLEAR"
        (text_width, text_height), _ = cv2.getTextSize(text, font, 1, 2)
        scale = 0.8 * min(width / text_width, height / text_height)
        (text_width, text_height), _ = cv2.getTextSize(text, font, scale, 2)
        origin = ((width - text_width) // 2, (height + text_height) // 2)
        cv2.putText(image, text, origin, font, scale, (230, 255, 230), 2, cv2.LINE_AA)
        header = packet.header.model_copy(update={"is_checkpoint": False, "signature": None})
        return self._relink(replace(packet, header=header), self._encode(image, packet.payload))

    def _relink(self, packet: Packet, payload: bytes) -> Packet:
        """Hash altered bytes and link to the most recently forwarded header."""
        header = packet.header
        prev = self._last_chain_hash or header.prev_hash
        frame_hash = crypto.sha256(payload)
        dhash = crypto.dhash_from_jpeg(payload)
        chain_hash = crypto.link(bytes.fromhex(prev), frame_hash, dhash, header.seq, header.ts_ns)
        return Packet(header.model_copy(update={
            "prev_hash": prev,
            "frame_hash": frame_hash.hex(),
            "dhash": dhash.hex(),
            "chain_hash": chain_hash.hex(),
        }), payload)


class Channel:
    """Forward packets through the session's in-process attack engine."""

    def __init__(
        self,
        transform: Callable[[Packet], list[Packet]] | None = None,
        *,
        clock: Callable[[], float] = time.monotonic,
        jpeg_quality: int = 80,
        attack_ids: Iterator[int] | None = None,
    ) -> None:
        """Create a pass-through channel with an idle attack engine."""
        self._transform = transform
        self.attacks = AttackEngine(clock, jpeg_quality, attack_ids if attack_ids is not None else count(1))

    def process(self, packet: Packet) -> list[Packet]:
        """Apply the active attack and record the packets actually forwarded."""
        delivered = self.attacks.process(packet)
        if self._transform is not None:
            delivered = [output for incoming in delivered for output in self._transform(incoming)]
        for incoming in delivered:
            self.attacks.record_forwarded(incoming)
        return delivered
