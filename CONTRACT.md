# FrameSeal — Interface Contract v1.0

Single source of truth shared by the backend agent (Codex, `/backend`) and the frontend agent (Claude Code, `/frontend`).
Neither agent edits this file. If a change is needed, the agent stops and describes it; the human applies it and logs it in §12.

FrameSeal detects unauthorized modification of a live video stream. Every frame gets a SHA-256 fingerprint,
every fingerprint is linked into a hash chain, and the chain head is signed (Ed25519) once per second.
A verifier that knows only the camera's public key checks every frame as it arrives.

---

## 1. Ports, conventions

| Item | Value |
| --- | --- |
| Backend | FastAPI + uvicorn on `http://127.0.0.1:8000` |
| REST prefix | `/api` |
| WebSocket | `ws://127.0.0.1:8000/ws/live` |
| Frontend | Vite dev server on `http://localhost:5173`, proxying `/api` and `/ws` (with `ws: true`) to port 8000 |
| JSON keys | `snake_case` |
| Hashes | lowercase hex strings (SHA-256 = 64 chars, dHash = 16 chars, Ed25519 signature = 128 chars) |
| Time | `ts_ns` = Unix epoch nanoseconds (integer). Every `*_at` field = ISO-8601 UTC string |
| Video | default 640×480, 15 fps, JPEG quality 80, checkpoint every 15 frames (= 1 second) |
| CORS | backend allows `http://localhost:5173` |

## 2. Glossary

- **Producer** — the camera side. Captures a frame, JPEG-encodes it, hashes it, links it, signs checkpoints, stores the original in the vault.
- **Channel** — the network between camera and viewer. The **attack engine** lives here and can modify, drop, insert, reorder or replay packets.
- **Verifier** — the viewer side. Knows only the device public key. Checks every packet that comes out of the channel.
- **Packet** — `header` (§4) + `payload` (the JPEG bytes).
- **Checkpoint** — a packet whose header carries a signature over its chain hash.
- **Window** — the frames between two checkpoints.
- **Incident** — one grouped alert, open from the first failure until the stream is cleanly re-sealed (§6).

## 3. Crypto spec (exact bytes)

Notation: `||` = byte concatenation, `u64(x)` = 8-byte big-endian unsigned integer, `H(x)` = SHA-256 digest (32 raw bytes), `utf8(s)` = UTF-8 bytes of string `s`.

1. **Device key** — Ed25519. Private key stored at `backend/data/keys/device_ed25519.pem` (PKCS8 PEM, unencrypted), generated on first run and reused afterwards. `pk` = 32-byte raw public key. `device_id = hex(H(pk))[:16]`.
2. **Session id** — UUID4 string, 36 characters, lowercase.
3. **frame_hash** = `H(jpeg_bytes)` — the exact payload bytes sent on the wire and stored in the vault.
4. **dhash** (64-bit perceptual hash) — decode the JPEG payload to grayscale → `cv2.resize(gray, (9, 8), interpolation=cv2.INTER_AREA)` (9 wide, 8 tall) → for each row r in 0..7 and column c in 0..7: bit = `px[r][c+1] > px[r][c]` → 64 bits read row by row, first bit = most significant → 8 bytes → 16 hex chars. Always computed from the **decoded payload**, never from the raw camera frame.
5. **genesis** = `H(b"FS1-GENESIS" || utf8(session_id) || pk)`.
6. **chain_hash[i]** = `H(b"FS1-LINK" || prev[i] || frame_hash[i] || dhash[i] || u64(seq[i]) || u64(ts_ns[i]))` where `prev[0] = genesis` and `prev[i] = chain_hash[i-1]`. `dhash[i]` here is the 8 raw bytes.
7. **Checkpoint** — packet `i` is a checkpoint iff `(seq + 1) % checkpoint_interval == 0`. Its `signature = Ed25519.sign(b"FS1-CKPT" || utf8(session_id) || u64(seq) || chain_hash[i])`.
8. **Seal record** (written when a session stops) — `signature = Ed25519.sign(b"FS1-SEAL" || utf8(session_id) || u64(last_seq) || chain_hash[last_seq] || u64(frame_count))`.

### 3.9 Golden test vectors (must pass in `backend/tests/test_vectors.py`)

Inputs: Ed25519 private key seed = bytes `00 01 02 … 1f` (i.e. `bytes(range(32))`), `session_id = "00000000-0000-4000-8000-000000000000"`, `checkpoint_interval = 2`.

| Field | Input / expected value |
| --- | --- |
| payload[0] | ASCII bytes `FRAMESEAL-TEST-FRAME-0` |
| payload[1] | ASCII bytes `FRAMESEAL-TEST-FRAME-1` |
| dhash[0] (given) | `0123456789abcdef` |
| dhash[1] (given) | `fedcba9876543210` |
| ts_ns[0] | `1700000000000000000` |
| ts_ns[1] | `1700000000066666667` |
| public_key_hex | `03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8` |
| device_id | `56475aa75463474c` |
| genesis | `6a75375daf786e83a0ee0a71865a45b3f9d3593793fdc4fed4c289a7694e0b25` |
| frame_hash[0] | `8efd46fc5305bce23ec70fbea7dcc95da5926254566d87ee55f03e91ec89bbd6` |
| chain_hash[0] | `bb2024f02c75f2543ff03a27d968d0ef7f789423ac4f5ef87e66763a68e0e1a8` |
| frame_hash[1] | `b1321fed1afd4c4d85ccf39826f280e2f541bbd7e5adf8d4d9c26e6772730fb3` |
| chain_hash[1] | `afa92d71ea51bceedde7a5a4607adf18da7154f482d14b2ef1e2dfa1d4798584` |
| signature[1] (seq 1 is a checkpoint) | `a2db8ebae297d0833415eb8e53081ce2dca24e05106bee1fc065a540eaef55231c8670554deb4d9c1e41083bd9bcfd0696490f4066f2679d116c65d14af7b601` |
| dhash of test image | `f7f7efdeddbd7bf7` — image = uint8 array, 8 rows × 9 cols, `px[r][c] = (r*37 + c*53) % 256` |

Ed25519 signatures are deterministic, so `signature[1]` must match byte-for-byte.

## 4. Packet header (ChainRecord)

```json
{
  "session_id": "uuid",
  "seq": 0,
  "ts_ns": 1700000000000000000,
  "prev_hash": "64 hex",
  "frame_hash": "64 hex",
  "dhash": "16 hex",
  "chain_hash": "64 hex",
  "is_checkpoint": false,
  "signature": null
}
```

`signature` is a 128-hex string on checkpoints, otherwise `null`. The producer appends every header (as one JSON line) to the session ledger `ledger.jsonl`.

## 5. Verifier rules

State: `anchor` (starts at genesis), `expected_seq` (starts at 0), `seen` (seq → chain_hash, last 900 entries), `window` (seqs since the last checkpoint), `window_failures`, `reanchored_in_window`, `open_incident`, `last_delivery_time`.

For each packet coming out of the channel, in this order:

1. **Late or repeated seq** (`seq < expected_seq`):
   - `seq` in `seen` with the same `chain_hash` → **REPLAY_DETECTED**. Do not change that seq's timeline status (the original was genuine).
   - `seq` in `seen` with a different `chain_hash` → **FRAME_INSERTED**. Set that seq's status to `tampered`.
   - `seq` not in `seen` (it was missing) → **FRAME_REORDERED**. Set its status to `tampered`. If the open incident's kind is FRAME_DELETED, re-classify it to FRAME_REORDERED.
   - Stop here: the packet is shown with verdict `tampered` but never enters the chain.
2. **Gap** (`seq > expected_seq`) → **FRAME_DELETED**. Mark every seq in `[expected_seq, seq-1]` as `missing`.
3. **Payload** — if `H(payload) != header.frame_hash` → **FRAME_MODIFIED**. Also compute `visual_change_pct = hamming(dhash(payload), header.dhash) / 64 * 100`.
4. **Header consistency** — recompute `chain_hash` from the header fields (§3.6). Mismatch → **CHAIN_BROKEN**.
5. **Link** — if `header.prev_hash != anchor`: if no gap was found in step 2, record **CHAIN_BROKEN**. Then *re-anchor*: every frame in the current window still `pending` becomes `unverified`, clear the window, set `reanchored_in_window = true`.
6. **Accept** — `anchor = header.chain_hash`, `expected_seq = seq + 1`, `seen[seq] = chain_hash`, add seq to the window. Status = `tampered` if step 3 failed, else `pending`.
7. **Checkpoint** — if `is_checkpoint`: verify the signature over `chain_hash` (§3.7). A missing signature counts as invalid.
   - Valid → every `pending` frame in the window becomes `sealed`. Send a `seal` message (valid = true). If an incident is open AND `window_failures == 0` AND `reanchored_in_window == false`, close the incident.
   - Invalid → every frame in the window becomes `tampered`. Record **CHAIN_FORGED**. Send a `seal` message (valid = false).
   - Then reset `window`, `window_failures`, `reanchored_in_window`.
8. **Watchdog** — if no packet reaches the verifier for `2 × checkpoint_interval / fps` seconds (2 s by default) → **STREAM_INTERRUPTED**, once per silence. The pipeline calls `verifier.tick(now)` on every producer tick, so no extra timer is needed.

Every failure increments `window_failures` and is added to the open incident, or opens a new one (§6).

**Timeline statuses** (per seq): `pending` (hash and link OK, waiting for the seal), `sealed` (covered by a valid signature), `unverified` (genuine-looking but its link to a signature was cut by a break), `tampered`, `missing`.

## 6. Incidents

```json
{
  "id": "inc_0001",
  "kind": "FRAME_MODIFIED",
  "kinds_seen": ["FRAME_MODIFIED"],
  "severity": "critical",
  "status": "open",
  "title": "Frame content altered",
  "explanation": "Plain-English sentence a judge understands.",
  "proof": "SHA-256(received frame) = 9f3a…  ≠  camera's recorded hash 1c7e…",
  "seq_from": 1234,
  "seq_to": 1263,
  "affected_count": 30,
  "missing_count": 0,
  "opened_at": "2026-11-18T10:20:30.123Z",
  "closed_at": null,
  "detection_latency_ms": 38,
  "attack_id": "atk_0003",
  "attack_type": "PIXEL_TAMPER",
  "evidence": {
    "sample_seq": 1234,
    "expected_hash": "64 hex or null",
    "actual_hash": "64 hex or null",
    "expected_prev": "64 hex or null",
    "actual_prev": "64 hex or null",
    "visual_change_pct": 23.4
  },
  "acknowledged": false
}
```

- `kind` = the first failure's kind (only exception: FRAME_DELETED → FRAME_REORDERED, rule 5.1).
- `severity` = `warning` for STREAM_INTERRUPTED, `critical` for everything else.
- `detection_latency_ms` = time from the attack engine's first effect to the incident opening (null if no attack was launched through the API).
- Kinds: `FRAME_MODIFIED`, `FRAME_DELETED`, `FRAME_INSERTED`, `FRAME_REORDERED`, `REPLAY_DETECTED`, `CHAIN_FORGED`, `CHAIN_BROKEN`, `STREAM_INTERRUPTED`.

## 7. Attacks (channel)

| type | label | What the attacker does | Must be detected as | When |
| --- | --- | --- | --- | --- |
| `PIXEL_TAMPER` | Erase an object | Blurs a central region (40% wide, 40% tall) of the next 30 frames, re-encodes JPEG, leaves headers untouched | FRAME_MODIFIED | same frame |
| `FRAME_DROP` | Delete frames | Silently drops the next 10 packets | FRAME_DELETED | first frame after the gap |
| `FRAME_INSERT` | Insert a fake frame | Before the next packet (seq k) sends a foreign synthetic frame claiming seq k, with a self-consistent header linked to the last forwarded chain hash | FRAME_INSERTED | when the genuine seq k arrives |
| `FRAME_REORDER` | Swap two frames | Holds packet k, sends k+1, then k | FRAME_REORDERED | next frame |
| `LOOP_REPLAY` | Loop old footage | Drops the next 45 live packets and sends the last 45 forwarded packets again instead (the classic heist "loop the CCTV") | REPLAY_DETECTED | first replayed frame |
| `CHAIN_FORGE` | Smart forgery | Draws a black box on frames AND recomputes `frame_hash`, `dhash`, `prev_hash`, `chain_hash` so every per-frame check passes; keeps the original signature (it has no private key); runs for at least 5 frames, until a checkpoint packet has been forwarded | CHAIN_FORGED | at the next checkpoint (≤ 1 s) |
| `STREAM_CUT` | Cut the feed | Drops all packets for 4 seconds | STREAM_INTERRUPTED | after 2 s of silence |

Only one attack runs at a time; launching while one is active returns HTTP 409. Every attack must end with exactly **one** incident of the listed kind, closed within about 2 seconds of the attack ending (enforced by `backend/tests/test_attacks.py`).

## 8. REST API

| Method + path | Body | Returns |
| --- | --- | --- |
| `GET /api/health` | — | `{"status": "ok", "version": "1.0"}` |
| `GET /api/device` | — | `Device` |
| `GET /api/session` | — | `Session` (status `idle` if none started) |
| `POST /api/session/start` | `StartRequest` | `Session` (stops a running session first) |
| `POST /api/session/stop` | — | `Session` with `seal` |
| `GET /api/stats` | — | `Stats` |
| `GET /api/attacks/catalog` | — | `AttackInfo[]` (the 7 rows of §7) |
| `POST /api/attacks` | `{"type": "PIXEL_TAMPER", "params": {}}` | `AttackAck`; 409 if one is active or no session is running |
| `GET /api/incidents` | — | `Incident[]`, newest first |
| `POST /api/incidents/{id}/ack` | — | `Incident` |
| `GET /api/chain?limit=50` | — | `ChainRecord[]`, newest first |
| `GET /api/frames/{seq}/original.jpg` | — | JPEG from the camera-side vault (404 if absent) |
| `GET /api/frames/{seq}/received.jpg` | — | JPEG the verifier received, stored only for tampered frames (404 if absent) |
| `GET /api/frames/{seq}/diff.png` | — | heatmap of `absdiff(original, received)` blended over the original (404 if either is absent) |
| `POST /api/evidence/export` | — | `ExportResult` |
| `GET /api/evidence/download/{filename}` | — | the zip file |
| `POST /api/evidence/verify` | multipart form, field `file` (zip) | `VerificationReport` |
| `POST /api/evidence/tamper-sample` | `{"mode": "modify" \| "delete" \| "truncate"}` | `ExportResult` for a deliberately tampered copy of the latest export |
| `GET /api/reports/{report_id}` | — | `VerificationReport` |

Errors: `{"detail": "human readable message"}` with a 4xx/5xx status.

### Types

```ts
type Device = { device_id: string; public_key_hex: string; algorithm: "Ed25519"; created_at: string };

type StartRequest = {
  source: "webcam" | "file" | "synthetic"; camera_index?: number; file_path?: string | null;
  fps?: number; width?: number; height?: number; jpeg_quality?: number; checkpoint_interval?: number;
};

type Session = {
  session_id: string | null; status: "idle" | "running" | "stopped";
  source: "webcam" | "file" | "synthetic" | null; source_label: string | null;
  fps: number; width: number; height: number; checkpoint_interval: number;
  started_at: string | null; stopped_at: string | null; device_id: string;
  seal: { last_seq: number; chain_hash: string; frame_count: number; signature: string } | null;
};

type Stats = {
  integrity: "IDLE" | "SECURE" | "COMPROMISED";          // COMPROMISED while an incident is open
  fps_actual: number; uptime_s: number;
  frames_produced: number; frames_delivered: number;
  frames_sealed: number; frames_pending: number; frames_unverified: number;
  frames_tampered: number; frames_missing: number;
  checkpoints_ok: number; checkpoints_failed: number;
  avg_hash_ms: number; avg_sign_ms: number; avg_verify_ms: number;
  chain_head: string | null; open_incident_id: string | null; incidents_total: number;
  last_detection_latency_ms: number | null;
};

type AttackType = "PIXEL_TAMPER" | "FRAME_DROP" | "FRAME_INSERT" | "FRAME_REORDER" | "LOOP_REPLAY" | "CHAIN_FORGE" | "STREAM_CUT";
type AttackInfo = { type: AttackType; label: string; description: string; expected_kind: string };
type AttackAck = { attack_id: string; type: AttackType; label: string; started_at: string; expected_kind: string };

type ExportResult = { filename: string; download_url: string; size_bytes: number; package_sha256: string; frame_count: number; description?: string };

type VerificationReport = {
  report_id: string; verdict: "AUTHENTIC" | "TAMPERED" | "INCOMPLETE";
  package_filename: string; package_sha256: string;
  session_id: string; device_id: string; public_key_hex: string;
  first_frame_at: string | null; last_frame_at: string | null;
  frames_total: number; frames_ok: number; frames_tampered: number; frames_missing: number;
  checkpoints_total: number; checkpoints_valid: number; seal_valid: boolean;
  chain_head: string | null; incidents: Incident[]; verified_at: string; verify_ms: number;
};
```

`INCOMPLETE` = no tampering found but the seal record is missing or does not match the last frame (truncated recording).

## 9. WebSocket `/ws/live` (server → client, JSON text messages)

| `type` | Payload | When |
| --- | --- | --- |
| `hello` | `{ session: Session, device: Device, catalog: AttackInfo[] }` | on connect |
| `frame` | `{ seq, ts_ns, jpeg_b64, verdict: "ok" \| "tampered", reasons: string[], frame_hash, computed_hash, prev_hash, chain_hash, dhash, is_checkpoint, hash_ms, verify_ms }` | every packet the verifier receives (including replayed or inserted ones) |
| `status` | `{ updates: [{ seq, status }] }` | whenever any seq's timeline status changes |
| `seal` | `{ seq, valid, window_from, window_to, chain_hash, signature, verify_ms }` | every checkpoint |
| `incident` | `{ incident: Incident }` | on open, on every update, on close (same `id`; client upserts) |
| `stats` | `{ stats: Stats }` | once per second |
| `session` | `{ session: Session }` | on start and stop |
| `attack` | `{ attack: AttackAck, phase: "started" \| "ended" }` | when an attack starts and ends |

The client sends nothing. A slow client must never slow the capture loop: per-client queue of 60 messages, drop the oldest `frame` messages first.

## 10. Evidence package (zip)

```
frameseal_<session_id>.zip
├── session.json        Session + Device (public key) + capture settings
├── ledger.jsonl        one ChainRecord per line, ordered by seq
├── seal.json           the seal record (§3.8)
├── frames/00000000.jpg original payload bytes, named by seq (8 digits)
└── README.txt          how to verify with tools/verify_package.py
```

Offline verification = the §5 rules applied to ledger + frame files in seq order, plus: a frame file missing → FRAME_DELETED; a ledger line missing → gap → FRAME_DELETED; seal mismatch or absent → verdict INCOMPLETE. `package_sha256` = SHA-256 of the whole zip file (the value a Section 63(4) BSA certificate asks for).

`tamper-sample` modes: `modify` = blur frame at 40% of the recording; `delete` = remove 10 consecutive frames (files + ledger lines) at 50%; `truncate` = drop the last 30 frames and their ledger lines (seal left in place).

## 11. Files on disk (backend)

```
backend/data/keys/device_ed25519.pem
backend/data/sessions/<session_id>/{session.json, ledger.jsonl, seal.json, frames/, received/}
backend/data/exports/*.zip
```

`backend/data/` is git-ignored.

## 12. Change log

| Version | Change | Approved by |
| --- | --- | --- |
| 1.0 | Initial contract | human |
