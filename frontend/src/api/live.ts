// WebSocket client for /ws/live (CONTRACT §9). Server → client only; auto-reconnects 1 s → 5 s.

import type { LiveMessage, LiveMessageType } from './types'

export type ConnectionState = 'connecting' | 'open' | 'closed'

/** Shared by the real socket and the mock. */
export interface LiveConnection {
  connect(): void
  close(): void
  getState(): ConnectionState
  /** Returns an unsubscribe function. */
  onMessage(cb: (msg: LiveMessage) => void): () => void
  onState(cb: (state: ConnectionState) => void): () => void
}

const KNOWN_TYPES: ReadonlySet<LiveMessageType> = new Set<LiveMessageType>([
  'hello',
  'frame',
  'status',
  'seal',
  'incident',
  'stats',
  'session',
  'attack',
])

export function parseLiveMessage(raw: unknown): LiveMessage | null {
  if (typeof raw !== 'string') return null
  try {
    const msg: unknown = JSON.parse(raw)
    if (msg && typeof msg === 'object' && 'type' in msg && KNOWN_TYPES.has((msg as { type: LiveMessageType }).type)) {
      return msg as LiveMessage
    }
  } catch {
    // ignore malformed frames
  }
  return null
}

export function liveUrl(path = '/ws/live'): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}${path}`
}

const BACKOFF_MIN_MS = 1000
const BACKOFF_MAX_MS = 5000

export function createLiveConnection(url: string = liveUrl()): LiveConnection {
  const messageListeners = new Set<(msg: LiveMessage) => void>()
  const stateListeners = new Set<(state: ConnectionState) => void>()
  let state: ConnectionState = 'closed'
  let ws: WebSocket | null = null
  let wanted = false
  let backoff = BACKOFF_MIN_MS
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  const setState = (next: ConnectionState) => {
    if (next === state) return
    state = next
    stateListeners.forEach((cb) => cb(next))
  }

  const scheduleRetry = () => {
    if (!wanted || retryTimer) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      open()
    }, backoff)
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
  }

  const open = () => {
    if (!wanted) return
    setState('connecting')
    let socket: WebSocket
    try {
      socket = new WebSocket(url)
    } catch {
      setState('closed')
      scheduleRetry()
      return
    }
    ws = socket
    socket.onopen = () => {
      backoff = BACKOFF_MIN_MS
      setState('open')
    }
    socket.onmessage = (ev) => {
      const msg = parseLiveMessage(ev.data)
      if (msg) messageListeners.forEach((cb) => cb(msg))
    }
    socket.onclose = () => {
      if (ws !== socket) return
      ws = null
      setState('closed')
      scheduleRetry()
    }
    socket.onerror = () => {
      // onclose follows and handles the retry
    }
  }

  return {
    connect() {
      if (wanted) return
      wanted = true
      backoff = BACKOFF_MIN_MS
      open()
    },
    close() {
      wanted = false
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = null
      const socket = ws
      ws = null
      socket?.close()
      setState('closed')
    },
    getState: () => state,
    onMessage(cb) {
      messageListeners.add(cb)
      return () => messageListeners.delete(cb)
    },
    onState(cb) {
      stateListeners.add(cb)
      return () => stateListeners.delete(cb)
    },
  }
}
