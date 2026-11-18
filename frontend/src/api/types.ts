// FrameSeal contract types — mirrors CONTRACT.md v1.0 exactly (snake_case, same field names).
// Do not add fields here that the contract does not define.

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** Lowercase hex. SHA-256 = 64 chars, dHash = 16 chars, Ed25519 signature = 128 chars (§1). */
export type Hex = string;
/** ISO-8601 UTC string — every `*_at` field (§1). */
export type IsoDateTime = string;
/**
 * Unix epoch nanoseconds (§1). Note: ~1.7e18 exceeds Number.MAX_SAFE_INTEGER, so after
 * JSON.parse the last few digits are imprecise. Fine for display; never use it as an identity.
 */
export type TsNs = number;

export type SourceKind = 'webcam' | 'file' | 'synthetic';

// ---------------------------------------------------------------------------
// §4 Packet header
// ---------------------------------------------------------------------------

export type ChainRecord = {
  session_id: string;
  seq: number;
  ts_ns: TsNs;
  prev_hash: Hex;
  frame_hash: Hex;
  dhash: Hex;
  chain_hash: Hex;
  is_checkpoint: boolean;
  /** 128-hex on checkpoints, otherwise null. */
  signature: Hex | null;
};

// ---------------------------------------------------------------------------
// §5 Timeline statuses
// ---------------------------------------------------------------------------

export type TimelineStatus = 'pending' | 'sealed' | 'unverified' | 'tampered' | 'missing';

// ---------------------------------------------------------------------------
// §6 Incidents
// ---------------------------------------------------------------------------

export type IncidentKind =
  | 'FRAME_MODIFIED'
  | 'FRAME_DELETED'
  | 'FRAME_INSERTED'
  | 'FRAME_REORDERED'
  | 'REPLAY_DETECTED'
  | 'CHAIN_FORGED'
  | 'CHAIN_BROKEN'
  | 'STREAM_INTERRUPTED';

export type IncidentSeverity = 'warning' | 'critical';
export type IncidentStatus = 'open' | 'closed';

export type IncidentEvidence = {
  sample_seq: number;
  expected_hash: Hex | null;
  actual_hash: Hex | null;
  expected_prev: Hex | null;
  actual_prev: Hex | null;
  visual_change_pct: number | null;
};

export type Incident = {
  id: string;
  kind: IncidentKind;
  kinds_seen: IncidentKind[];
  severity: IncidentSeverity;
  status: IncidentStatus;
  title: string;
  explanation: string;
  proof: string;
  seq_from: number;
  seq_to: number;
  affected_count: number;
  missing_count: number;
  opened_at: IsoDateTime;
  closed_at: IsoDateTime | null;
  /** null if no attack was launched through the API. */
  detection_latency_ms: number | null;
  attack_id: string | null;
  attack_type: AttackType | null;
  evidence: IncidentEvidence;
  acknowledged: boolean;
};

// ---------------------------------------------------------------------------
// §8 REST types
// ---------------------------------------------------------------------------

export type Health = { status: 'ok'; version: string };

export type Device = {
  device_id: string;
  public_key_hex: Hex;
  algorithm: 'Ed25519';
  created_at: IsoDateTime;
};

export type StartRequest = {
  source: SourceKind;
  camera_index?: number;
  file_path?: string | null;
  fps?: number;
  width?: number;
  height?: number;
  jpeg_quality?: number;
  checkpoint_interval?: number;
};

export type SessionSeal = {
  last_seq: number;
  chain_hash: Hex;
  frame_count: number;
  signature: Hex;
};

export type SessionStatus = 'idle' | 'running' | 'stopped';

export type Session = {
  session_id: string | null;
  status: SessionStatus;
  source: SourceKind | null;
  source_label: string | null;
  fps: number;
  width: number;
  height: number;
  checkpoint_interval: number;
  started_at: IsoDateTime | null;
  stopped_at: IsoDateTime | null;
  device_id: string;
  seal: SessionSeal | null;
};

export type Integrity = 'IDLE' | 'SECURE' | 'COMPROMISED';

export type Stats = {
  /** COMPROMISED while an incident is open. */
  integrity: Integrity;
  fps_actual: number;
  uptime_s: number;
  frames_produced: number;
  frames_delivered: number;
  frames_sealed: number;
  frames_pending: number;
  frames_unverified: number;
  frames_tampered: number;
  frames_missing: number;
  checkpoints_ok: number;
  checkpoints_failed: number;
  avg_hash_ms: number;
  avg_sign_ms: number;
  avg_verify_ms: number;
  chain_head: Hex | null;
  open_incident_id: string | null;
  incidents_total: number;
  last_detection_latency_ms: number | null;
};

export type AttackType =
  | 'PIXEL_TAMPER'
  | 'FRAME_DROP'
  | 'FRAME_INSERT'
  | 'FRAME_REORDER'
  | 'LOOP_REPLAY'
  | 'CHAIN_FORGE'
  | 'STREAM_CUT';

export type AttackInfo = {
  type: AttackType;
  label: string;
  description: string;
  expected_kind: string;
};

/** Body of POST /api/attacks. */
export type AttackRequest = {
  type: AttackType;
  params: Record<string, unknown>;
};

export type AttackAck = {
  attack_id: string;
  type: AttackType;
  label: string;
  started_at: IsoDateTime;
  expected_kind: string;
};

export type ExportResult = {
  filename: string;
  download_url: string;
  size_bytes: number;
  package_sha256: Hex;
  frame_count: number;
  description?: string;
};

/** Body of POST /api/evidence/tamper-sample. */
export type TamperSampleMode = 'modify' | 'delete' | 'truncate';
export type TamperSampleRequest = { mode: TamperSampleMode };

export type Verdict = 'AUTHENTIC' | 'TAMPERED' | 'INCOMPLETE';

export type VerificationReport = {
  report_id: string;
  verdict: Verdict;
  package_filename: string;
  package_sha256: Hex;
  session_id: string;
  device_id: string;
  public_key_hex: Hex;
  first_frame_at: IsoDateTime | null;
  last_frame_at: IsoDateTime | null;
  frames_total: number;
  frames_ok: number;
  frames_tampered: number;
  frames_missing: number;
  checkpoints_total: number;
  checkpoints_valid: number;
  seal_valid: boolean;
  chain_head: Hex | null;
  incidents: Incident[];
  verified_at: IsoDateTime;
  verify_ms: number;
};

/** Error body for every 4xx/5xx response. */
export type ApiError = { detail: string };

// ---------------------------------------------------------------------------
// §9 WebSocket /ws/live (server → client). Payload fields sit next to `type`.
// ---------------------------------------------------------------------------

export type FrameVerdict = 'ok' | 'tampered';

export type HelloMessage = {
  type: 'hello';
  session: Session;
  device: Device;
  catalog: AttackInfo[];
};

export type FrameMessage = {
  type: 'frame';
  seq: number;
  ts_ns: TsNs;
  jpeg_b64: string;
  verdict: FrameVerdict;
  reasons: string[];
  frame_hash: Hex;
  computed_hash: Hex;
  prev_hash: Hex;
  chain_hash: Hex;
  dhash: Hex;
  is_checkpoint: boolean;
  hash_ms: number;
  verify_ms: number;
};

export type StatusUpdate = { seq: number; status: TimelineStatus };

export type StatusMessage = {
  type: 'status';
  updates: StatusUpdate[];
};

export type SealMessage = {
  type: 'seal';
  seq: number;
  valid: boolean;
  window_from: number;
  window_to: number;
  chain_hash: Hex;
  /** A checkpoint may arrive without a signature (§5.7: counts as invalid). */
  signature: Hex | null;
  verify_ms: number;
};

export type IncidentMessage = {
  type: 'incident';
  incident: Incident;
};

export type StatsMessage = {
  type: 'stats';
  stats: Stats;
};

export type SessionMessage = {
  type: 'session';
  session: Session;
};

export type AttackPhase = 'started' | 'ended';

export type AttackMessage = {
  type: 'attack';
  attack: AttackAck;
  phase: AttackPhase;
};

export type LiveMessage =
  | HelloMessage
  | FrameMessage
  | StatusMessage
  | SealMessage
  | IncidentMessage
  | StatsMessage
  | SessionMessage
  | AttackMessage;

export type LiveMessageType = LiveMessage['type'];
