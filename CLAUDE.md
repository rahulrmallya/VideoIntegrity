# Rules for the FRONTEND agent (Claude Code)

Project: **FrameSeal** — live video tamper detection with per-frame SHA-256, a hash chain and Ed25519-signed checkpoints.
Hackathon prototype, 8-hour build, demoed live to judges on one Windows 11 laptop, often on a projector. Must run fully offline.

## Scope
- Ignore `AGENTS.md`: it holds the rules for the backend agent, not for you.
- You own `/frontend`. Never edit `/backend`, `/scripts`, `CONTRACT.md`, `AGENTS.md` or `CLAUDE.md`.
- `CONTRACT.md` is the source of truth for every endpoint, field name and WebSocket message. Mirror its types exactly in `src/api/types.ts`.
- If the contract is ambiguous or impossible, STOP and write: "CONTRACT CHANGE NEEDED: <exact change and why>". Do not invent fields.

## Stack (do not add others without asking)
Vite + React + TypeScript (strict) · Tailwind CSS v4 via `@tailwindcss/vite` (no tailwind.config.js) · `motion` (Framer Motion, import from `motion/react`) · `lucide-react` · `zustand` · `@fontsource/inter` · `@fontsource/jetbrains-mono`.
No CDN links, no Google Fonts URLs, no UI kits that fetch at runtime.

## Architecture
- `src/api/types.ts` — contract types. `src/api/client.ts` — REST. `src/api/live.ts` — WebSocket with auto-reconnect.
- `src/mock/` — a mock backend implementing the same interfaces, selected when the URL has `?mock=1` or `VITE_MOCK=1`. The mock must behave like CONTRACT §5–§9 (frames, status, seal, incidents, stats, attacks).
- `src/store/` — one zustand store fed only by `live.ts` / mock. Components never call fetch directly.
- Vite proxy: `/api` and `/ws` → `http://127.0.0.1:8000` (`ws: true`).

## Design system ("control room")
- Background `#070A12`, surface `#0E1422`, raised `#141C2E`, border `#1F2A40`, text `#E6EDF7`, muted `#8A97AD`.
- Status colours (use everywhere, same meaning): sealed `#22C55E`, pending `#22D3EE`, unverified `#F59E0B`, tampered `#EF4444`, missing = hollow `#EF4444` outline on `#1F2A40`.
- Inter for UI, JetBrains Mono for hashes/numbers. Hashes are shown shortened (`9f3a…c71e`) with full value on hover/copy.
- Calm when secure, loud when attacked: red pulse, glitch effect and banner only on tampering.
- Must look right at 1366×768 and 1920×1080 with no page scroll on the Live screen.

## After every task
1. Run `npm run build` inside `/frontend` — it must finish with zero TypeScript errors. Paste the result.
2. List every file you created or changed.
3. Say exactly what the human should click to see the result.
4. Do NOT run `git commit` or `git push`. The human commits.
