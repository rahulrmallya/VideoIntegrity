#!/usr/bin/env node
// Dump the first message of each type from the live WebSocket (jpeg_b64 stripped).
//
//   node scripts/ws-dump.mjs                       listen 8 s on ws://127.0.0.1:8000/ws/live
//   node scripts/ws-dump.mjs --start               POST /api/session/start {"source":"synthetic"} first
//   node scripts/ws-dump.mjs --attack PIXEL_TAMPER POST /api/attacks after 3 s
//   node scripts/ws-dump.mjs --seconds 15 --all    print every message (not just the first per type)
//
// Needs Node 22+ (global WebSocket and fetch). No dependencies.

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const opt = (name, def) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}

const BASE = opt('--base', 'http://127.0.0.1:8000')
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws/live'
const SECONDS = Number(opt('--seconds', '8'))
const ATTACK = opt('--attack', null)
const ALL = flag('--all')

function strip(msg) {
  if (msg && typeof msg === 'object' && typeof msg.jpeg_b64 === 'string') {
    return { ...msg, jpeg_b64: `<${msg.jpeg_b64.length} base64 chars>` }
  }
  return msg
}

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  console.log(`\n# POST ${path} → ${res.status}\n${text}`)
}

if (typeof WebSocket === 'undefined') {
  console.error('This script needs Node 22+ (global WebSocket).')
  process.exit(1)
}

const seen = new Map()
const counts = {}
const ws = new WebSocket(WS_URL)

ws.addEventListener('open', async () => {
  console.log(`# connected to ${WS_URL}`)
  if (flag('--start')) await post('/api/session/start', { source: 'synthetic' })
  if (ATTACK) setTimeout(() => void post('/api/attacks', { type: ATTACK, params: {} }), 3000)
})

ws.addEventListener('message', (ev) => {
  let msg
  try {
    msg = JSON.parse(String(ev.data))
  } catch {
    console.log('# non-JSON message:', String(ev.data).slice(0, 200))
    return
  }
  const type = msg?.type ?? '<no type>'
  counts[type] = (counts[type] ?? 0) + 1
  if (ALL || !seen.has(type)) {
    seen.set(type, true)
    console.log(`\n## ${type}\n${JSON.stringify(strip(msg), null, 2)}`)
  }
})

ws.addEventListener('error', (ev) => {
  console.error('# websocket error', ev.message ?? '')
})

ws.addEventListener('close', (ev) => {
  console.log(`# closed (code ${ev.code})`)
})

setTimeout(() => {
  console.log(`\n# message counts over ${SECONDS} s:`, JSON.stringify(counts))
  ws.close()
  setTimeout(() => process.exit(0), 200)
}, SECONDS * 1000)
