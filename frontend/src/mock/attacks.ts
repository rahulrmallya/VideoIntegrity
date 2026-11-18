// Mock channel attack engine — the 7 attacks of CONTRACT §7, acting on packets between producer and verifier.

import { ApiRequestError } from '../api/client'
import type { AttackAck, AttackInfo, AttackType, LiveMessage } from '../api/types'
import type { AttackLink, MockPacket } from './verifier'

export const CATALOG: AttackInfo[] = [
  {
    type: 'PIXEL_TAMPER',
    label: 'Erase an object',
    description: 'Blurs the central 40% × 40% of the next 30 frames and re-encodes them, leaving the headers untouched.',
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
    description: 'Sends a foreign synthetic frame claiming the next seq, with a self-consistent header linked to the last forwarded chain hash.',
    expected_kind: 'FRAME_INSERTED',
  },
  {
    type: 'FRAME_REORDER',
    label: 'Swap two frames',
    description: 'Holds packet k, sends k+1, then k.',
    expected_kind: 'FRAME_REORDERED',
  },
  {
    type: 'LOOP_REPLAY',
    label: 'Loop old footage',
    description: 'Drops the next 45 live packets and sends the last 45 forwarded packets again instead — the classic heist "loop the CCTV".',
    expected_kind: 'REPLAY_DETECTED',
  },
  {
    type: 'CHAIN_FORGE',
    label: 'Smart forgery',
    description:
      'Draws a black box on frames and recomputes frame_hash, dhash, prev_hash and chain_hash so every per-frame check passes; keeps the original signature because it has no private key.',
    expected_kind: 'CHAIN_FORGED',
  },
  {
    type: 'STREAM_CUT',
    label: 'Cut the feed',
    description: 'Drops all packets for 4 seconds.',
    expected_kind: 'STREAM_INTERRUPTED',
  },
]

export type ChannelDeps = {
  /** Put a packet on the wire towards the verifier (transit delay is applied by the caller). */
  deliver(pkt: MockPacket): void
  emit(msg: LiveMessage): void
  nextAttackId(): string
  checkpointInterval: number
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

const RING = 45

function num(params: Record<string, unknown>, key: string, fallback: number): number {
  const v = params[key]
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback
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
    if (this.active) throw new ApiRequestError(409, `Attack ${this.active.ack.attack_id} (${this.active.ack.type}) is still running`)
    const info = CATALOG.find((c) => c.type === type)
    if (!info) throw new ApiRequestError(422, `Unknown attack type: ${String(type)}`)
    const ack: AttackAck = {
      attack_id: this.deps.nextAttackId(),
      type,
      label: info.label,
      started_at: new Date().toISOString(),
      expected_kind: info.expected_kind,
    }
    const defaults: Record<AttackType, number> = {
      PIXEL_TAMPER: 30,
      FRAME_DROP: 10,
      FRAME_INSERT: 1,
      FRAME_REORDER: 1,
      LOOP_REPLAY: 45,
      CHAIN_FORGE: 5,
      STREAM_CUT: 0,
    }
    this.active = {
      ack,
      firstEffectAt: null,
      endedAt: null,
      linked: false,
      remaining: num(params, 'count', defaults[type]),
      cutMs: num(params, 'seconds', 4) * 1000,
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
        a.replay ??= this.ring.slice(-Math.min(a.remaining, this.ring.length))
        a.remaining = Math.min(a.remaining, a.replay.length)
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
