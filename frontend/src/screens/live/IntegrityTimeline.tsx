import { useEffect, useMemo, useRef } from 'react'
import type { TimelineStatus } from '../../api/types'
import { STATUS_COLOR } from '../../lib/format'
import { useLatestSeal, useLive, useTimeline } from '../../store/useLive'
import { motion } from 'motion/react'
import { Check, X } from 'lucide-react'

const N = 450 // 30 s at 15 fps
const DIAMOND_ROW = 11
const BAR_H = 24

const LEGEND: { status: TimelineStatus; label: string }[] = [
  { status: 'sealed', label: 'Sealed' },
  { status: 'pending', label: 'Pending' },
  { status: 'unverified', label: 'Unverified' },
  { status: 'tampered', label: 'Tampered' },
  { status: 'missing', label: 'Missing' },
]

function draw(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const dpr = window.devicePixelRatio || 1
  const W = canvas.clientWidth
  const H = canvas.clientHeight
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr)
    canvas.height = Math.round(H * dpr)
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, W, H)

  const { timeline, timelineHead: head, checkpoints } = useLive.getState()
  const barTop = DIAMOND_ROW + 3
  const barW = W / N
  const gap = barW > 2.2 ? 0.6 : barW > 1.4 ? 0.3 : 0

  // empty track
  ctx.fillStyle = 'rgb(20 28 46 / 0.6)'
  ctx.fillRect(0, barTop, W, BAR_H)
  if (head < 0) return

  const start = head - N + 1
  let missingFrom = -1
  const flushMissing = (endIdx: number) => {
    if (missingFrom < 0) return
    const x = missingFrom * barW
    const w = Math.max(2, (endIdx - missingFrom) * barW)
    ctx.fillStyle = STATUS_COLOR.border
    ctx.fillRect(x, barTop, w, BAR_H)
    ctx.strokeStyle = STATUS_COLOR.missing
    ctx.lineWidth = 1
    ctx.strokeRect(x + 0.5, barTop + 0.5, w - 1, BAR_H - 1)
    missingFrom = -1
  }

  for (let i = 0; i < N; i++) {
    const seq = start + i
    const st = seq >= 0 ? timeline.get(seq) : undefined
    if (st === 'missing') {
      if (missingFrom < 0) missingFrom = i
      continue
    }
    flushMissing(i)
    if (!st) continue
    ctx.fillStyle = STATUS_COLOR[st]
    ctx.fillRect(i * barW, barTop, Math.max(1, barW - gap), BAR_H)
  }
  flushMissing(N)

  // checkpoint diamonds
  for (const [seq, valid] of checkpoints) {
    const i = seq - start
    if (i < 0 || i >= N) continue
    const cx = (i + 0.5) * barW
    const cy = DIAMOND_ROW / 2 + 1
    const r = valid ? 3.6 : 4.6
    ctx.beginPath()
    ctx.moveTo(cx, cy - r)
    ctx.lineTo(cx + r, cy)
    ctx.lineTo(cx, cy + r)
    ctx.lineTo(cx - r, cy)
    ctx.closePath()
    if (!valid) {
      ctx.shadowColor = STATUS_COLOR.tampered
      ctx.shadowBlur = 8
    }
    ctx.fillStyle = valid ? STATUS_COLOR.sealed : STATUS_COLOR.tampered
    ctx.fill()
    ctx.shadowBlur = 0
    // tick down to the bar
    ctx.fillStyle = valid ? 'rgb(34 197 94 / 0.35)' : 'rgb(239 68 68 / 0.7)'
    ctx.fillRect(cx - 0.5, cy + r, 1, barTop - cy - r)
  }
}

/** A small tick that pops at the "now" end of the timeline each time a checkpoint seals. */
function SealTick() {
  const seal = useLatestSeal()
  if (!seal) return null
  return (
    <motion.span
      key={`${seal.seq}-${seal.chain_hash}`}
      initial={{ opacity: 0, scale: 0.4, y: 6 }}
      animate={{ opacity: [0, 1, 1, 0], scale: [0.4, 1.15, 1, 1], y: [6, -4, -8, -14] }}
      transition={{ duration: 1.1, times: [0, 0.2, 0.6, 1] }}
      className={`pointer-events-none absolute -top-3 -right-1 flex size-5 items-center justify-center rounded-full shadow-lg ${
        seal.valid ? 'bg-sealed text-bg shadow-sealed/40' : 'bg-tampered text-white shadow-tampered/50'
      }`}
      title={`checkpoint #${seal.seq} ${seal.valid ? 'sealed' : 'INVALID'}`}
    >
      {seal.valid ? <Check className="size-3.5" strokeWidth={3.5} /> : <X className="size-3.5" strokeWidth={3.5} />}
    </motion.span>
  )
}

function useLegendCounts(): Record<TimelineStatus, number> {
  const { timeline, head } = useTimeline()
  return useMemo(() => {
    const c: Record<TimelineStatus, number> = { sealed: 0, pending: 0, unverified: 0, tampered: 0, missing: 0 }
    for (let seq = Math.max(0, head - N + 1); seq <= head; seq++) {
      const st = timeline.get(seq)
      if (st) c[st]++
    }
    return c
  }, [timeline, head])
}

export function IntegrityTimeline() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const counts = useLegendCounts()

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let dirty = true
    let raf = 0
    const loop = () => {
      if (dirty) {
        dirty = false
        draw(canvas)
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    // fallback if rAF is throttled
    const t = setInterval(() => {
      if (dirty) {
        dirty = false
        draw(canvas)
      }
    }, 300)
    const unsub = useLive.subscribe((s, p) => {
      if (s.timeline !== p.timeline || s.checkpoints !== p.checkpoints) dirty = true
    })
    const ro = new ResizeObserver(() => {
      dirty = true
    })
    ro.observe(canvas)
    return () => {
      cancelAnimationFrame(raf)
      clearInterval(t)
      unsub()
      ro.disconnect()
    }
  }, [])

  return (
    <section className="shrink-0 rounded-2xl border border-border bg-surface px-4 pt-2.5 pb-2">
      <div className="mb-1.5 flex items-center gap-3">
        <h2 className="shrink-0 text-[11px] font-semibold tracking-[0.14em] whitespace-nowrap text-muted uppercase">Integrity timeline</h2>
        <span className="min-w-0 truncate text-[11px] text-muted/70">last 30 s · one bar per frame · ◆ checkpoint</span>
        <ul className="ml-auto flex shrink-0 items-center gap-3.5">
          {LEGEND.map(({ status, label }) => (
            <li key={status} className="flex items-center gap-1.5 text-[11px] text-muted">
              <span
                className={`size-2.5 rounded-[2px] ${status === 'missing' ? 'border border-tampered bg-border' : ''}`}
                style={status === 'missing' ? undefined : { background: STATUS_COLOR[status] }}
              />
              {label}
              <span className="font-mono tabular-nums text-text">{counts[status]}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="relative">
        <canvas ref={canvasRef} className="block h-[40px] w-full" />
        <SealTick />
      </div>
      <div className="mt-0.5 flex justify-between font-mono text-[10px] text-muted/70">
        <span>−30 s</span>
        <span>−15 s</span>
        <span>now</span>
      </div>
    </section>
  )
}
