# FrameSeal — copy-paste prompts

Two agents, two folders, one contract.
- **Claude Code** = frontend agent (terminal A, started in the repo root). Reads `CLAUDE.md`.
- **Codex** = backend agent (terminal B, started in the repo root). Reads `AGENTS.md`.
- Paste one prompt at a time per agent. Check its **Acceptance** line yourself, then commit that agent's folder.
- Commit commands: `git add frontend && git commit -m "C1 mock backend"` · `git add backend scripts tools && git commit -m "X2 verifier"`.

---

## X0 — Codex · backend scaffold (T+0:05)

```
Read AGENTS.md and CONTRACT.md fully before doing anything.
Task X0 — scaffold the backend in /backend. Nothing else.
1. backend/requirements.txt: fastapi, uvicorn[standard], opencv-python, numpy, cryptography, python-multipart, pydantic>=2, pytest, httpx.
2. Create the folder layout from AGENTS.md (app/, tests/, tools/) with empty modules that each have a one-line docstring.
3. app/main.py: FastAPI app, CORS for http://localhost:5173, GET /api/health → {"status":"ok","version":"1.0"}, and a WebSocket /ws/live that sends one `hello` message (session status "idle", device placeholder, empty catalog) and stays open until the client leaves.
4. app/models.py: pydantic v2 models for every type in CONTRACT §8 (Device, StartRequest with the defaults from §1, Session, Stats, AttackInfo, AttackAck, ExportResult, Incident, ChainRecord, VerificationReport), field names exactly as in the contract.
5. tests/test_health.py with FastAPI TestClient (health + the WebSocket hello).
6. backend/README.md with Windows PowerShell steps: py -3.12 -m venv .venv ; .\.venv\Scripts\Activate.ps1 ; pip install -r requirements.txt ; uvicorn app.main:app --reload --port 8000
Acceptance: pytest passes; http://127.0.0.1:8000/docs loads.
```

## C0 — Claude Code · frontend scaffold (T+0:05, in parallel with X0)

```
Read CLAUDE.md and CONTRACT.md fully before doing anything.
Task C0 — scaffold the frontend in /frontend. Nothing else.
1. Create a Vite React TypeScript app in /frontend (npm create vite@latest frontend -- --template react-ts), then install: tailwindcss @tailwindcss/vite motion lucide-react zustand @fontsource/inter @fontsource/jetbrains-mono.
2. Tailwind v4 through the Vite plugin only (no tailwind.config.js). Put the design tokens from CLAUDE.md in src/index.css with @theme: colours bg, surface, raised, border, text, muted, sealed, pending, unverified, tampered; fonts sans = Inter, mono = JetBrains Mono (import the @fontsource CSS, no CDN).
3. vite.config.ts: port 5173; proxy /api → http://127.0.0.1:8000 and /ws → ws://127.0.0.1:8000 with ws: true.
4. src/api/types.ts: every type from CONTRACT §8 and every WebSocket message from §9 as a discriminated union `LiveMessage` on `type`.
5. Placeholder App: dark page with "FrameSeal" and the tagline "Every frame sealed. Every edit caught.", one swatch per status colour, one hash in mono — so I can see the setup works.
Acceptance: npm run dev shows the page at http://localhost:5173; npm run build passes with zero errors.
```

## X1 — Codex · crypto core (T+0:20)

```
Task X1 — crypto core, exactly CONTRACT §3. Nothing else.
Implement app/crypto.py with type hints and docstrings:
- sha256(data: bytes) -> bytes
- dhash_from_gray(gray: np.ndarray) -> bytes (8 bytes) and dhash_from_jpeg(jpeg: bytes) -> bytes, per §3.4
- genesis(session_id: str, pk_raw: bytes) -> bytes
- link(prev: bytes, frame_hash: bytes, dhash: bytes, seq: int, ts_ns: int) -> bytes
- checkpoint_message(session_id, seq, chain_hash) -> bytes and seal_message(session_id, last_seq, chain_hash, frame_count) -> bytes
- sign(sk, msg) -> bytes ; verify(pk_raw, sig, msg) -> bool (returns False, never raises, on bad or missing signature)
- load_or_create_device_key(path) -> (sk, pk_raw) storing PKCS8 PEM ; device_id(pk_raw) -> str ; hamming(a: bytes, b: bytes) -> int ; short(hex_str) -> "9f3a…c71e"
Byte layouts must match §3 exactly: domain tags b"FS1-GENESIS", b"FS1-LINK", b"FS1-CKPT", b"FS1-SEAL", u64 = 8-byte big-endian.
Tests:
- tests/test_vectors.py reproduces EVERY value in §3.9 (Ed25519PrivateKey.from_private_bytes(bytes(range(32)))), including the byte-exact signature and the dhash of the 8×9 test image.
- tests/test_crypto.py: one flipped payload byte changes frame_hash; changing seq or ts changes chain_hash; verify() is False for a changed message and for None; dhash of the same JPEG decoded twice is identical; hamming is correct.
Acceptance: all tests pass. If a golden vector does not match, re-read §3 — do not change the expected values.
```

## C1 — Claude Code · data layer + mock backend (T+0:20)

```
Task C1 — data layer and a realistic mock backend. Read CONTRACT.md §5–§9 again first.
1. src/api/client.ts — typed REST functions for every endpoint in CONTRACT §8 (fetch + JSON; on non-2xx throw an Error carrying `detail`). Helpers originalUrl(seq), receivedUrl(seq), diffUrl(seq).
2. src/api/live.ts — WebSocket client for /ws/live (ws:// or wss:// from location), parses LiveMessage, auto-reconnects with backoff 1 s → 5 s, exposes connection state 'connecting' | 'open' | 'closed'.
3. src/mock/ — a MockBackend with the same interface as client.ts + live.ts, used when the URL has ?mock=1 or VITE_MOCK=1. It must feel real:
   - 15 fps frames drawn on an offscreen canvas (dark scene, a moving shape, a running clock, text "MOCK CAMERA"), sent as JPEG base64.
   - Real SHA-256 per frame via crypto.subtle, prev/chain linking, a checkpoint every 15 frames that seals the window.
   - status, seal, stats (1/s), session, attack and incident messages exactly as CONTRACT §9.
   - All 7 attacks of §7 with the same visible effect and the same result as the table: incident kind, which seqs become tampered / missing / unverified, realistic detection_latency_ms (20–60 ms for per-frame attacks, 600–1000 ms for CHAIN_FORGE, ~2000 ms for STREAM_CUT). Each incident closes ~2 s after its attack ends.
   - Evidence endpoints: export returns a plausible ExportResult; verify returns AUTHENTIC for a normal export and TAMPERED/INCOMPLETE for tamper-sample files.
4. src/store/useLive.ts (zustand): session, device, catalog, stats, connection, latest frame (jpeg + verdict + hashes), timeline Map<seq, status> trimmed to the last 900 seqs, last 12 chain records, last 20 seals, incidents (upsert by id, newest first), active attack. Use selectors so 15 fps updates do not re-render the whole app.
5. Debug overlay (only with ?debug=1): message count per type per second.
Acceptance: with ?mock=1&debug=1 I see ~15 frame/s, 1 seal/s, 1 stats/s; calling each mock attack produces exactly one incident of the right kind. npm run build passes.
```

## X2 — Codex · verifier + incidents, pure logic (T+0:45)

```
Task X2 — the producer, verifier and incident manager as pure, fully tested logic (no camera, no web server yet). Follow CONTRACT §3–§6 exactly.
1. app/producer.py: Producer(session_id, sk, pk_raw, checkpoint_interval).make_packet(jpeg_bytes, ts_ns) -> Packet(header: ChainRecord, payload: bytes). Computes frame_hash, dhash from the payload, chain link, signature on checkpoints; records hash_ms and sign_ms.
2. app/verifier.py: Verifier(session_id, pk_raw, checkpoint_interval, fps, clock=time.monotonic).
   process(packet) -> VerifyResult(verdict, reasons, computed_hash, status_updates: list[tuple[int,str]], seal: SealResult | None, verify_ms)
   tick(now) -> watchdog (§5.8).
   Implement §5 steps 1–8 in exactly that order. Keep `seen` bounded to 900 entries.
3. app/incidents.py: IncidentManager — open / update / close per §5.7 and §6, reclassification FRAME_DELETED → FRAME_REORDERED, severity, ids inc_0001…, emits an event on every change. Judge-friendly text per kind:
   FRAME_MODIFIED "Frame content altered" — "The pixels of frame #N don't match the fingerprint the camera recorded. Someone edited this frame after it was captured."
   FRAME_DELETED "Frames deleted" — "K frames (#a–#b) never arrived. The chain jumps over them, so the missing footage is provable."
   FRAME_INSERTED "Fake frame inserted" — "Two different frames claimed to be #N. Only one belongs to the camera's signed chain."
   FRAME_REORDERED "Frames shuffled" — "Frame #N arrived after a later frame. The chain order proves it was moved."
   REPLAY_DETECTED "Old footage replayed" — "The stream is showing frames #a–#b a second time. Someone is looping recorded footage instead of live video."
   CHAIN_FORGED "Forgery caught by signature" — "Every frame hash looked valid, but the camera's signature over the chain does not match. Someone edited frames and recomputed the hashes — they cannot forge the camera's private-key signature."
   CHAIN_BROKEN "Chain broken" — "Frame #N does not link to the previous frame's hash."
   STREAM_INTERRUPTED "Live feed cut" — "No signed frames reached the viewer for X s."
   `proof` = one line with shortened hashes, e.g. "SHA-256(received) 9f3a…c71e ≠ recorded 1c7e…02ab".
4. tests/test_verifier.py with synthetic frames (numpy + cv2.imencode) and checkpoint_interval 15:
   honest 120 packets → 0 incidents and every frame up to the last checkpoint sealed;
   one modified payload → exactly one FRAME_MODIFIED incident that closes after a clean window;
   one dropped packet → FRAME_DELETED; swapped pair → FRAME_REORDERED; an old packet re-sent → REPLAY_DETECTED;
   frames re-hashed by an attacker up to a checkpoint (original signature kept) → CHAIN_FORGED;
   3 s without packets on a fake clock → STREAM_INTERRUPTED.
   Every test asserts exactly ONE incident and its kind.
Acceptance: all tests pass; paste the pytest output.
```

## C2 — Claude Code · Live Monitor screen (T+1:10)

```
Task C2 — the Live Monitor screen, the hero of the demo. Build it on ?mock=1 data and the CLAUDE.md design system.
Layout, no page scroll at 1366×768 and 1920×1080:
- Top bar: logo (lucide ShieldCheck + a small chain-link motif) "FrameSeal", tagline, session pill (● LIVE · fps · source label), device chip (device_id, click to copy), sound toggle, connection dot, and the big INTEGRITY pill: SECURE (green, slow breathing glow) / COMPROMISED (red, pulsing) / IDLE (grey). Start/Stop with a source select (Webcam / Video file / Synthetic).
- Left ≈65%: Video stage — latest frame, 4:3, rounded, with a HUD: frame #seq, timestamp, a shield badge for the current frame (SEALED / PENDING / TAMPERED), "SHA-256 9f3a…c71e" in mono. On a tampered verdict: red inset border pulse, a 300 ms CSS RGB-split glitch, and a top banner "TAMPERING DETECTED — <incident title>" that stays while an incident is open. While STREAM_CUT is open show "NO SIGNAL — last sealed frame #N" over the frozen frame.
- Under the video: Integrity Timeline — one thin bar per seq for the last 450 seqs (30 s), coloured by status (sealed green, pending cyan, unverified amber, tampered red, missing hollow red), diamonds on checkpoints (green valid / red invalid), a legend with live counts. Draw it on ONE <canvas>.
- Right ≈35%: "Live Hash Chain" — the last 6 chain records as stacked blocks, newest on top sliding in (motion). Each block: #seq, frame hash, prev → link icon, chain hash (short, mono). Checkpoint blocks carry a "SIGNED · Ed25519" stamp that turns green on a valid seal and red on an invalid one. A connector line runs between blocks and turns into a red dashed "break" where the chain broke.
- Under the chain: 4 metric tiles — Frames sealed, Avg hash time (ms, 3 decimals), Last detection latency, Checkpoints OK / failed. Mono numbers that animate on change.
- Empty states: no session → centred card "Start a live session" with three source buttons; backend offline → amber banner "Verifier offline — retrying…".
Calm and premium when secure, loud only on tampering. Render the video with requestAnimationFrame so only the newest frame is painted.
Acceptance: with ?mock=1 the screen runs smoothly, every region is filled, and a temporary key T (launches a mock PIXEL_TAMPER) shows the full red state.
```

## X3 — Codex · live pipeline + REST + WebSocket (T+1:30)

```
Task X3 — make it live: camera → producer → vault → channel → verifier → WebSocket, plus the REST API. Follow CONTRACT §1, §8, §9, §11 and the AGENTS.md rules.
1. app/sources.py: WebcamSource (cv2.VideoCapture(index, cv2.CAP_DSHOW), 640×480), FileSource (loops demo/sample.mp4 at the repo root, paced to fps), SyntheticSource (dark gradient, moving circle, live clock, text "SYNTHETIC CAMERA"). open_source(request) falls back webcam → file → synthetic and returns the label actually used.
2. app/vault.py: per-session folder (§11): session.json, ledger.jsonl append, frames/{seq:08d}.jpg originals, received/{seq:08d}.jpg for frames the verifier marked tampered, seal.json on stop.
3. app/channel.py: Channel.process(packet) -> list[Packet], pass-through for now, with a clean hook for the attack engine (next task).
4. app/pipeline.py: Pipeline.start(request) / stop(). One daemon thread paced to fps: read frame → cv2.imencode JPEG (quality) → producer.make_packet → vault → channel → verifier.process for each output packet (verifier.tick when there is none) → build messages (frame with jpeg_b64, status, seal, incident) → loop.call_soon_threadsafe(broadcaster.publish, msg). Stats (§8) once per second. stop() writes the seal (§3.8) and broadcasts a session message. If the camera is slow, skip frames — never queue them.
5. app/broadcaster.py: register/unregister clients, per-client asyncio.Queue(maxsize=60), drop the oldest frame messages when full, one sender task per client.
6. app/main.py: every route in §8 except /api/attacks*, /api/evidence/*, /api/reports/* and diff.png (return 501 for those now). WebSocket /ws/live sends hello on connect. Device key loaded or created at startup.
7. scripts/ws_probe.py: connects for 10 s and prints a count per message type plus one sample of each (jpeg_b64 stripped).
Acceptance (I will run it): uvicorn app.main:app --port 8000 → in /docs POST /api/session/start {"source":"webcam"} → python scripts/ws_probe.py shows ~150 frame, ~10 seal (all valid), ~10 stats, 0 incident. POST /api/session/stop returns a seal. pytest still green.
```

## C3 — Claude Code · attack console, incident feed, forensic drawer (T+1:55)

```
Task C3 — Red Team console, incident feed and forensic drawer (still on ?mock=1).
1. Attack Console (bottom strip of the Live screen, collapsible), title "Red Team Console — try to fool the verifier": 7 cards from the catalog (CONTRACT §7), each with a lucide icon, label, one-line description and shortcut key 1–7. Click → POST /api/attacks. While one runs, that card shows a progress shimmer and the others are disabled; a 409 shows a toast "One attack at a time".
2. Incident Feed (panel beside the console): newest first; each row = severity colour bar, kind icon, title, seq range, a chip "Detected in 38 ms" (for CHAIN_FORGED add "at the next signature", for STREAM_CUT "after 2.0 s of silence"), open/closed state, time ago. Unacknowledged critical incidents glow.
3. Incident Drawer (row click; slides from the right; Esc closes):
   - Title, the plain-English explanation in large readable type, and a "Why we know" box with the proof line.
   - Hash comparison: expected vs actual, character-level diff (same chars muted, different chars red).
   - FRAME_MODIFIED: three images side by side — "Camera original" (/api/frames/{seq}/original.jpg), "What the viewer received" (/received.jpg), "Difference heatmap" (/diff.png) — plus visual_change_pct as a bar.
   - DELETED / REORDERED / REPLAY / INSERTED / FORGED / BROKEN / INTERRUPTED: a mini chain of ~8 blocks around the incident, the broken or forged link in red, missing frames as dashed outlines.
   - Footer: detection latency, the attack that caused it, buttons "Acknowledge" (POST ack) and "Export evidence" (goes to the Evidence screen, built later — stub the navigation).
   In mock mode generate original/received/diff images on a canvas.
4. Toasts (bottom-right) for attack started/ended and incident opened/closed. Alarm: a short two-tone WebAudio beep when an incident opens and the sound toggle is on.
Acceptance: each of the 7 mock attacks launches by click and by key 1–7, produces one incident with the right title, and the drawer shows the right view for its kind. npm run build passes.
```

## C4 — Claude Code · INTEGRATION 1: connect to the real backend (T+2:50)

```
Task C4 — switch from the mock to the real backend, which is now running on http://127.0.0.1:8000 (built by another agent from the same CONTRACT.md). Do not edit /backend.
1. Write frontend/scripts/ws-dump.mjs (Node, no deps beyond the built-in WebSocket or the `ws` package) that prints the first message of each type from ws://127.0.0.1:8000/ws/live with jpeg_b64 stripped. Run it while a session is running, and call every REST endpoint that exists.
2. Compare everything with src/api/types.ts and CONTRACT.md. Fix the frontend where the frontend is wrong. Where the backend deviates from the contract, do NOT work around it silently — list each one as: BACKEND DEVIATION: <endpoint/field> — contract says X, server sends Y.
3. Run the app without ?mock=1 and make the real flow work: Start (webcam) → live video → SECURE pill → timeline fills green one second at a time → chain blocks get green SIGNED stamps → Stop.
Acceptance: the real live flow works end to end. Give me the BACKEND DEVIATION list (or "none") so I can paste it to the backend agent.
```

## X4 — Codex · attack engine (T+3:20)

```
Task X4 — the attack engine (CONTRACT §7) and the attacks API.
1. app/channel.py: an AttackEngine inside Channel implementing exactly the 7 attacks of §7, with the table's numbers as defaults (overridable through params). It tracks the last forwarded header's chain_hash (needed by FRAME_INSERT and CHAIN_FORGE) and a ring buffer of the last 45 forwarded packets (for LOOP_REPLAY). It records first_effect_at (monotonic) and ids atk_0001….
   - PIXEL_TAMPER: GaussianBlur kernel 51 over the central 40%×40% of each affected frame, re-encode JPEG, header untouched.
   - FRAME_INSERT: foreign frame = synthetic "ALL CLEAR" image; header seq = the next packet's seq, prev = last forwarded chain_hash, all hashes self-consistent; then forward the genuine packet.
   - CHAIN_FORGE: black rectangle on each frame + recompute frame_hash, dhash, prev (the attacker's running chain) and chain_hash; keep the original signature field; stop after at least 5 frames once a checkpoint packet has been forwarded.
2. Broadcast `attack` messages (started / ended). Link incidents to attacks: attack_id, attack_type, detection_latency_ms = incident open time − attack first_effect_at.
3. Routes: GET /api/attacks/catalog and POST /api/attacks (409 when an attack is active or no session is running).
4. tests/test_attacks.py: for each attack, run producer → channel → verifier on synthetic frames for 12 s of simulated time on a fake clock (attack at t = 3 s) and assert exactly ONE incident, kind == expected_kind, closed by the end, and honest frames sealed again after recovery. Also assert detection_latency_ms ≤ 100 for PIXEL_TAMPER, FRAME_INSERT, FRAME_REORDER and LOOP_REPLAY, and ≤ 1100 for CHAIN_FORGE.
Acceptance: test_attacks.py passes for all 7. Then live: start a webcam session, POST each attack from /docs, and ws_probe shows its incident.
```

## C5 — Claude Code · Evidence screen + certificate (T+3:20)

```
Task C5 — Evidence screen and printable verification report. Add top navigation: Live · Evidence · How it works (keys L, E, H).
Evidence screen, two columns:
1. "Export signed evidence": a Stop & Export button (stops the session if running, then POST /api/evidence/export); shows filename, frame count, size and the package SHA-256 (mono, copy button); Download button.
2. "Verify a package": drag-and-drop + file picker for .zip → POST /api/evidence/verify. While waiting, an animated progress (frame counter ticking, chain links lighting up). Result: a big rubber-stamp verdict that animates in (AUTHENTIC green / TAMPERED red / INCOMPLETE amber), a stats grid (frames ok / tampered / missing, checkpoints valid, seal valid, verify time), the incident list (reuse the feed rows; clicking opens the drawer with what is available) and "View report".
3. "Judge test": three buttons — "Edit a frame", "Delete frames", "Cut the ending" → POST /api/evidence/tamper-sample (modify / delete / truncate) → download plus a one-click "Verify this copy". Hint text: "Or open the zip, edit any frame in Paint, zip it again and drop it above."
Report view (printable, white A4 with print CSS): "Video Integrity Verification Report", report id, verified at, device id + public key fingerprint, session id, recording start/end, frames total / ok / tampered / missing, method (SHA-256 per frame, hash chain, Ed25519 checkpoint signature every N frames), package SHA-256 and chain head in mono, verdict box, incident table, footnote: "Provides the hash value details for Part A of a Section 63(4) Bharatiya Sakshya Adhiniyam certificate. This is a technical report, not the legal certificate." Print button (window.print()).
Must work on ?mock=1 and on the real backend.
Acceptance: export → verify shows AUTHENTIC; each tamper sample shows TAMPERED or INCOMPLETE with the right frames; the report prints to PDF on one or two pages.
```

## X5 — Codex · evidence export, offline verify, CLI (T+4:30)

```
Task X5 — evidence export, offline verification, tamper samples, diff heatmap, reports and a standalone CLI verifier (CONTRACT §8, §10).
1. app/evidence.py
   - export(session) → zip per §10 in backend/data/exports/, including README.txt on how to verify; ExportResult.package_sha256 = SHA-256 of the zip file.
   - verify(zip_path) → VerificationReport: apply the §5 rules to ledger + frames in seq order using only the public key from session.json (reuse Verifier with a simulated clock); a missing frame file → FRAME_DELETED; a missing ledger line → gap; seal.json missing or not matching (last_seq, chain_hash, frame_count, signature) → INCOMPLETE. Verdict AUTHENTIC / TAMPERED / INCOMPLETE. Keep reports in memory by report_id.
   - tamper_sample(mode) per §10: modify = blur the frame at 40% of the recording; delete = remove 10 frames + their ledger lines at 50%; truncate = drop the last 30 frames + lines, keep seal.json.
   - Reject zips containing ".." or absolute paths; cap total uncompressed size at 2 GB.
2. diff.png: absdiff(original, received) → grayscale → ×4 → cv2.COLORMAP_JET → 50% blend over the original.
3. Routes: POST /api/evidence/export, GET /api/evidence/download/{filename}, POST /api/evidence/verify (multipart field `file`), POST /api/evidence/tamper-sample, GET /api/reports/{report_id}, GET /api/frames/{seq}/diff.png.
4. tools/verify_package.py — standalone CLI that imports only the crypto + verifier modules: `python tools/verify_package.py path\to.zip` prints a coloured summary and exits 0 AUTHENTIC, 1 TAMPERED, 2 INCOMPLETE. This proves verification needs nothing but the public key.
5. tests/test_evidence.py: record 6 s synthetic → export → AUTHENTIC; each tamper mode → the right verdict and the right frame numbers.
Acceptance: pytest green; the CLI works on a real exported zip.
```

## C6 — Claude Code · "How it works" + demo polish (T+4:30)

```
Task C6 — "How it works" screen for non-technical judges, plus demo polish.
1. A 5-step stepper with small animated SVG illustrations (motion): 1 Capture (camera → frame) · 2 Fingerprint (frame → SHA-256) · 3 Chain (every block contains the previous block's hash) · 4 Seal (every second the camera signs the chain head with its private key) · 5 Verify (the viewer needs only the public key). Each step: one sentence plus one "why it matters" line.
2. Interactive mini-chain under the stepper: 8 blocks with real SHA-256 (crypto.subtle) of editable short texts ("frame 1" … "frame 8"); block 8 shows a "Signature ✓" badge. Editing any block turns its hash and every later link red ("chain broken"). A button "Recompute like an attacker" re-hashes everything green again, but block 8's signature badge turns red: "the attacker cannot sign without the camera's private key". This one widget must explain the whole idea in 20 seconds.
3. A compact 4-row "Existing approach → its gap → FrameSeal" table: file hash at export; blockchain anchoring; camera-vendor signed video (needs special cameras); AI forgery detectors (a guess, not a proof).
4. Live-screen polish: Presenter mode (key P) hides debug bits and enlarges the video and the integrity pill; a small "sealed" tick animation each time a checkpoint seals; numbers count up smoothly; a shortcuts overlay on key ?.
Acceptance: someone who has never heard of a hash chain gets the idea from this screen in under a minute. npm run build passes.
```

## X6 — Codex · INTEGRATION 2: smoke test, hardening, one-click start (T+5:20)

```
Task X6 — end-to-end smoke test, hardening and one-click start scripts.
1. scripts/smoke_test.py against the running server: start a synthetic session, wait 3 s, launch each of the 7 attacks in turn (wait until its incident closes, max 10 s each), check the kind; then export → verify (AUTHENTIC) → each tamper-sample → verify (expected verdict). Print a PASS/FAIL table; exit non-zero on any failure.
2. Hardening: webcam disconnect mid-session → log it and switch to synthetic without crashing; starting while running stops the old session cleanly; stopping twice is safe; threads are daemon and joined on shutdown; auto-stop with a seal after 30 min or 30 000 frames; every growing list/dict is bounded.
3. Every 10 s log fps_actual, avg_hash_ms, avg_sign_ms, avg_verify_ms and queue sizes.
4. scripts/start.ps1 (Windows): create the backend venv if missing, install requirements, start uvicorn on 8000 in one window and `npm run dev` in /frontend in another, open http://localhost:5173. scripts/start-demo.ps1: build the frontend, serve frontend/dist from FastAPI at / (static files, SPA fallback) and open http://127.0.0.1:8000 — one process, one URL for the demo.
5. Root README.md: what it is, 3-line quick start, ASCII architecture, the attack table, how to verify a package offline.
Acceptance: python scripts/smoke_test.py prints all PASS; scripts/start-demo.ps1 opens the full app on one URL.
```

## C7 — Claude Code · full end-to-end pass + projector polish (T+5:20)

```
Task C7 — full end-to-end pass on the real backend. Do not edit /backend.
1. With a live webcam session, launch all 7 attacks one after another (wait for each incident to close). For each check: right kind and title, timeline colours per CONTRACT §5, drawer evidence, toasts, banner clears when the incident closes, chain panel shows the break or the red seal.
2. Evidence flow: export → verify (AUTHENTIC) → each tamper sample (TAMPERED / INCOMPLETE) → report print preview.
3. Fix every frontend issue. List backend problems as: BACKEND ISSUE: <what I did> → <what happened> → <expected per contract>.
4. Projector pass: 1366×768 and 1920×1080 at 100% and 125% Windows scaling; minimum text 13 px; muted text contrast ≥ 4.5:1.
5. 30-minute run: memory must stay flat (trim arrays, revoke object URLs, no growing maps).
Acceptance: a PASS/FAIL checklist for the 7 attacks + evidence flow, and npm run build passing.
```

## R1 — Claude Code (fresh session: /clear first) · FINAL REVIEW, feature freeze (T+6:20)

```
Task R1 — final review. FEATURE FREEZE: add nothing new.
Read CONTRACT.md, CLAUDE.md and AGENTS.md, then the code in /backend and /frontend.
Find only what could break or embarrass a live 3-minute demo: crashes, unhandled promise rejections, wrong attack classification, UI states that can get stuck (banner never clears, attack buttons stay disabled), memory growth, Windows path problems, anything that needs the internet.
Output a numbered list ranked by risk, each with file:line and a one-line fix. Then fix only the HIGH items in /frontend yourself. For /backend items, write each fix as a ready-to-paste prompt for the backend agent.
```

---

## Utility prompts (use any time)

**Debug (either agent)**
```
Something is broken. What I did: <steps>. What I saw: <paste the exact error / screenshot description>. What I expected: <expected, cite CONTRACT.md section if relevant>.
Find the root cause before changing code. Make the smallest fix, run the tests/build, and tell me in two lines what was wrong.
```

**Relay a deviation to the backend (Codex)**
```
The frontend agent found these deviations from CONTRACT.md:
<paste the BACKEND DEVIATION / BACKEND ISSUE list>
Fix the backend so it matches the contract exactly. Do not change CONTRACT.md. Run pytest and report.
```

**Approved contract change (paste to BOTH agents)**
```
CONTRACT CHANGE v1.<n> approved and already written into CONTRACT.md §<section>: <one-line summary>.
Update only your side to match. Touch nothing else. Report files changed.
```

**Context getting long / agent confused**
Claude Code: type /clear, then: `Read CLAUDE.md, CONTRACT.md and the current /frontend code. We just finished task <Cn>. Continue with task <Cn+1>: <paste the task>.`
Codex: start a new session, then the same with AGENTS.md and /backend.

**One tool hit its usage limit**
Paste the next prompt into the other tool, starting with: `For this task you are the <FRONTEND|BACKEND> agent: follow the rules in <CLAUDE.md|AGENTS.md> instead of your usual project file.`
