// Temporary data-layer preview (task C1): proves the store is fed. The real Live screen replaces this.

import { ShieldCheck } from 'lucide-react'
import type { TimelineStatus } from '../api/types'
import { useConnection, useFrame, useIntegrity, useLatestSeal, useStats, useTimeline } from '../store/useLive'

const short = (h: string | null | undefined) => (h ? `${h.slice(0, 4)}…${h.slice(-4)}` : '—')

const CELL: Record<TimelineStatus, string> = {
  sealed: 'bg-sealed',
  pending: 'bg-pending',
  unverified: 'bg-unverified',
  tampered: 'bg-tampered',
  missing: 'bg-border ring-1 ring-inset ring-tampered',
}

function FrameView() {
  const frame = useFrame()
  if (!frame) {
    return <div className="flex aspect-[4/3] items-center justify-center rounded-lg bg-raised text-muted">waiting for frames…</div>
  }
  const bad = frame.verdict === 'tampered'
  return (
    <figure className={`overflow-hidden rounded-lg border-2 ${bad ? 'border-tampered' : 'border-border'}`}>
      <img src={`data:image/jpeg;base64,${frame.jpeg_b64}`} alt={`frame ${frame.seq}`} className="block aspect-[4/3] w-full object-cover" />
      <figcaption className="flex items-center gap-3 bg-raised px-3 py-1.5 font-mono text-xs">
        <span className="text-text">#{frame.seq}</span>
        <span className={bad ? 'text-tampered' : 'text-sealed'}>{frame.verdict}</span>
        {frame.reasons.length > 0 && <span className="text-tampered">{frame.reasons.join(' · ')}</span>}
        <span className="ml-auto text-muted" title={frame.frame_hash}>
          {short(frame.frame_hash)}
        </span>
      </figcaption>
    </figure>
  )
}

function TimelineStrip() {
  const { timeline, head } = useTimeline()
  const N = 150
  const cells = []
  for (let seq = Math.max(0, head - N + 1); seq <= head; seq++) {
    const st = timeline.get(seq)
    cells.push(<span key={seq} title={`#${seq} ${st ?? ''}`} className={`h-6 flex-1 rounded-[1px] ${st ? CELL[st] : 'bg-raised'}`} />)
  }
  return <div className="flex gap-px">{cells}</div>
}

function StatsPanel() {
  const stats = useStats()
  const seal = useLatestSeal()
  const rows: [string, string][] = stats
    ? [
        ['fps', stats.fps_actual.toFixed(1)],
        ['produced / delivered', `${stats.frames_produced} / ${stats.frames_delivered}`],
        ['sealed · pending', `${stats.frames_sealed} · ${stats.frames_pending}`],
        ['unverified · tampered · missing', `${stats.frames_unverified} · ${stats.frames_tampered} · ${stats.frames_missing}`],
        ['checkpoints ok / failed', `${stats.checkpoints_ok} / ${stats.checkpoints_failed}`],
        ['avg hash / sign / verify ms', `${stats.avg_hash_ms.toFixed(3)} / ${stats.avg_sign_ms.toFixed(3)} / ${stats.avg_verify_ms.toFixed(3)}`],
        ['chain head', short(stats.chain_head)],
        ['last detection latency', stats.last_detection_latency_ms !== null ? `${stats.last_detection_latency_ms} ms` : '—'],
      ]
    : []
  return (
    <div className="space-y-3">
      <dl className="space-y-1 font-mono text-xs">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-4">
            <dt className="text-muted">{k}</dt>
            <dd className="text-text">{v}</dd>
          </div>
        ))}
      </dl>
      {seal && (
        <div className={`rounded-md border px-3 py-2 font-mono text-xs ${seal.valid ? 'border-sealed/40 text-sealed' : 'border-tampered/60 text-tampered'}`}>
          seal #{seal.seq} {seal.valid ? 'valid' : 'INVALID'} · window {seal.window_from}–{seal.window_to} · sig {short(seal.signature)}
        </div>
      )}
    </div>
  )
}

export function DevPreview() {
  const connection = useConnection()
  const integrity = useIntegrity()
  const pill =
    integrity === 'COMPROMISED' ? 'bg-tampered/15 text-tampered' : integrity === 'SECURE' ? 'bg-sealed/15 text-sealed' : 'bg-raised text-muted'
  return (
    <main className="flex h-full flex-col gap-4 p-6">
      <header className="flex items-center gap-3">
        <ShieldCheck className="size-6 text-sealed" />
        <h1 className="text-xl font-semibold tracking-tight">FrameSeal</h1>
        <span className="text-sm text-muted">Every frame sealed. Every edit caught.</span>
        <span className={`ml-auto rounded-full px-3 py-1 font-mono text-xs ${pill}`}>{integrity}</span>
        <span className="font-mono text-xs text-muted">ws: {connection}</span>
      </header>
      <section className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_380px] gap-6">
        <div className="min-h-0 max-w-[min(100%,calc((100vh-220px)*4/3))]">
          <FrameView />
        </div>
        <StatsPanel />
      </section>
      <TimelineStrip />
    </main>
  )
}
