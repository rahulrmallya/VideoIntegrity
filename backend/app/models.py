"""Pydantic models for the FrameSeal interface contract."""

from typing import Literal

from pydantic import BaseModel, Field

Source = Literal["webcam", "file", "synthetic"]
AttackType = Literal[
    "PIXEL_TAMPER",
    "FRAME_DROP",
    "FRAME_INSERT",
    "FRAME_REORDER",
    "LOOP_REPLAY",
    "CHAIN_FORGE",
    "STREAM_CUT",
]
IncidentKind = Literal[
    "FRAME_MODIFIED",
    "FRAME_DELETED",
    "FRAME_INSERTED",
    "FRAME_REORDERED",
    "REPLAY_DETECTED",
    "CHAIN_FORGED",
    "CHAIN_BROKEN",
    "STREAM_INTERRUPTED",
]


class Device(BaseModel):
    """Public signing device identity."""

    device_id: str
    public_key_hex: str
    algorithm: Literal["Ed25519"]
    created_at: str


class StartRequest(BaseModel):
    """Requested source and capture settings."""

    source: Source
    camera_index: int | None = None
    file_path: str | None = None
    fps: float = Field(default=15, gt=0, allow_inf_nan=False)
    width: int = Field(default=640, gt=0)
    height: int = Field(default=480, gt=0)
    jpeg_quality: int = Field(default=80, ge=0, le=100)
    checkpoint_interval: int = Field(default=15, gt=0)


class Seal(BaseModel):
    """Signed final chain state."""

    last_seq: int
    chain_hash: str
    frame_count: int
    signature: str | None


class Session(BaseModel):
    """Current capture session state."""

    session_id: str | None
    status: Literal["idle", "running", "stopped"]
    source: Source | None
    source_label: str | None
    fps: float
    width: int
    height: int
    checkpoint_interval: int
    started_at: str | None
    stopped_at: str | None
    device_id: str
    seal: Seal | None


class Stats(BaseModel):
    """Aggregate capture and verification metrics."""

    integrity: Literal["IDLE", "SECURE", "COMPROMISED"]
    fps_actual: float
    uptime_s: float
    frames_produced: int
    frames_delivered: int
    frames_sealed: int
    frames_pending: int
    frames_unverified: int
    frames_tampered: int
    frames_missing: int
    checkpoints_ok: int
    checkpoints_failed: int
    avg_hash_ms: float
    avg_sign_ms: float
    avg_verify_ms: float
    chain_head: str | None
    open_incident_id: str | None
    incidents_total: int
    last_detection_latency_ms: float | None


class AttackInfo(BaseModel):
    """An entry in the demo attack catalog."""

    type: AttackType
    label: str
    description: str
    expected_kind: str


class AttackAck(BaseModel):
    """An acknowledgement of a launched demo attack."""

    attack_id: str
    type: AttackType
    label: str
    started_at: str
    expected_kind: str


class AttackRequest(BaseModel):
    """An attack selection and its optional parameters."""

    type: AttackType
    params: dict[str, object] = Field(default_factory=dict)


class ExportResult(BaseModel):
    """Metadata for a downloadable evidence package."""

    filename: str
    download_url: str
    size_bytes: int
    package_sha256: str
    frame_count: int
    description: str | None = None


class IncidentEvidence(BaseModel):
    """Frame-level evidence for an integrity incident."""

    sample_seq: int | None
    expected_hash: str | None
    actual_hash: str | None
    expected_prev: str | None
    actual_prev: str | None
    visual_change_pct: float | None


class Incident(BaseModel):
    """A group of related integrity failures."""

    id: str
    kind: IncidentKind
    kinds_seen: list[IncidentKind]
    severity: Literal["warning", "critical"]
    status: Literal["open", "closed"]
    title: str
    explanation: str
    proof: str
    seq_from: int
    seq_to: int
    affected_count: int
    missing_count: int
    opened_at: str
    closed_at: str | None
    detection_latency_ms: float | None
    attack_id: str | None
    attack_type: AttackType | None
    evidence: IncidentEvidence
    acknowledged: bool


class ChainRecord(BaseModel):
    """A frame packet header recorded in the ledger."""

    session_id: str
    seq: int
    ts_ns: int
    prev_hash: str
    frame_hash: str
    dhash: str
    chain_hash: str
    is_checkpoint: bool
    signature: str | None


class VerificationReport(BaseModel):
    """Offline verification results for an evidence package."""

    report_id: str
    verdict: Literal["AUTHENTIC", "TAMPERED", "INCOMPLETE"]
    package_filename: str
    package_sha256: str
    session_id: str
    device_id: str
    public_key_hex: str
    first_frame_at: str | None
    last_frame_at: str | None
    frames_total: int
    frames_ok: int
    frames_tampered: int
    frames_missing: int
    checkpoints_total: int
    checkpoints_valid: int
    seal_valid: bool
    chain_head: str | None
    incidents: list[Incident]
    verified_at: str
    verify_ms: float
