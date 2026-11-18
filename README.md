# FrameSeal — hackathon starter kit

Specs only, no code: the AI agents write all the code during the hackathon.
Check your hackathon's rules on pre-prepared material; if in doubt, show the organisers this kit (it contains a written spec and prompts, nothing executable).

## What's here

| File | Who reads it | Purpose |
| --- | --- | --- |
| `CONTRACT.md` | both agents + you | The single source of truth: crypto bytes, golden test vectors, verifier rules, attacks, REST + WebSocket API |
| `AGENTS.md` | Codex (backend agent) | Scope, stack, layout and rules for `/backend` |
| `CLAUDE.md` | Claude Code (frontend agent) | Scope, stack, design system and rules for `/frontend` |
| `PROMPTS.md` | you | Every prompt, in order, with acceptance checks |
| `.gitignore` | git | Keeps venv, node_modules and recorded data out of git |
| `demo/` | backend | Put `sample.mp4` here (fallback camera source) |

## Start (T+0:00)

```powershell
mkdir frameseal; cd frameseal
# copy the contents of this kit into the folder
git init; git add -A; git commit -m "Starter kit: contract and agent rules"
code .
```

Open two terminals in VS Code at the repo root:
- Terminal A: `claude` → paste **C0**
- Terminal B: `codex` → paste **X0**

Then follow `PROMPTS.md` top to bottom.
