# FrameSeal

FrameSeal detects tampering in live video. It fingerprints each JPEG with SHA-256, links the fingerprints into a hash chain, and signs periodic checkpoints with Ed25519. The viewer checks the stream with the camera’s public key and groups failures into incidents. Exported camera originals can be verified offline.

## Quick start on Windows

Install Python 3.11 or 3.12 and Node.js. The launchers install missing dependencies on first use. Capture, attacks, and verification run offline after setup.

```powershell
Set-Location C:\path\to\VideoIntegrity
powershell -ExecutionPolicy Bypass -File .\scripts\start-demo.ps1
# In the browser, choose a capture source and start a session.
```

The demo serves the app, API, and WebSocket at [127.0.0.1:8000](http://127.0.0.1:8000). For development, run `powershell -ExecutionPolicy Bypass -File .\scripts\start.ps1` to launch FastAPI and Vite in separate windows and open [localhost:5173](http://localhost:5173).

## Architecture

```text
Webcam / file / synthetic
           |
           v
Producer: JPEG -> SHA-256 + dHash -> hash chain -> signed checkpoints
           |                                      |
           |                                      +--> Vault: originals, ledger, seal
           v                                                   |
Channel: optional demo attack                                  v
           |                                             Evidence ZIP
           v                                                   |
Verifier: public-key checks -> incidents -> WebSocket -> UI    +--> Offline verifier
```

## Demo attacks

| Attack | Default action | Expected incident |
|---|---|---|
| `PIXEL_TAMPER` | Blur the center of 30 frames and keep their headers | `FRAME_MODIFIED` |
| `FRAME_DROP` | Drop 10 packets | `FRAME_DELETED` |
| `FRAME_INSERT` | Insert a synthetic frame claiming the next sequence number | `FRAME_INSERTED` |
| `FRAME_REORDER` | Swap two consecutive packets | `FRAME_REORDERED` |
| `LOOP_REPLAY` | Replay the last 45 forwarded packets in place of live packets | `REPLAY_DETECTED` |
| `CHAIN_FORGE` | Alter pixels and recompute hashes for at least five frames through a checkpoint while retaining its signature | `CHAIN_FORGED` |
| `STREAM_CUT` | Drop all packets for four seconds | `STREAM_INTERRUPTED` |

## Verify a package offline

Stop capture to create the final seal, then export the evidence ZIP. Copy the ZIP to a machine with the backend dependencies installed and run the verifier from the repository root.

```powershell
.\backend\.venv\Scripts\python.exe .\backend\tools\verify_package.py C:\path\to\package.zip
```

Exit codes are `0` for `AUTHENTIC`, `1` for `TAMPERED`, and `2` for `INCOMPLETE`. Compare the package’s device ID and public key with a trusted copy from the camera.

With a backend running, use `.\backend\.venv\Scripts\python.exe .\scripts\smoke_test.py` to exercise the live attack and evidence flow.
