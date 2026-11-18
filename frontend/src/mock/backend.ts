// MockBackend: producer (canvas camera) → channel (attack engine) → verifier, all in the browser.
// Exposes the same ApiClient + LiveConnection interfaces as the real backend.

import { ApiRequestError, type ApiClient } from '../api/client'
import type { ConnectionState, LiveConnection } from '../api/live'
import type {
  AttackAck,
  AttackType,
  ChainRecord,
  Device,
  ExportResult,
  Incident,
  LiveMessage,
  Session,
  StartRequest,
  Stats,
  TamperSampleMode,
  VerificationReport,
} from '../api/types'
import { AttackEngine, CATALOG } from './attacks'
import {
  base64ToBytes,
  chainHash,
  checkpointMessage,
  genesisHash,
  sealMessage,
  sha256Hex,
  toHex,
  sha256,
  type Signer,
  createSigner,
  utf8,
} from './crypto'
import { blackBox, blurCentre, decodeJpeg, dhashOf, drawScene, encodeJpeg, loadSceneFonts, makeCanvas, makeDiffPng } from './scene'
import { MockVerifier, round3, type MockPacket } from './verifier'

/** Not a decodable image: <img> fires onError just like a real 404. */
const ABSENT = 'data:image/jpeg;base64,'
const VAULT_LIMIT = 900
const LEDGER_LIMIT = 900
const DIFF_LIMIT = 120

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const id4 = (prefix: string, n: number) => `${prefix}_${String(n).padStart(4, '0')}`
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

type Run = {
  sessionId: string
  fps: number
  w: number
  h: number
  ci: number
  quality: number
  startedPerf: number
  genesis: string
  head: string
  nextSeq: number
  produced: number
  busy: boolean
  timer: ReturnType<typeof setInterval> | null
  verifier: MockVerifier
  engine: AttackEngine
  scene: ReturnType<typeof makeCanvas>
  work: ReturnType<typeof makeCanvas>
  ledger: ChainRecord[]
  vault: Map<number, string>
  lastDeliverAt: number
  wire: { pkt: MockPacket; at: number }[]
  wireTimer: ReturnType<typeof setTimeout> | null
  hashMsAvg: number
  signMsAvg: number
  fpsWindow: { at: number; produced: number; fps: number }
  firstFrameAt: string | null
  lastFrameAt: string | null
}

type PackageMode = 'authentic' | TamperSampleMode

type PackageInfo = {
  filename: string
  mode: PackageMode
  blob: Blob
  url: string
  sha: string
  session: Session
  frameCount: number
  ci: number
  chainHead: string | null
  firstAt: string | null
  lastAt: string | null
  ledger: ChainRecord[]
}

export class MockBackend {
  readonly ready: Promise<void>
  private signer!: Signer
  private device!: Device
  private session: Session
  private run: Run | null = null
  private readonly clients = new Set<(msg: LiveMessage) => void>()
  private incidents: Incident[] = []
  private counters = { incident: 0, attack: 0, report: 0, vincident: 0 }
  private readonly diffs = new Map<number, string>()
  private diffQueue: Promise<void> = Promise.resolve()
  private readonly packages = new Map<string, PackageInfo>()
  private latestExport: PackageInfo | null = null
  private readonly reports = new Map<string, VerificationReport>()

  constructor() {
    this.session = this.idleSession('')
    this.ready = this.init()
  }

  private async init() {
    await loadSceneFonts()
    this.signer = await createSigner()
    const pkHex = toHex(this.signer.publicKeyRaw)
    this.device = {
      device_id: (await sha256Hex(this.signer.publicKeyRaw)).slice(0, 16),
      public_key_hex: pkHex,
      algorithm: 'Ed25519',
      created_at: new Date().toISOString(),
    }
    if (!this.signer.realEd25519) console.warn('[mock] WebCrypto Ed25519 unavailable — using an HMAC stand-in for signatures')
    this.session = this.idleSession(this.device.device_id)
    setInterval(() => this.broadcast({ type: 'stats', stats: this.stats() }), 1000)
  }

  private idleSession(deviceId: string): Session {
    return {
      session_id: null,
      status: 'idle',
      source: null,
      source_label: null,
      fps: 15,
      width: 640,
      height: 480,
      checkpoint_interval: 15,
      started_at: null,
      stopped_at: null,
      device_id: deviceId,
      seal: null,
    }
  }

  // --- live ----------------------------------------------------------------------------------------

  private broadcast(msg: LiveMessage) {
    if (this.clients.size === 0) return
    // Round-trip through JSON so the UI sees exactly what a real socket would deliver.
    const wire = JSON.stringify(msg)
    for (const c of this.clients) c(JSON.parse(wire) as LiveMessage)
  }

  addClient(cb: (msg: LiveMessage) => void) {
    this.clients.add(cb)
    cb(clone<LiveMessage>({ type: 'hello', session: this.session, device: this.device, catalog: CATALOG }))
  }

  removeClient(cb: (msg: LiveMessage) => void) {
    this.clients.delete(cb)
  }

  // --- session / producer ----------------------------------------------------------------------

  async startSession(req: StartRequest): Promise<Session> {
    if (this.run?.timer) await this.stopSession()
    const fps = req.fps ?? 15
    const w = req.width ?? 640
    const h = req.height ?? 480
    const ci = req.checkpoint_interval ?? 15
    const sessionId = crypto.randomUUID()
    const genesis = await genesisHash(sessionId, this.signer.publicKeyRaw)
    const now = performance.now()

    const run: Run = {
      sessionId,
      fps,
      w,
      h,
      ci,
      quality: (req.jpeg_quality ?? 80) / 100,
      startedPerf: now,
      genesis,
      head: genesis,
      nextSeq: 0,
      produced: 0,
      busy: false,
      timer: null,
      verifier: null as unknown as MockVerifier,
      engine: null as unknown as AttackEngine,
      scene: makeCanvas(w, h),
      work: makeCanvas(w, h),
      ledger: [],
      vault: new Map(),
      lastDeliverAt: 0,
      wire: [],
      wireTimer: null,
      hashMsAvg: 0,
      signMsAvg: 0,
      fpsWindow: { at: now, produced: 0, fps: 0 },
      firstFrameAt: null,
      lastFrameAt: null,
    }
    const watchdogMs = ((2 * ci) / fps) * 1000
    run.verifier = new MockVerifier(
      sessionId,
      genesis,
      this.signer,
      {
        emit: (m) => {
          if (this.run === run) this.broadcast(m)
        },
        upsertIncident: (inc) => this.upsertIncident(inc),
        nextIncidentId: () => id4('inc', ++this.counters.incident),
        linkAttack: (t) => run.engine.linkAttack(t),
        onTampered: (seq) => this.queueDiff(run, seq),
      },
      watchdogMs,
      now,
    )
    run.engine = new AttackEngine(
      {
        deliver: (pkt) => this.deliver(run, pkt),
        emit: (m) => this.broadcast(m),
        nextAttackId: () => id4('atk', ++this.counters.attack),
        checkpointInterval: ci,
        tamperPixels: (pkt) => this.tamperPixels(run, pkt),
        forge: (pkt, prev) => this.forge(run, pkt, prev),
        makeFake: (seq, prev) => this.makeFake(run, seq, prev),
      },
      genesis,
    )

    this.run = run
    this.diffs.clear()
    this.session = {
      session_id: sessionId,
      status: 'running',
      source: req.source,
      source_label: req.source === 'synthetic' ? 'Mock synthetic scene' : `Mock camera (${req.source} requested)`,
      fps,
      width: w,
      height: h,
      checkpoint_interval: ci,
      started_at: new Date().toISOString(),
      stopped_at: null,
      device_id: this.device.device_id,
      seal: null,
    }
    this.broadcast({ type: 'session', session: this.session })
    run.timer = setInterval(() => {
      run.verifier.tick(performance.now())
      void this.produce(run)
    }, 1000 / fps)
    return this.session
  }

  async stopSession(): Promise<Session> {
    const run = this.run
    if (!run || !run.timer) return this.session
    clearInterval(run.timer)
    run.timer = null
    // let an in-flight frame finish so the seal covers it
    while (run.busy) await sleep(5)
    run.engine.abort()
    await sleep(80) // packets in transit reach the verifier
    run.verifier.shutdown()
    const lastSeq = run.nextSeq - 1
    const signature = await this.signer.sign(sealMessage(run.sessionId, Math.max(0, lastSeq), run.head, run.produced))
    this.session = {
      ...this.session,
      status: 'stopped',
      stopped_at: new Date().toISOString(),
      seal: { last_seq: Math.max(0, lastSeq), chain_hash: run.head, frame_count: run.produced, signature },
    }
    this.broadcast({ type: 'session', session: this.session })
    return this.session
  }

  private async produce(run: Run) {
    if (run.busy || !run.timer) return
    run.busy = true
    try {
      const wall = Date.now()
      const seq = run.nextSeq
      drawScene(run.scene.ctx, run.w, run.h, wall, seq)
      const { bytes, b64 } = encodeJpeg(run.scene.canvas, run.quality)
      const dhash = dhashOf(run.scene.canvas)
      const hs = performance.now()
      const frameHash = await sha256Hex(bytes)
      const hashMs = performance.now() - hs
      run.hashMsAvg = run.hashMsAvg === 0 ? hashMs : run.hashMsAvg * 0.9 + hashMs * 0.1

      const tsBig = BigInt(wall) * 1_000_000n + BigInt(Math.floor((performance.now() % 1) * 1e6))
      const prev = run.head
      const chain = await chainHash(prev, frameHash, dhash, seq, tsBig)
      const isCheckpoint = (seq + 1) % run.ci === 0
      let signature: string | null = null
      if (isCheckpoint) {
        const ss = performance.now()
        signature = await this.signer.sign(checkpointMessage(run.sessionId, seq, chain))
        const signMs = performance.now() - ss
        run.signMsAvg = run.signMsAvg === 0 ? signMs : run.signMsAvg * 0.8 + signMs * 0.2
      }
      run.nextSeq = seq + 1
      run.head = chain
      run.produced++
      const iso = new Date(wall).toISOString()
      run.firstFrameAt ??= iso
      run.lastFrameAt = iso

      const header: ChainRecord = {
        session_id: run.sessionId,
        seq,
        ts_ns: Number(tsBig),
        prev_hash: prev,
        frame_hash: frameHash,
        dhash,
        chain_hash: chain,
        is_checkpoint: isCheckpoint,
        signature,
      }
      run.ledger.push(header)
      if (run.ledger.length > LEDGER_LIMIT) run.ledger.shift()
      run.vault.set(seq, b64)
      if (run.vault.size > VAULT_LIMIT) run.vault.delete(run.vault.keys().next().value as number)

      await run.engine.onPacket({ header, tsBig, bytes, b64, payloadDhash: dhash }, performance.now())
    } catch (err) {
      console.error('[mock producer]', err)
    } finally {
      run.busy = false
    }
  }

  /**
   * Network transit: 20–45 ms (gives per-frame detection latencies of ~20–60 ms). One FIFO queue drained
   * by a single timer — separate setTimeouts per packet can fire out of order and fake a reorder attack.
   */
  private deliver(run: Run, pkt: MockPacket) {
    const at = Math.max(run.lastDeliverAt, performance.now() + 20 + Math.random() * 25)
    run.lastDeliverAt = at
    run.wire.push({ pkt, at })
    if (!run.wireTimer) this.scheduleWire(run)
  }

  private scheduleWire(run: Run) {
    const head = run.wire[0]
    if (!head) return
    run.wireTimer = setTimeout(() => {
      run.wireTimer = null
      if (this.run !== run) return
      const now = performance.now()
      while (run.wire.length && run.wire[0].at <= now + 1) void run.verifier.receive(run.wire.shift()!.pkt)
      this.scheduleWire(run)
    }, Math.max(0, head.at - performance.now()))
  }

  // --- attacker's pixel work ---------------------------------------------------------------------

  private async reencode(run: Run, pkt: MockPacket, paint: (src: ImageBitmap) => void) {
    const bmp = await decodeJpeg(pkt.bytes)
    paint(bmp)
    bmp.close()
    return { ...encodeJpeg(run.work.canvas, run.quality), dhash: dhashOf(run.work.canvas) }
  }

  private async tamperPixels(run: Run, pkt: MockPacket): Promise<MockPacket> {
    const { bytes, b64, dhash } = await this.reencode(run, pkt, (src) => blurCentre(run.work.ctx, src, run.w, run.h))
    // header untouched
    return { header: { ...pkt.header }, tsBig: pkt.tsBig, bytes, b64, payloadDhash: dhash }
  }

  private async forge(run: Run, pkt: MockPacket, prevChain: string): Promise<MockPacket> {
    const { bytes, b64, dhash } = await this.reencode(run, pkt, (src) => blackBox(run.work.ctx, src, run.w, run.h))
    const frameHash = await sha256Hex(bytes)
    const chain = await chainHash(prevChain, frameHash, dhash, pkt.header.seq, pkt.tsBig)
    return {
      // signature kept as-is: the attacker has no private key
      header: { ...pkt.header, prev_hash: prevChain, frame_hash: frameHash, dhash, chain_hash: chain },
      tsBig: pkt.tsBig,
      bytes,
      b64,
      payloadDhash: dhash,
    }
  }

  private async makeFake(run: Run, seq: number, prevChain: string): Promise<MockPacket> {
    const wall = Date.now()
    drawScene(run.work.ctx, run.w, run.h, wall, seq, { foreign: true })
    const { bytes, b64 } = encodeJpeg(run.work.canvas, run.quality)
    const dhash = dhashOf(run.work.canvas)
    const frameHash = await sha256Hex(bytes)
    const tsBig = BigInt(wall) * 1_000_000n
    const chain = await chainHash(prevChain, frameHash, dhash, seq, tsBig)
    return {
      header: {
        session_id: run.sessionId,
        seq,
        ts_ns: Number(tsBig),
        prev_hash: prevChain,
        frame_hash: frameHash,
        dhash,
        chain_hash: chain,
        is_checkpoint: false,
        signature: null,
      },
      tsBig,
      bytes,
      b64,
      payloadDhash: dhash,
    }
  }

  private queueDiff(run: Run, seq: number) {
    if (this.diffs.has(seq)) return
    this.diffQueue = this.diffQueue
      .then(async () => {
        await sleep(15) // stay out of the capture loop's way
        const original = run.vault.get(seq)
        const received = run.verifier.received.get(seq)
        if (this.run !== run || !original || !received || this.diffs.has(seq)) return
        this.diffs.set(seq, await makeDiffPng(base64ToBytes(original), base64ToBytes(received), run.w, run.h))
        if (this.diffs.size > DIFF_LIMIT) this.diffs.delete(this.diffs.keys().next().value as number)
      })
      .catch((err: unknown) => console.error('[mock diff]', err))
  }

  // --- incidents / stats ---------------------------------------------------------------------------

  private upsertIncident(inc: Incident) {
    const i = this.incidents.findIndex((x) => x.id === inc.id)
    if (i >= 0) {
      inc.acknowledged = this.incidents[i].acknowledged || inc.acknowledged
      this.incidents[i] = inc
    } else this.incidents.unshift(inc)
    if (this.incidents.length > 200) this.incidents.pop()
    this.broadcast({ type: 'incident', incident: inc })
  }

  stats(): Stats {
    const run = this.run
    const v = run?.verifier
    const running = this.session.status === 'running'
    if (run && running) {
      const now = performance.now()
      const dt = (now - run.fpsWindow.at) / 1000
      if (dt >= 0.9) {
        run.fpsWindow = { at: now, produced: run.produced, fps: (run.produced - run.fpsWindow.produced) / dt }
      }
    }
    return {
      integrity: v?.open ? 'COMPROMISED' : running ? 'SECURE' : 'IDLE',
      fps_actual: running && run ? Math.round(run.fpsWindow.fps * 10) / 10 : 0,
      uptime_s: running && run ? Math.round((performance.now() - run.startedPerf) / 100) / 10 : 0,
      frames_produced: run?.produced ?? 0,
      frames_delivered: v?.delivered ?? 0,
      frames_sealed: v?.counts.sealed ?? 0,
      frames_pending: v?.counts.pending ?? 0,
      frames_unverified: v?.counts.unverified ?? 0,
      frames_tampered: v?.counts.tampered ?? 0,
      frames_missing: v?.counts.missing ?? 0,
      checkpoints_ok: v?.checkpointsOk ?? 0,
      checkpoints_failed: v?.checkpointsFailed ?? 0,
      avg_hash_ms: round3(run?.hashMsAvg ?? 0),
      avg_sign_ms: round3(run?.signMsAvg ?? 0),
      avg_verify_ms: round3(v?.verifyMsAvg ?? 0),
      chain_head: run?.head ?? null,
      open_incident_id: v?.open?.inc.id ?? null,
      incidents_total: this.incidents.length,
      last_detection_latency_ms: v?.lastDetectionLatencyMs ?? null,
    }
  }

  // --- evidence ------------------------------------------------------------------------------------

  private async buildPackage(mode: PackageMode, base: Omit<PackageInfo, 'filename' | 'mode' | 'blob' | 'url' | 'sha'>): Promise<PackageInfo> {
    const sid = base.session.session_id ?? 'unknown'
    const filename = mode === 'authentic' ? `frameseal_${sid}.zip` : `frameseal_${sid}_tampered_${mode}.zip`
    const lines = [
      'FRAMESEAL-MOCK-PACKAGE 1',
      `mode=${mode}`,
      'Generated by the FrameSeal UI mock (?mock=1). A real package is a zip as described in CONTRACT §10.',
      '--- session.json ---',
      JSON.stringify({ session: base.session, device: this.device }),
      '--- seal.json ---',
      JSON.stringify(base.session.seal),
      '--- ledger.jsonl ---',
      ...base.ledger.map((r) => JSON.stringify(r)),
      '',
    ]
    const blob = new Blob([lines.join('\n')], { type: 'application/zip' })
    const sha = await sha256Hex(new Uint8Array(await blob.arrayBuffer()))
    const info: PackageInfo = { ...base, filename, mode, blob, url: URL.createObjectURL(blob), sha }
    const old = this.packages.get(filename)
    if (old) URL.revokeObjectURL(old.url)
    this.packages.set(filename, info)
    return info
  }

  private toExportResult(p: PackageInfo, description?: string): ExportResult {
    const r: ExportResult = {
      filename: p.filename,
      download_url: p.url,
      size_bytes: p.blob.size,
      package_sha256: p.sha,
      frame_count: p.frameCount,
    }
    if (description) r.description = description
    return r
  }

  async exportEvidence(): Promise<ExportResult> {
    const run = this.run
    if (!run || run.produced === 0) throw new ApiRequestError(409, 'No recorded session to export — start a session first')
    const info = await this.buildPackage('authentic', {
      session: clone(this.session),
      frameCount: run.produced,
      ci: run.ci,
      chainHead: run.head,
      firstAt: run.firstFrameAt,
      lastAt: run.lastFrameAt,
      ledger: [...run.ledger],
    })
    this.latestExport = info
    return this.toExportResult(info)
  }

  async tamperSample(mode: TamperSampleMode): Promise<ExportResult> {
    const src = this.latestExport
    if (!src) throw new ApiRequestError(409, 'Export a package first')
    const n = src.frameCount
    let ledger = [...src.ledger]
    let description: string
    if (mode === 'modify') {
      description = `Frame #${Math.floor(n * 0.4)} blurred (40% into the recording)`
    } else if (mode === 'delete') {
      const g = Math.floor(n * 0.5)
      ledger = ledger.filter((r) => r.seq < g || r.seq >= g + 10)
      description = `Frames #${g}–#${g + 9} removed (files and ledger lines)`
    } else {
      ledger = ledger.filter((r) => r.seq < n - 30)
      description = 'Last 30 frames and their ledger lines dropped; seal left in place'
    }
    const info = await this.buildPackage(mode, { ...src, ledger })
    return this.toExportResult(info, description)
  }

  async downloadEvidence(filename: string): Promise<Blob> {
    const p = this.packages.get(filename)
    if (!p) throw new ApiRequestError(404, `No such package: ${filename}`)
    return p.blob
  }

  async verifyEvidence(file: Blob, filename?: string): Promise<VerificationReport> {
    const t0 = performance.now()
    const bytes = new Uint8Array(await file.arrayBuffer())
    const sha = toHex(await sha256(bytes))
    let pkg = [...this.packages.values()].find((p) => p.sha === sha) ?? null
    let mode: PackageMode | null = pkg?.mode ?? null
    if (!mode) {
      const head = new TextDecoder().decode(bytes.subarray(0, 200))
      const m = /^FRAMESEAL-MOCK-PACKAGE 1\nmode=(authentic|modify|delete|truncate)/.exec(head)
      if (!m) throw new ApiRequestError(400, 'Not a FrameSeal evidence package')
      mode = m[1] as PackageMode
      pkg = [...this.packages.values()].find((p) => p.mode === mode) ?? null
    }
    if (!pkg) throw new ApiRequestError(400, 'Package not recognised by this mock session')

    const n = pkg.frameCount
    const ci = pkg.ci
    const sid = pkg.session.session_id ?? ''
    const incidents: Incident[] = []
    let verdict: VerificationReport['verdict'] = 'AUTHENTIC'
    let framesTotal = n
    let framesTampered = 0
    let framesMissing = 0
    let framesUnverified = 0
    let checkpointsTotal = Math.floor(n / ci)
    let sealValid = true
    const at = new Date().toISOString()
    const vinc = (partial: Partial<Incident> & Pick<Incident, 'kind' | 'title' | 'explanation' | 'proof'>): Incident => ({
      id: id4('vinc', ++this.counters.vincident),
      kinds_seen: [partial.kind],
      severity: 'critical',
      status: 'closed',
      seq_from: 0,
      seq_to: 0,
      affected_count: 1,
      missing_count: 0,
      opened_at: at,
      closed_at: at,
      detection_latency_ms: null,
      attack_id: null,
      attack_type: null,
      evidence: { sample_seq: 0, expected_hash: null, actual_hash: null, expected_prev: null, actual_prev: null, visual_change_pct: null },
      acknowledged: false,
      ...partial,
    })

    if (mode === 'modify') {
      const s = Math.floor(n * 0.4)
      const rec = pkg.ledger.find((r) => r.seq === s)
      const expected = rec?.frame_hash ?? (await sha256Hex(utf8(`${sid}:${s}`)))
      const actual = await sha256Hex(utf8(`${expected}:blurred`))
      verdict = 'TAMPERED'
      framesTampered = 1
      incidents.push(
        vinc({
          kind: 'FRAME_MODIFIED',
          title: 'Frame content altered',
          explanation: "The picture in this file no longer matches the fingerprint the camera recorded when it captured it.",
          proof: `SHA-256(frames/${String(s).padStart(8, '0')}.jpg) = ${actual.slice(0, 4)}…${actual.slice(-4)}  ≠  ledger ${expected.slice(0, 4)}…${expected.slice(-4)}`,
          seq_from: s,
          seq_to: s,
          evidence: { sample_seq: s, expected_hash: expected, actual_hash: actual, expected_prev: null, actual_prev: null, visual_change_pct: 18.8 },
        }),
      )
    } else if (mode === 'delete') {
      const g = Math.floor(n * 0.5)
      verdict = 'TAMPERED'
      framesMissing = 10
      framesUnverified = g % ci
      incidents.push(
        vinc({
          kind: 'FRAME_DELETED',
          title: 'Frames deleted',
          explanation: 'Frames the camera recorded are missing from the package. The sequence numbers jump, so footage was removed.',
          proof: `Ledger jumps from #${g - 1} to #${g + 10} — 10 frames missing`,
          seq_from: g,
          seq_to: g + 9,
          affected_count: 10,
          missing_count: 10,
          evidence: { sample_seq: g, expected_hash: null, actual_hash: null, expected_prev: null, actual_prev: null, visual_change_pct: null },
        }),
      )
    } else if (mode === 'truncate') {
      verdict = 'INCOMPLETE'
      framesTotal = Math.max(0, n - 30)
      checkpointsTotal = Math.floor(framesTotal / ci)
      sealValid = false
    }

    const report: VerificationReport = {
      report_id: id4('rpt', ++this.counters.report),
      verdict,
      package_filename: filename ?? (file instanceof File ? file.name : pkg.filename),
      package_sha256: sha,
      session_id: sid,
      device_id: this.device.device_id,
      public_key_hex: this.device.public_key_hex,
      first_frame_at: pkg.firstAt,
      last_frame_at: pkg.lastAt,
      frames_total: framesTotal,
      frames_ok: Math.max(0, framesTotal - framesTampered - framesMissing - framesUnverified),
      frames_tampered: framesTampered,
      frames_missing: framesMissing,
      checkpoints_total: checkpointsTotal,
      checkpoints_valid: checkpointsTotal,
      seal_valid: sealValid,
      chain_head: mode === 'truncate' ? (pkg.ledger.at(-1)?.chain_hash ?? null) : pkg.chainHead,
      incidents,
      verified_at: at,
      verify_ms: round3(performance.now() - t0 + n * 0.04),
    }
    this.reports.set(report.report_id, report)
    return report
  }

  // --- API surface -----------------------------------------------------------------------------------

  createApi(): ApiClient {
    const call = async <T>(fn: () => T | Promise<T>): Promise<T> => {
      await this.ready
      await sleep(20 + Math.random() * 40)
      return clone(await fn())
    }
    const imgUrl = (b64: string | undefined) => (b64 ? `data:image/jpeg;base64,${b64}` : ABSENT)
    return {
      health: () => call(() => ({ status: 'ok' as const, version: '1.0' })),
      getDevice: () => call(() => this.device),
      getSession: () => call(() => this.session),
      startSession: (req) => call(() => this.startSession(req)),
      stopSession: () => call(() => this.stopSession()),
      getStats: () => call(() => this.stats()),
      getAttackCatalog: () => call(() => CATALOG),
      launchAttack: (type: AttackType, params = {}) =>
        call((): AttackAck => {
          if (!this.run?.timer) throw new ApiRequestError(409, 'No session is running')
          return this.run.engine.launch(type, params)
        }),
      getIncidents: () => call(() => this.incidents),
      ackIncident: (id) =>
        call(() => {
          const inc = this.incidents.find((x) => x.id === id)
          if (!inc) throw new ApiRequestError(404, `No such incident: ${id}`)
          inc.acknowledged = true
          this.broadcast({ type: 'incident', incident: inc })
          return inc
        }),
      getChain: (limit = 50) => call(() => (this.run ? this.run.ledger.slice(-limit).reverse() : [])),
      exportEvidence: () => call(() => this.exportEvidence()),
      downloadEvidence: async (filename) => {
        await this.ready
        return this.downloadEvidence(filename)
      },
      verifyEvidence: (file, filename) => call(() => this.verifyEvidence(file, filename)),
      tamperSample: (mode) => call(() => this.tamperSample(mode)),
      getReport: (reportId) =>
        call(() => {
          const r = this.reports.get(reportId)
          if (!r) throw new ApiRequestError(404, `No such report: ${reportId}`)
          return r
        }),
      originalUrl: (seq) => imgUrl(this.run?.vault.get(seq)),
      receivedUrl: (seq) => {
        const v = this.run?.verifier
        return v && v.timeline.get(seq) === 'tampered' ? imgUrl(v.received.get(seq)) : ABSENT
      },
      diffUrl: (seq) => this.diffs.get(seq) ?? ABSENT,
    }
  }

  createLive(): LiveConnection {
    const messageListeners = new Set<(msg: LiveMessage) => void>()
    const stateListeners = new Set<(s: ConnectionState) => void>()
    let state: ConnectionState = 'closed'
    let wanted = false
    const setState = (s: ConnectionState) => {
      if (s === state) return
      state = s
      stateListeners.forEach((cb) => cb(s))
    }
    const sink = (msg: LiveMessage) => messageListeners.forEach((cb) => cb(msg))
    return {
      connect: () => {
        if (wanted) return
        wanted = true
        setState('connecting')
        void this.ready.then(async () => {
          await sleep(150)
          if (!wanted) return
          setState('open')
          this.addClient(sink)
        })
      },
      close: () => {
        wanted = false
        this.removeClient(sink)
        setState('closed')
      },
      getState: () => state,
      onMessage: (cb) => {
        messageListeners.add(cb)
        return () => messageListeners.delete(cb)
      },
      onState: (cb) => {
        stateListeners.add(cb)
        return () => stateListeners.delete(cb)
      },
    }
  }
}

