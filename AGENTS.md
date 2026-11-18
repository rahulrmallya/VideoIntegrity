# Rules for the BACKEND agent (Codex)

Project: **FrameSeal** — live video tamper detection with per-frame SHA-256, a hash chain and Ed25519-signed checkpoints.
Hackathon prototype, 8-hour build, demoed live on one Windows 11 laptop (AMD Ryzen AI 7 350, 24 GB RAM). Must run fully offline.

## Scope
- Ignore `CLAUDE.md`: it holds the rules for the frontend agent, not for you.
- You own `/backend` and `/scripts`. Never edit `/frontend`, `CONTRACT.md`, `AGENTS.md` or `CLAUDE.md`.
- `CONTRACT.md` is the source of truth for every byte, field name, endpoint and message. Follow it exactly.
- If the contract is ambiguous or impossible, STOP and write: "CONTRACT CHANGE NEEDED: <exact change and why>". Do not invent fields.

## Stack (do not add others without asking)
Python 3.11 or 3.12 · FastAPI · uvicorn[standard] · opencv-python · numpy · cryptography · python-multipart · pydantic v2 · pytest · httpx.
No database, no Docker, no GPU/CUDA, no cloud calls, no blockchain.

## Code layout
```
backend/
  app/main.py          FastAPI app, routes, WebSocket, startup/shutdown
  app/config.py        settings and paths
  app/crypto.py        sha256, dhash, genesis, link, sign/verify, key load/create
  app/sources.py       webcam / file / synthetic frame sources
  app/producer.py      builds packets (header + jpeg)
  app/channel.py       pass-through + attack engine
  app/verifier.py      CONTRACT §5 state machine
  app/incidents.py     incident grouping (CONTRACT §6)
  app/pipeline.py      capture thread: source → producer → channel → verifier → broadcaster
  app/broadcaster.py   WebSocket fan-out with bounded per-client queues
  app/vault.py         session folders, ledger, originals, received frames
  app/evidence.py      export / verify / tamper-sample / reports
  app/models.py        pydantic models mirroring CONTRACT §8 types
  tests/               pytest
tools/verify_package.py  standalone offline verifier (no FastAPI import)
```

## Engineering rules
- Windows-safe code: `pathlib`, no POSIX-only calls. Webcam: `cv2.VideoCapture(index, cv2.CAP_DSHOW)`.
- The capture loop runs in ONE background thread. It never awaits or blocks on WebSockets; it hands messages to the asyncio loop with `loop.call_soon_threadsafe`.
- Every source must fall back: webcam fails → file (`demo/sample.mp4`, looped) → synthetic. Log which one is used.
- Use `logging`, not `print`. Type hints and short docstrings everywhere.
- Keep memory bounded: ring buffers and caps on every list that grows with time.

## After every task
1. Run `python -m pytest -q` inside `/backend` and paste the summary.
2. List every file you created or changed.
3. Give the exact commands to run what you built.
4. Do NOT run `git commit` or `git push`. The human commits.
