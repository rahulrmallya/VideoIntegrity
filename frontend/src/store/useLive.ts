// The one live store. Fed only by `live` (real socket or mock) plus a REST hydrate on hello.
// Components subscribe through the narrow selector hooks at the bottom so the 15 fps frame
// stream only re-renders what shows the frame.

import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { api, live } from '../api/backend'
import type { ConnectionState } from '../api/live'
import type {
  AttackAck,
  AttackInfo,
  ChainRecord,
  Device,
  FrameMessage,
  Incident,
  LiveMessage,
  SealMessage,
  Session,
  Stats,
  TimelineStatus,
} from '../api/types'

export const TIMELINE_LIMIT = 900
export const CHAIN_LIMIT = 12
export const SEAL_LIMIT = 20
const INCIDENT_LIMIT = 200

export type LatestFrame = Omit<FrameMessage, 'type'>

export type LiveState = {
  connection: ConnectionState
  session: Session | null
  device: Device | null
  catalog: AttackInfo[]
  stats: Stats | null
  frame: LatestFrame | null
  /** seq → status, last 900 seqs. Replaced (new Map) on every change. */
  timeline: Map<number, TimelineStatus>
  /** Highest seq seen on the timeline (−1 = none). */
  timelineHead: number
  /** Newest first, last 12 received headers. */
  chain: ChainRecord[]
  /** Newest first, last 20. */
  seals: SealMessage[]
  /** Newest first, upserted by id. */
  incidents: Incident[]
  activeAttack: AttackAck | null
}

const initial: LiveState = {
  connection: 'closed',
  session: null,
  device: null,
  catalog: [],
  stats: null,
  frame: null,
  timeline: new Map(),
  timelineHead: -1,
  chain: [],
  seals: [],
  incidents: [],
  activeAttack: null,
}

export const useLive = create<LiveState>()(() => initial)

const set = useLive.setState
const get = useLive.getState

function upsertIncidents(list: Incident[], incoming: Incident[]): Incident[] {
  const next = [...list]
  for (const inc of incoming) {
    const i = next.findIndex((x) => x.id === inc.id)
    if (i >= 0) next[i] = inc
    else next.unshift(inc)
  }
  next.sort((a, b) => (a.opened_at < b.opened_at ? 1 : a.opened_at > b.opened_at ? -1 : 0))
  return next.length > INCIDENT_LIMIT ? next.slice(0, INCIDENT_LIMIT) : next
}

/** Clear per-session data when a different session shows up. */
function onSession(session: Session) {
  const prev = get().session
  if (session.session_id && session.session_id !== prev?.session_id) {
    set({ session, frame: null, timeline: new Map(), timelineHead: -1, chain: [], seals: [], activeAttack: null })
  } else {
    set({ session })
  }
}

async function hydrate() {
  try {
    const [incidents, stats] = await Promise.all([api.getIncidents(), api.getStats()])
    set((s) => ({ incidents: upsertIncidents(s.incidents, [...incidents].reverse()), stats }))
  } catch {
    // the live stream will fill these in
  }
}

export function handleLiveMessage(msg: LiveMessage) {
  switch (msg.type) {
    case 'hello':
      onSession(msg.session)
      set({ device: msg.device, catalog: msg.catalog })
      void hydrate()
      return

    case 'frame': {
      const { type: _type, ...frame } = msg
      const s = get()
      const record: ChainRecord = {
        session_id: s.session?.session_id ?? '',
        seq: frame.seq,
        ts_ns: frame.ts_ns,
        prev_hash: frame.prev_hash,
        frame_hash: frame.frame_hash,
        dhash: frame.dhash,
        chain_hash: frame.chain_hash,
        is_checkpoint: frame.is_checkpoint,
        signature: null,
      }
      const chain = [record, ...s.chain]
      if (chain.length > CHAIN_LIMIT) chain.length = CHAIN_LIMIT
      set({ frame, chain })
      return
    }

    case 'status': {
      const s = get()
      const timeline = new Map(s.timeline)
      let head = s.timelineHead
      for (const u of msg.updates) {
        timeline.set(u.seq, u.status)
        if (u.seq > head) head = u.seq
      }
      if (timeline.size > TIMELINE_LIMIT) {
        const min = head - TIMELINE_LIMIT + 1
        for (const seq of timeline.keys()) if (seq < min) timeline.delete(seq)
      }
      set({ timeline, timelineHead: head })
      return
    }

    case 'seal': {
      const s = get()
      const seals = [msg, ...s.seals]
      if (seals.length > SEAL_LIMIT) seals.length = SEAL_LIMIT
      // attach the signature to the matching chain record
      const chain = s.chain.map((r) =>
        r.seq === msg.seq && r.chain_hash === msg.chain_hash ? { ...r, signature: msg.signature } : r,
      )
      set({ seals, chain })
      return
    }

    case 'incident':
      set((s) => ({ incidents: upsertIncidents(s.incidents, [msg.incident]) }))
      return

    case 'stats':
      set({ stats: msg.stats })
      return

    case 'session':
      onSession(msg.session)
      return

    case 'attack':
      if (msg.phase === 'started') set({ activeAttack: msg.attack })
      else if (get().activeAttack?.attack_id === msg.attack.attack_id) set({ activeAttack: null })
      return
  }
}

let started = false

/** Wire the store to the live connection. Call once at startup (outside React). */
export function startLive(): () => void {
  if (started) return () => {}
  started = true
  const offMsg = live.onMessage(handleLiveMessage)
  const offState = live.onState((connection) => set({ connection }))
  set({ connection: live.getState() })
  live.connect()
  return () => {
    offMsg()
    offState()
    live.close()
    started = false
  }
}

// --- selector hooks ------------------------------------------------------------------------------

export const useConnection = () => useLive((s) => s.connection)
export const useSession = () => useLive((s) => s.session)
export const useDevice = () => useLive((s) => s.device)
export const useCatalog = () => useLive((s) => s.catalog)
export const useStats = () => useLive((s) => s.stats)
export const useFrame = () => useLive((s) => s.frame)
export const useChain = () => useLive((s) => s.chain)
export const useSeals = () => useLive((s) => s.seals)
export const useLatestSeal = () => useLive((s) => s.seals[0] ?? null)
export const useIncidents = () => useLive((s) => s.incidents)
export const useOpenIncident = () => useLive((s) => s.incidents.find((i) => i.status === 'open') ?? null)
export const useActiveAttack = () => useLive((s) => s.activeAttack)
export const useIntegrity = () => useLive((s) => s.stats?.integrity ?? 'IDLE')
export const useTimeline = () => useLive(useShallow((s) => ({ timeline: s.timeline, head: s.timelineHead })))
/** Status of a single seq — re-renders only when that seq changes. */
export const useSeqStatus = (seq: number) => useLive((s) => s.timeline.get(seq) ?? null)
