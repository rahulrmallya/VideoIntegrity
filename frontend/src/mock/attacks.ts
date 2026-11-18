// Mock channel attack engine — the 7 attacks of CONTRACT §7, acting on packets between producer and verifier.

import { ApiRequestError } from '../api/client'
import type { AttackAck, AttackInfo, AttackType, LiveMessage } from '../api/types'
import type { AttackLink, MockPacket } from './verifier'

export const CATALOG: AttackInfo[] = [
  {
    type: 'PIXEL_TAMPER',
    label: 'Erase an object',
    description: 'Blurs the central region of the next 30 frames.',
    expected_kind: 'FRAME_MODIFIED',
  },
  {
    type: 'FRAME_DROP',
    label: 'Delete frames',
    description: 'Silently drops the next 10 packets.',
    expected_kind: 'FRAME_DELETED',
  },
  {
    type: 'FRAME_INSERT',
    label: 'Insert a fake frame',
    description: 'Sends a synthetic frame claiming the next genuine sequence.',
    expected_kind: 'FRAME_INSERTED',
  },
  {
    type: 'FRAME_REORDER',
    label: 'Swap two frames',
    description: 'Delivers the next two packets out of order.',
    expected_kind: 'FRAME_REORDERED',
  },
  {
    type: 'LOOP_REPLAY',
    label: 'Loop old footage',
    description: 'Replays the last 45 forwarded packets instead of live footage.',
    expected_kind: 'REPLAY_DETECTED',
  },
  {
    type: 'CHAIN_FORGE',
    label: 'Smart forgery',
    description: 'Alters frames and recomputes hashes while retaining the original signature.',
    expected_kind: 'CHAIN_FORGED',
  },
  {
    type: 'STREAM_CUT',
    label: 'Cut the feed',
    description: 'Drops all packets for four seconds.',
    expected_kind: 'STREAM_INTERRUPTED',
  },
]

export type ChannelDeps = {
  /** Put a packet on the wire towards the verifier (transit delay is applied by the caller). */
  deliver(pkt: MockPacket): void
  emit(msg: LiveMessage): void
  nextAttackId(): string
  checkpointInterval: number
  /** true once the verifier has received at least one packet. */
  hasDelivered(): boolean
  tamperPixels(pkt: MockPacket): Promise<MockPacket>
  forge(pkt: MockPacket, prevChain: string): Promise<MockPacket>
  makeFake(seq: number, prevChain: string): Promise<MockPacket>
}

type Running = {
  ack: AttackAck
  firstEffectAt: number | null
  endedAt: number | null
  linked: boolean
  remaining: number
  cutMs: number
  held: MockPacket | null
  replay: MockPacket[] | null
  cutStart: number | null
  forging: boolean
  forgePrev: string
  forged: number
}

/** Ring of forwarded packets, big enough for the largest LOOP_REPLAY (v1.3: 90). */
const RING = 90

type ParamSpec = { min: number; max: number; int: boolean; def: number }

/** CONTRACT v1.3 (c): supported params; unknown key or out-of-range value → 422. */
const PARAMS: Record<AttackType, Record<string, ParamSpec>> = {
  PIXEL_TAMPER: { frames: { min: 1, max: 150, int: true, def: 30 } },
  FRAME_DROP: { count: { min: 1, max: 60, int: true, def: 10 } },
  FRAME_INSERT: {},
  FRAME_REORDER: {},
  LOOP_REPLAY: { frames: { min: 15, max: 90, int: true, def: 45 } },
  CHAIN_FORGE: { min_frames: { min: 1, max: 30, int: true, def: 5 } },
  STREAM_CUT: { seconds: { min: 2.5, max: 10, int: false, def: 4 } },
}

export function validateParams(type: AttackType, params: Record<string, unknown>): Record<string, number> {
  const spec = PARAMS[type]
  const out: Record<string, number> = {}
  for (const [key, s] of Object.entries(spec)) out[key] = s.def
  for (const [key, v] of Object.entries(params ?? {})) {
    const s = spec[key]
    if (!s) {
      const allowed = Object.keys(spec)
      throw new ApiRequestError(
        422,
        `${type} does not accept "${key}"${allowed.length ? ` (allowed: ${allowed.join(', ')})` : ' (it takes no params)'}`,
      )
    }
    if (typeof v !== 'number' || !Number.isFinite(v) || (s.int && !Number.isInteger(v)) || v < s.min || v > s.max) {
      throw new ApiRequestError(422, `${type}.${key} must be ${s.int ? 'an integer' : 'a number'} from ${s.min} to ${s.max}`)
    }
    out[key] = v
  }
  return out
}

export class AttackEngine {
  active: Running | null = null
  private last: Running | null = null
  private lastForwardedChain: string
  private ring: MockPacket[] = []
  private readonly deps: ChannelDeps

  constructor(deps: ChannelDeps, genesis: string) {
    this.deps = deps
    this.lastForwardedChain = genesis
  }

  launch(type: AttackType, params: Record<string, unknown>): AttackAck {
    // body validation (422) comes before state checks (409), as with FastAPI
    const info = CATALOG.find((c) => c.type === type)
    if (!info) throw new ApiRequestError(422, `Unknown attack type: ${String(type)}`)
    const p = validateParams(type, params)
    if (this.active) throw new ApiRequestError(409, `Attack ${this.active.ack.attack_id} (${this.active.ack.type}) is still running`)
    const ack: AttackAck = {
      attack_id: this.deps.nextAttackId(),
      type,
      label: info.label,
      started_at: new Date().toISOString(),
      expected_kind: info.expected_kind,
    }
    this.active = {
      ack,
      firstEffectAt: null,
      endedAt: null,
      linked: false,
      remaining: p.frames ?? p.count ?? p.min_frames ?? 1,
      cutMs: (p.seconds ?? 4) * 1000,
      held: null,
      replay: null,
      cutStart: null,
      forging: false,
      forgePrev: '',
      forged: 0,
    }
    this.deps.emit({ type: 'attack', attack: ack, phase: 'started' })
    return ack
  }

  /** Stop whatever runs (session stopped). A held packet is released so nothing is silently lost. */
  abort() {
    const a = this.active
    if (!a) return
    if (a.held) this.out(a.held)
    this.end()
  }

  /** Which attack an incident opening now belongs to (§6 detection_latency_ms). */
  linkAttack(now: number): AttackLink | null {
    for (const a of [this.active, this.last]) {
      if (!a || a.linked || a.firstEffectAt === null) continue
      if (a !== this.active && a.endedAt !== null && now - a.endedAt > 5000) continue
      a.linked = true
      return { attack_id: a.ack.attack_id, attack_type: a.ack.type, firstEffectAt: a.firstEffectAt }
    }
    return null
  }

  /** Every packet the producer emits passes through here. */
  async onPacket(pkt: MockPacket, now: number): Promise<void> {
    const a = this.active
    if (!a) {
      this.out(pkt)
      return
    }
    const effect = () => {
      a.firstEffectAt ??= performance.now()
    }

    switch (a.ack.type) {
      case 'PIXEL_TAMPER': {
        const modified = await this.deps.tamperPixels(pkt)
        effect()
        this.out(modified)
        if (--a.remaining <= 0) this.end()
        return
      }
      case 'FRAME_DROP': {
        effect()
        if (--a.remaining <= 0) this.end()
        return
      }
      case 'FRAME_INSERT': {
        const fake = await this.deps.makeFake(pkt.header.seq, this.lastForwardedChain)
        effect()
        this.out(fake)
        this.out(pkt)
        this.end()
        return
      }
      case 'FRAME_REORDER': {
        if (!a.held) {
          a.held = pkt
          return
        }
        effect() // the swap becomes visible when k+1 leaves before k
        this.out(pkt)
        this.out(a.held)
        a.held = null
        this.end()
        return
      }
      case 'LOOP_REPLAY': {
        if (!a.replay) {
          // v1.3 (b): wait until enough packets have been forwarded to replay
          if (this.ring.length < a.remaining) {
            this.out(pkt)
            return
          }
          a.replay = this.ring.slice(-a.remaining)
        }
        const old = a.replay.shift()
        if (!old) {
          this.out(pkt)
          this.end()
          return
        }
        effect() // live packet dropped, old one sent instead
        this.out(old)
        if (--a.remaining <= 0) this.end()
        return
      }
      case 'CHAIN_FORGE': {
        if (!a.forging) {
          // Start early in a window so the forged run is ≥ 5 frames and ends at that window's checkpoint.
          const pos = pkt.header.seq % this.deps.checkpointInterval
          if (pos > Math.max(0, this.deps.checkpointInterval - 10)) {
            this.out(pkt)
            return
          }
          a.forging = true
          a.forgePrev = this.lastForwardedChain
        }
        const forged = await this.deps.forge(pkt, a.forgePrev)
        a.forgePrev = forged.header.chain_hash
        effect()
        this.out(forged)
        a.forged++
        if (pkt.header.is_checkpoint && a.forged >= a.remaining) this.end()
        return
      }
      case 'STREAM_CUT': {
        // v1.3 (b): only once the verifier has received something (its watchdog is armed)
        if (a.cutStart === null && !this.deps.hasDelivered()) {
          this.out(pkt)
          return
        }
        a.cutStart ??= now
        effect()
        if (now - a.cutStart < a.cutMs) return
        this.out(pkt)
        this.end()
        return
      }
    }
  }

  private out(pkt: MockPacket) {
    this.lastForwardedChain = pkt.header.chain_hash
    this.ring.push(pkt)
    if (this.ring.length > RING) this.ring.shift()
    this.deps.deliver(pkt)
  }

  private end() {
    const a = this.active
    if (!a) return
    a.endedAt = performance.now()
    this.active = null
    this.last = a
    this.deps.emit({ type: 'attack', attack: a.ack, phase: 'ended' })
  }
}
