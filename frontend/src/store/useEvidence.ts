// Evidence screen state (kept outside React so it survives switching to the Report view and back).
// All server calls go through `api` — components never fetch directly.

import { create } from 'zustand'
import { api } from '../api/backend'
import { ApiRequestError } from '../api/client'
import type { ExportResult, TamperSampleMode, VerificationReport } from '../api/types'
import { useLive } from './useLive'

export type ExportStep = 'idle' | 'stopping' | 'packaging' | 'done' | 'error'
export type ExportedPackage = ExportResult & { snapshot: boolean; sealSeq: number | null }

export type VerifyPhase = 'idle' | 'running' | 'done' | 'error'

export type JudgeEntry = { status: 'idle' | 'working' | 'done' | 'error'; result: ExportResult | null; error: string | null }

type EvidenceState = {
  exportStep: ExportStep
  exportError: string | null
  exported: ExportedPackage | null

  verifyPhase: VerifyPhase
  verifyFilename: string | null
  verifyEstimate: number | null
  verifyError: string | null
  report: VerificationReport | null

  judge: Record<TamperSampleMode, JudgeEntry>

  exportPackage(mode: 'stop' | 'snapshot'): Promise<void>
  verify(file: Blob, filename: string): Promise<void>
  verifyExported(): Promise<void>
  makeTamperCopy(mode: TamperSampleMode): Promise<void>
  verifyTamperCopy(mode: TamperSampleMode): Promise<void>
  resetVerify(): void
}

const errText = (err: unknown) =>
  err instanceof ApiRequestError ? err.detail : err instanceof Error ? err.message : String(err)

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Verification of a small package takes ~100 ms; keep the progress visible long enough to read. */
const MIN_VERIFY_MS = 1400

const emptyJudge = (): JudgeEntry => ({ status: 'idle', result: null, error: null })

export const useEvidence = create<EvidenceState>()((set, get) => ({
  exportStep: 'idle',
  exportError: null,
  exported: null,
  verifyPhase: 'idle',
  verifyFilename: null,
  verifyEstimate: null,
  verifyError: null,
  report: null,
  judge: { modify: emptyJudge(), delete: emptyJudge(), truncate: emptyJudge() },

  async exportPackage(mode) {
    set({ exportStep: 'idle', exportError: null })
    try {
      const running = useLive.getState().session?.status === 'running'
      let sealSeq: number | null = useLive.getState().session?.seal?.last_seq ?? null
      if (mode === 'stop' && running) {
        set({ exportStep: 'stopping' })
        // POST /session/stop returns once the seal record is written (§3.8)
        const stopped = await api.stopSession()
        sealSeq = stopped.seal?.last_seq ?? null
      }
      set({ exportStep: 'packaging' })
      const res = await api.exportEvidence()
      set({ exportStep: 'done', exported: { ...res, snapshot: mode === 'snapshot' && running, sealSeq: mode === 'snapshot' && running ? null : sealSeq } })
    } catch (err) {
      set({ exportStep: 'error', exportError: errText(err) })
    }
  },

  async verify(file, filename) {
    set({ verifyPhase: 'running', verifyFilename: filename, verifyError: null, report: null, verifyEstimate: get().exported?.frame_count ?? null })
    const t0 = performance.now()
    try {
      const report = await api.verifyEvidence(file, filename)
      await sleep(Math.max(0, MIN_VERIFY_MS - (performance.now() - t0)))
      set({ verifyPhase: 'done', report })
    } catch (err) {
      await sleep(Math.max(0, 600 - (performance.now() - t0)))
      set({ verifyPhase: 'error', verifyError: errText(err) })
    }
  },

  async verifyExported() {
    const pkg = get().exported
    if (!pkg) return
    try {
      const blob = await api.downloadEvidence(pkg.filename)
      await get().verify(blob, pkg.filename)
    } catch (err) {
      set({ verifyPhase: 'error', verifyFilename: pkg.filename, verifyError: errText(err) })
    }
  },

  async makeTamperCopy(mode) {
    set((s) => ({ judge: { ...s.judge, [mode]: { status: 'working', result: null, error: null } } }))
    try {
      const result = await api.tamperSample(mode)
      set((s) => ({ judge: { ...s.judge, [mode]: { status: 'done', result, error: null } } }))
    } catch (err) {
      set((s) => ({ judge: { ...s.judge, [mode]: { status: 'error', result: null, error: errText(err) } } }))
    }
  },

  async verifyTamperCopy(mode) {
    const res = get().judge[mode].result
    if (!res) return
    try {
      // fetch the copy from its download URL and POST it, exactly like a dropped file
      const blob = await api.downloadEvidence(res.filename)
      await get().verify(blob, res.filename)
    } catch (err) {
      set({ verifyPhase: 'error', verifyFilename: res.filename, verifyError: errText(err) })
    }
  },

  resetVerify: () => set({ verifyPhase: 'idle', verifyFilename: null, verifyError: null, report: null }),
}))
