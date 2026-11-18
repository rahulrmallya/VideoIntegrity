// Mock verifier — a direct implementation of CONTRACT §5 (rules 1–8) and §6 (incident grouping).
// Because the mock runs the real rules on real hashes, every attack produces the contract's outcome
// by construction rather than by scripting.

import type {
  AttackType,
  ChainRecord,
  FrameMessage,
  FrameVerdict,
  Incident,
  IncidentEvidence,
  IncidentKind,
  LiveMessage,
  StatusUpdate,
  TimelineStatus,
} from '../api/types'
import { type Bytes, chainHash, checkpointMessage, hamming64, sha256Hex, type Signer } from './crypto'

export type MockPacket = {
  header: ChainRecord
  /** Exact ts_ns used in the chain hash (the JSON number loses precision). */
  tsBig: bigint
  bytes: Bytes
  b64: string
  /** dHash of the payload's actual pixels — what decoding the payload would give (§5.3). */
  payloadDhash: string
}

export type AttackLink = { attack_id: string; attack_type: AttackType; firstEffectAt: number }

export type VerifierHooks = {
  emit(msg: LiveMessage): void
  upsertIncident(inc: Incident): void
  nextIncidentId(): string
  /** Attack responsible for an incident opening now (active, or just ended), or null. */
  linkAttack(now: number): AttackLink | null
  /** A seq just became `tampered` (lets the backend render diff.png). */
  onTampered(seq: number): void
}

type OpenIncident = { inc: Incident; affected: Set<number>; missing: Set<number> }

type Failure = {
  kind: IncidentKind
  seqs: number[]
  missing?: number[]
  /** seq_from / seq_to when no seq is affected yet (STREAM_INTERRUPTED). */
  range?: [number, number]
  proof: string
  evidence: Partial<IncidentEvidence> & { sample_seq: number }
}

const TEXT: Record<IncidentKind, { title: string; explanation: string }> = {
  FRAME_MODIFIED: {
    title: 'Frame content altered',
    explanation:
      "The picture no longer matches the fingerprint the camera recorded when it captured it — someone edited these frames on the way.",
  },
  FRAME_DELETED: {
    title: 'Frames deleted',
    explanation: 'Frames the camera recorded never arrived. The sequence numbers jump, so footage was removed.',
  },
  FRAME_INSERTED: {
    title: 'Fake frame inserted',
    explanation: 'Two different frames claim the same position in the recording — one of them was injected by an attacker.',
  },
  FRAME_REORDERED: {
    title: 'Frames reordered',
    explanation: 'A frame arrived after the frame that follows it — the order of events was changed.',
  },
  REPLAY_DETECTED: {
    title: 'Old footage replayed',
    explanation: 'Frames that were already received are being sent again — the classic "loop the CCTV" trick.',
  },
  CHAIN_FORGED: {
    title: 'Forged chain — signature invalid',
    explanation:
      "Every frame looked self-consistent, but the camera's Ed25519 signature does not match them. Only the camera's private key can produce a valid seal.",
  },
  CHAIN_BROKEN: {
    title: 'Hash chain broken',
    explanation: 'A frame does not link to the frame before it, so the recording is no longer one unbroken sequence.',
  },
  STREAM_INTERRUPTED: {
    title: 'Stream interrupted',
    explanation: 'No frames reached the verifier for over 2 seconds — the feed was cut or blocked.',
  },
}

const short = (h: string | null | undefined) => (h ? `${h.slice(0, 4)}…${h.slice(-4)}` : '—')
const nowIso = () => new Date().toISOString()
const SEEN_LIMIT = 900
const TIMELINE_LIMIT = 2000
const RECEIVED_LIMIT = 900

export type StatusCounts = Record<TimelineStatus, number>

export class MockVerifier {
  // §5 state
  anchor: string
  expectedSeq = 0
  readonly seen = new Map<number, string>()
  window: number[] = []
  windowFailures = 0
  reanchoredInWindow = false
  open: OpenIncident | null = null
  lastDelivery: number
  silenceReported = false

  // bookkeeping for stats / frames API
  readonly timeline = new Map<number, TimelineStatus>()
  readonly counts: StatusCounts = { pending: 0, sealed: 0, unverified: 0, tampered: 0, missing: 0 }
  /** First payload received per seq (base64) — backs received.jpg. */
  readonly received = new Map<number, string>()
  delivered = 0
  checkpointsOk = 0
  checkpointsFailed = 0
  verifyMsAvg = 0
  lastDetectionLatencyMs: number | null = null

  private readonly sessionId: string
  private readonly signer: Signer
  private readonly hooks: VerifierHooks
  private readonly watchdogMs: number
  private updates = new Map<number, TimelineStatus>()
  private queue: Promise<void> = Promise.resolve()

  constructor(sessionId: string, genesis: string, signer: Signer, hooks: VerifierHooks, watchdogMs: number, now: number) {
    this.sessionId = sessionId
    this.anchor = genesis
    this.signer = signer
    this.hooks = hooks
    this.watchdogMs = watchdogMs
    this.lastDelivery = now
  }

  /** Packets are verified strictly one at a time, in arrival order. */
  receive(pkt: MockPacket): Promise<void> {
    this.queue = this.queue.then(() => this.process(pkt)).catch((err: unknown) => console.error('[mock verifier]', err))
    return this.queue
  }

  /** §5.8 watchdog — called on every producer tick. Armed only after the first packet (v1.2). */
  tick(now: number) {
    if (this.delivered === 0 || this.silenceReported || now - this.lastDelivery <= this.watchdogMs) return
    this.silenceReported = true
    const last = this.expectedSeq - 1
    this.fail({
      kind: 'STREAM_INTERRUPTED',
      seqs: [],
      range: [this.expectedSeq, this.expectedSeq],
      proof: `No packet for ${((now - this.lastDelivery) / 1000).toFixed(1)} s after frame #${last}  (limit ${(this.watchdogMs / 1000).toFixed(1)} s)`,
      evidence: { sample_seq: last },
    })
  }

  /** Session ended: close whatever is still open. */
  shutdown() {
    if (this.open) this.closeIncident()
  }

  private async process(pkt: MockPacket) {
    const t0 = performance.now()
    this.lastDelivery = t0
    this.silenceReported = false
    this.delivered++
    const h = pkt.header
    const reasons: IncidentKind[] = []
    let verdict: FrameVerdict = 'ok'

    if (!this.received.has(h.seq)) {
      this.received.set(h.seq, pkt.b64)
      if (this.received.size > RECEIVED_LIMIT) this.received.delete(this.received.keys().next().value as number)
    }

    const hs = performance.now()
    const computed = await sha256Hex(pkt.bytes)
    const hashMs = performance.now() - hs

    // 1. late or repeated seq
    if (h.seq < this.expectedSeq) {
      verdict = 'tampered'
      const known = this.seen.get(h.seq)
      if (known !== undefined && known === h.chain_hash) {
        reasons.push('REPLAY_DETECTED')
        this.fail({
          kind: 'REPLAY_DETECTED',
          seqs: [h.seq],
          proof: `Frame #${h.seq} (chain ${short(h.chain_hash)}) was already received — expected #${this.expectedSeq}`,
          evidence: { sample_seq: h.seq, expected_hash: known, actual_hash: h.chain_hash },
        })
      } else if (known !== undefined) {
        reasons.push('FRAME_INSERTED')
        this.setStatus(h.seq, 'tampered')
        this.fail({
          kind: 'FRAME_INSERTED',
          seqs: [h.seq],
          proof: `Two different frames claim #${h.seq}: chain ${short(known)}  ≠  ${short(h.chain_hash)}`,
          evidence: { sample_seq: h.seq, expected_hash: h.chain_hash, actual_hash: known },
        })
      } else {
        reasons.push('FRAME_REORDERED')
        this.setStatus(h.seq, 'tampered')
        const proof = `Frame #${h.seq} arrived after #${this.expectedSeq - 1}`
        this.fail({
          kind: 'FRAME_REORDERED',
          seqs: [h.seq],
          proof,
          evidence: { sample_seq: h.seq, expected_hash: h.frame_hash, actual_hash: computed },
        })
        if (this.open && this.open.inc.kind === 'FRAME_DELETED') {
          const inc = this.open.inc
          inc.kind = 'FRAME_REORDERED'
          inc.title = TEXT.FRAME_REORDERED.title
          inc.explanation = TEXT.FRAME_REORDERED.explanation
          inc.proof = proof
          this.open.missing.delete(h.seq)
          inc.missing_count = this.open.missing.size
          this.hooks.upsertIncident({ ...inc })
        }
      }
      this.emitFrame(pkt, computed, verdict, reasons, hashMs, t0)
      this.flushStatus()
      return
    }

    // 2. gap
    let gap = false
    if (h.seq > this.expectedSeq) {
      gap = true
      const missing: number[] = []
      for (let s = this.expectedSeq; s < h.seq; s++) {
        missing.push(s)
        this.setStatus(s, 'missing')
      }
      reasons.push('FRAME_DELETED')
      this.fail({
        kind: 'FRAME_DELETED',
        seqs: missing,
        missing,
        proof: `Expected frame #${this.expectedSeq}, received #${h.seq} — ${missing.length} frame${missing.length === 1 ? '' : 's'} never arrived`,
        evidence: { sample_seq: this.expectedSeq, expected_prev: this.anchor, actual_prev: h.prev_hash },
      })
    }

    // 3. payload
    const modified = computed !== h.frame_hash
    if (modified) {
      verdict = 'tampered'
      reasons.push('FRAME_MODIFIED')
      const pct = Math.round((hamming64(pkt.payloadDhash, h.dhash) / 64) * 1000) / 10
      this.fail({
        kind: 'FRAME_MODIFIED',
        seqs: [h.seq],
        proof: `SHA-256(received frame) = ${short(computed)}  ≠  camera's recorded hash ${short(h.frame_hash)}`,
        evidence: { sample_seq: h.seq, expected_hash: h.frame_hash, actual_hash: computed, visual_change_pct: pct },
      })
    }

    // 4. header consistency
    const recomputed = await chainHash(h.prev_hash, h.frame_hash, h.dhash, h.seq, pkt.tsBig)
    if (recomputed !== h.chain_hash) {
      verdict = 'tampered'
      reasons.push('CHAIN_BROKEN')
      this.fail({
        kind: 'CHAIN_BROKEN',
        seqs: [h.seq],
        proof: `Header of #${h.seq} is inconsistent: recomputed chain ${short(recomputed)}  ≠  claimed ${short(h.chain_hash)}`,
        evidence: { sample_seq: h.seq, expected_hash: recomputed, actual_hash: h.chain_hash },
      })
    }

    // 5. link
    if (h.prev_hash !== this.anchor) {
      if (!gap) {
        reasons.push('CHAIN_BROKEN')
        this.fail({
          kind: 'CHAIN_BROKEN',
          seqs: [h.seq],
          proof: `prev_hash of #${h.seq} = ${short(h.prev_hash)}  ≠  last verified chain hash ${short(this.anchor)}`,
          evidence: { sample_seq: h.seq, expected_prev: this.anchor, actual_prev: h.prev_hash },
        })
      }
      for (const s of this.window) if (this.timeline.get(s) === 'pending') this.setStatus(s, 'unverified')
      this.window = []
      this.reanchoredInWindow = true
    }

    // 6. accept
    this.anchor = h.chain_hash
    this.expectedSeq = h.seq + 1
    this.seen.set(h.seq, h.chain_hash)
    if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.keys().next().value as number)
    this.window.push(h.seq)
    this.setStatus(h.seq, modified ? 'tampered' : 'pending')

    // 7. checkpoint
    let seal: LiveMessage | null = null
    if (h.is_checkpoint) {
      const vs = performance.now()
      const valid = await this.signer.verify(checkpointMessage(this.sessionId, h.seq, h.chain_hash), h.signature)
      const sealVerifyMs = performance.now() - vs
      const windowFrom = this.window[0] ?? h.seq
      if (valid) {
        this.checkpointsOk++
        for (const s of this.window) if (this.timeline.get(s) === 'pending') this.setStatus(s, 'sealed')
        if (this.open && this.windowFailures === 0 && !this.reanchoredInWindow) this.closeIncident()
      } else {
        this.checkpointsFailed++
        verdict = 'tampered'
        reasons.push('CHAIN_FORGED')
        for (const s of this.window) this.setStatus(s, 'tampered')
        this.fail({
          kind: 'CHAIN_FORGED',
          seqs: [...this.window],
          proof: h.signature
            ? `Ed25519 signature on checkpoint #${h.seq} does not verify for chain hash ${short(h.chain_hash)}`
            : `Checkpoint #${h.seq} carries no signature`,
          evidence: { sample_seq: h.seq, expected_hash: null, actual_hash: h.chain_hash },
        })
      }
      seal = {
        type: 'seal',
        seq: h.seq,
        valid,
        window_from: windowFrom,
        window_to: h.seq,
        chain_hash: h.chain_hash,
        signature: h.signature,
        verify_ms: round3(sealVerifyMs),
      }
      this.window = []
      this.windowFailures = 0
      this.reanchoredInWindow = false
    }

    this.emitFrame(pkt, computed, verdict, reasons, hashMs, t0)
    this.flushStatus()
    if (seal) this.hooks.emit(seal)
  }

  private emitFrame(pkt: MockPacket, computed: string, verdict: FrameVerdict, reasons: string[], hashMs: number, t0: number) {
    const h = pkt.header
    const verifyMs = performance.now() - t0
    this.verifyMsAvg = this.verifyMsAvg === 0 ? verifyMs : this.verifyMsAvg * 0.9 + verifyMs * 0.1
    const msg: FrameMessage = {
      type: 'frame',
      seq: h.seq,
      ts_ns: h.ts_ns,
      jpeg_b64: pkt.b64,
      verdict,
      reasons,
      frame_hash: h.frame_hash,
      computed_hash: computed,
      prev_hash: h.prev_hash,
      chain_hash: h.chain_hash,
      dhash: h.dhash,
      is_checkpoint: h.is_checkpoint,
      hash_ms: round3(hashMs),
      verify_ms: round3(verifyMs),
    }
    this.hooks.emit(msg)
  }

  private setStatus(seq: number, status: TimelineStatus) {
    const prev = this.timeline.get(seq)
    if (prev === status) return
    if (prev) this.counts[prev]--
    this.counts[status]++
    if (prev === undefined && this.timeline.size >= TIMELINE_LIMIT) {
      this.timeline.delete(this.timeline.keys().next().value as number)
    }
    this.timeline.set(seq, status)
    this.updates.set(seq, status)
    if (status === 'tampered') this.hooks.onTampered(seq)
  }

  private flushStatus() {
    if (this.updates.size === 0) return
    const updates: StatusUpdate[] = []
    for (const [seq, status] of this.updates) updates.push({ seq, status })
    this.updates = new Map()
    this.hooks.emit({ type: 'status', updates })
  }

  /** Every failure increments window_failures and joins the open incident or opens one (§5, §6). */
  private fail(f: Failure) {
    this.windowFailures++
    const o = this.open
    if (o) {
      const inc = o.inc
      if (!inc.kinds_seen.includes(f.kind)) inc.kinds_seen.push(f.kind)
      for (const s of f.seqs) o.affected.add(s)
      for (const s of f.missing ?? []) o.missing.add(s)
      this.refreshCounts(o)
      this.hooks.upsertIncident({ ...inc, kinds_seen: [...inc.kinds_seen], evidence: { ...inc.evidence } })
      return
    }
    const now = performance.now()
    const link = this.hooks.linkAttack(now)
    const latency = link ? Math.max(1, Math.round(now - link.firstEffectAt)) : null
    if (latency !== null) this.lastDetectionLatencyMs = latency
    const inc: Incident = {
      id: this.hooks.nextIncidentId(),
      kind: f.kind,
      kinds_seen: [f.kind],
      severity: f.kind === 'STREAM_INTERRUPTED' ? 'warning' : 'critical',
      status: 'open',
      title: TEXT[f.kind].title,
      explanation: TEXT[f.kind].explanation,
      proof: f.proof,
      seq_from: f.range?.[0] ?? f.evidence.sample_seq,
      seq_to: f.range?.[1] ?? f.evidence.sample_seq,
      affected_count: 0,
      missing_count: 0,
      opened_at: nowIso(),
      closed_at: null,
      detection_latency_ms: latency,
      attack_id: link?.attack_id ?? null,
      attack_type: link?.attack_type ?? null,
      evidence: {
        sample_seq: f.evidence.sample_seq,
        expected_hash: f.evidence.expected_hash ?? null,
        actual_hash: f.evidence.actual_hash ?? null,
        expected_prev: f.evidence.expected_prev ?? null,
        actual_prev: f.evidence.actual_prev ?? null,
        visual_change_pct: f.evidence.visual_change_pct ?? null,
      },
      acknowledged: false,
    }
    const opened: OpenIncident = { inc, affected: new Set(f.seqs), missing: new Set(f.missing ?? []) }
    this.open = opened
    this.refreshCounts(opened)
    this.hooks.upsertIncident({ ...inc, kinds_seen: [...inc.kinds_seen], evidence: { ...inc.evidence } })
  }

  private refreshCounts(o: OpenIncident) {
    const inc = o.inc
    inc.affected_count = o.affected.size
    inc.missing_count = o.missing.size
    if (o.affected.size > 0) {
      let lo = Infinity
      let hi = -Infinity
      for (const s of o.affected) {
        if (s < lo) lo = s
        if (s > hi) hi = s
      }
      inc.seq_from = lo
      inc.seq_to = hi
    }
  }

  private closeIncident() {
    const o = this.open
    if (!o) return
    o.inc.status = 'closed'
    o.inc.closed_at = nowIso()
    this.open = null
    this.hooks.upsertIncident({ ...o.inc, kinds_seen: [...o.inc.kinds_seen], evidence: { ...o.inc.evidence } })
  }
}

export function round3(x: number): number {
  return Math.round(x * 1000) / 1000
}
