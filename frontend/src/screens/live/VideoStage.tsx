import { AnimatePresence, motion } from 'motion/react'
import { ChevronRight, Shield, ShieldAlert, ShieldCheck, ShieldQuestion, SquareStop, WifiOff } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { originalUrl } from '../../api/backend'
import type { Incident } from '../../api/types'
import { clockFromNs, shortHash } from '../../lib/format'
import { fmtLatency } from '../../lib/incidents'
import { useFrame, useLatestSeal, useLive, useOpenIncident, useSeqStatus, useSession } from '../../store/useLive'
import { useUi } from '../../store/useUi'

/**
 * Paints only the newest frame, on requestAnimationFrame. Frames that arrive while one is decoding are
 * skipped. A slow fallback timer keeps painting if rAF is throttled (window occluded on a projector setup).
 */
function useFramePainter(canvasRef: React.RefObject<HTMLCanvasElement | null>, onTampered: () => void) {
  const tamperedCb = useRef(onTampered)
  useEffect(() => {
    tamperedCb.current = onTampered
  }, [onTampered])

  useEffect(() => {
    let pending: string | null = useLive.getState().frame?.jpeg_b64 ?? null
    let decoding = false
    let raf = 0
    let lastPaint = 0
    const img = new Image()

    const paint = () => {
      if (!pending || decoding) return
      const b64 = pending
      pending = null
      decoding = true
      img.src = `data:image/jpeg;base64,${b64}`
      img
        .decode()
        .then(() => {
          const c = canvasRef.current
          const ctx = c?.getContext('2d')
          if (!c || !ctx) return
          if (c.width !== img.naturalWidth || c.height !== img.naturalHeight) {
            c.width = img.naturalWidth
            c.height = img.naturalHeight
          }
          ctx.drawImage(img, 0, 0)
          lastPaint = performance.now()
        })
        .catch(() => {})
        .finally(() => {
          decoding = false
        })
    }
    const loop = () => {
      paint()
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    const fallback = setInterval(() => {
      if (performance.now() - lastPaint > 250) paint()
    }, 250)

    const unsub = useLive.subscribe((s, prev) => {
      if (s.frame && s.frame !== prev.frame) {
        pending = s.frame.jpeg_b64
        if (s.frame.verdict === 'tampered') tamperedCb.current()
      }
    })
    return () => {
      cancelAnimationFrame(raf)
      clearInterval(fallback)
      unsub()
    }
  }, [canvasRef])
}

/** RGB-split glitch: 300 ms, re-armed at most every 700 ms so a 30-frame attack keeps flickering. */
function useGlitch(): [boolean, () => void] {
  const [on, setOn] = useState(false)
  const last = useRef(0)
  const trigger = () => {
    const now = performance.now()
    if (now - last.current < 700) return
    last.current = now
    setOn(true)
    setTimeout(() => setOn(false), 300)
  }
  return [on, trigger]
}

/** Seconds since the last frame message, refreshed 4×/s — drives NO SIGNAL. */
function useFrameAge(): number {
  const [age, setAge] = useState(0)
  useEffect(() => {
    let lastAt = performance.now()
    const unsub = useLive.subscribe((s, prev) => {
      if (s.frame !== prev.frame) lastAt = performance.now()
    })
    const t = setInterval(() => setAge((performance.now() - lastAt) / 1000), 250)
    return () => {
      unsub()
      clearInterval(t)
    }
  }, [])
  return age
}

type Badge = 'SEALED' | 'PENDING' | 'TAMPERED' | 'UNVERIFIED'

const BADGE: Record<Badge, { cls: string; Icon: typeof Shield }> = {
  SEALED: { cls: 'border-sealed/60 bg-sealed/15 text-sealed', Icon: ShieldCheck },
  PENDING: { cls: 'border-pending/50 bg-pending/10 text-pending', Icon: Shield },
  TAMPERED: { cls: 'border-tampered bg-tampered/25 text-tampered', Icon: ShieldAlert },
  UNVERIFIED: { cls: 'border-unverified/60 bg-unverified/15 text-unverified', Icon: ShieldQuestion },
}

function FrameBadge({ lowered }: { lowered: boolean }) {
  const frame = useFrame()
  const status = useSeqStatus(frame?.seq ?? -1)
  const seal = useLatestSeal()
  const ci = useSession()?.checkpoint_interval ?? 15
  const [flash, setFlash] = useState(false)

  useEffect(() => {
    if (!seal?.valid) return
    setFlash(true)
    const t = setTimeout(() => setFlash(false), 550)
    return () => clearTimeout(t)
  }, [seal])

  if (!frame) return null
  const badge: Badge =
    frame.verdict === 'tampered' || status === 'tampered'
      ? 'TAMPERED'
      : flash || status === 'sealed'
        ? 'SEALED'
        : status === 'unverified'
          ? 'UNVERIFIED'
          : 'PENDING'
  const { cls, Icon } = BADGE[badge]
  const progress = ((frame.seq % ci) + 1) / ci
  return (
    <div
      className={`absolute right-3 z-30 overflow-hidden rounded-lg border backdrop-blur-md ${cls} ${
        lowered ? 'top-[66px]' : 'top-3'
      }`}
    >
      <div className="flex items-center gap-1.5 px-2.5 py-1.5">
        <Icon className="size-4" strokeWidth={2.4} />
        <span className="text-[11px] font-bold tracking-[0.16em]">{badge}</span>
      </div>
      {badge === 'PENDING' && (
        <div className="h-0.5 bg-pending/15" title="Progress to the next signed checkpoint">
          <div className="h-full bg-pending transition-[width] duration-75" style={{ width: `${progress * 100}%` }} />
        </div>
      )}
    </div>
  )
}

function HudStrip() {
  const frame = useFrame()
  if (!frame) return null
  const bad = frame.verdict === 'tampered'
  return (
    <div className="absolute inset-x-0 bottom-0 z-10 flex items-end gap-3 bg-gradient-to-t from-black/80 via-black/45 to-transparent px-4 pt-8 pb-2.5 font-mono text-[12px] tabular-nums">
      <span className="rounded bg-white/10 px-1.5 py-0.5 font-semibold text-text">#{frame.seq}</span>
      <span className="pb-0.5 text-muted">{clockFromNs(frame.ts_ns)}</span>
      <span
        className={`ml-auto truncate pb-0.5 ${bad ? 'text-tampered' : 'text-muted'}`}
        title={`computed ${frame.computed_hash}\nrecorded ${frame.frame_hash}`}
      >
        SHA-256 <span className={bad ? 'font-semibold text-tampered' : 'text-text'}>{shortHash(frame.computed_hash)}</span>
        {frame.computed_hash !== frame.frame_hash && <> ≠ recorded {shortHash(frame.frame_hash)}</>}
      </span>
    </div>
  )
}

function TamperBanner({ incident, onOpen }: { incident: Incident; onOpen: () => void }) {
  const warning = incident.severity === 'warning'
  return (
    <motion.button
      type="button"
      onClick={onOpen}
      title="Open the forensic view"
      initial={{ y: -48, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: -48, opacity: 0 }}
      transition={{ type: 'spring', stiffness: 420, damping: 32 }}
      className={`absolute inset-x-0 top-0 z-20 flex h-[54px] cursor-pointer items-center gap-3 px-4 text-left ${
        warning ? 'bg-unverified/90 text-bg' : 'bg-tampered/90 text-white'
      } shadow-lg backdrop-blur-sm`}
    >
      {warning ? <WifiOff className="size-6 shrink-0" /> : <ShieldAlert className="size-6 shrink-0 animate-blink" />}
      <div className="min-w-0 leading-tight">
        <div className="truncate text-[15px] font-extrabold tracking-[0.06em]">
          {warning ? 'SIGNAL LOST' : 'TAMPERING DETECTED'} — {incident.title}
        </div>
        <div className="truncate font-mono text-[11px] opacity-85">
          {incident.kind}
          {incident.detection_latency_ms !== null && ` · caught in ${fmtLatency(incident.detection_latency_ms)}`}
          {` · ${incident.affected_count} frame${incident.affected_count === 1 ? '' : 's'} affected`}
        </div>
      </div>
      <span className="ml-auto flex shrink-0 items-center gap-1 rounded-md bg-black/20 px-2 py-1 text-[11px] font-semibold">
        Forensics <ChevronRight className="size-3.5" />
      </span>
    </motion.button>
  )
}

function lastSealedSeq(): number | null {
  let best: number | null = null
  for (const [seq, st] of useLive.getState().timeline) if (st === 'sealed' && (best === null || seq > best)) best = seq
  return best
}

function NoSignal() {
  const [seq] = useState(lastSealedSeq)
  const [thumbOk, setThumbOk] = useState(true)
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-bg/75 backdrop-grayscale"
      style={{ backgroundImage: 'repeating-linear-gradient(0deg, rgb(255 255 255 / 0.035) 0 1px, transparent 1px 3px)' }}
    >
      <WifiOff className="size-10 text-unverified" />
      <div className="text-3xl font-bold tracking-[0.3em] text-text">NO SIGNAL</div>
      <div className="flex items-center gap-3 rounded-lg border border-border bg-surface/90 p-2 pr-4">
        {seq !== null && thumbOk && (
          <img src={originalUrl(seq)} onError={() => setThumbOk(false)} alt="" className="h-12 rounded border border-sealed/40" />
        )}
        <span className="text-sm text-muted">
          last sealed frame <span className="font-mono text-sealed">#{seq ?? '—'}</span>
        </span>
      </div>
    </motion.div>
  )
}

export function VideoStage() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [glitch, triggerGlitch] = useGlitch()
  useFramePainter(canvasRef, triggerGlitch)
  const incident = useOpenIncident()
  const openDrawer = useUi((st) => st.openDrawer)
  const session = useSession()
  const hasFrame = useLive((s) => s.frame !== null)
  const age = useFrameAge()

  const critical = incident !== null && incident.severity === 'critical'
  const noSignal = incident?.kind === 'STREAM_INTERRUPTED' && age > 1
  const stopped = session?.status === 'stopped'

  return (
    <section
      className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-2xl border border-border bg-surface p-3"
      style={{
        containerType: 'size',
        backgroundImage: 'radial-gradient(ellipse at 50% 0%, rgb(34 211 238 / 0.05), transparent 60%)',
      }}
    >
      <div
        className={`relative overflow-hidden rounded-xl bg-black ring-1 transition-shadow duration-500 ${
          critical ? 'ring-tampered/70' : 'ring-white/5'
        }`}
        style={{ width: 'min(100cqw, calc(100cqh * 4 / 3))', aspectRatio: '4 / 3' }}
      >
        <canvas ref={canvasRef} className={`block size-full ${glitch ? 'animate-glitch' : ''}`} />
        {!hasFrame && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted">Waiting for the first frame…</div>
        )}
        {!noSignal && <FrameBadge lowered={incident !== null} />}
        <HudStrip />
        {critical && <div className="pointer-events-none absolute inset-0 z-10 rounded-xl animate-alarm-inset" />}
        <AnimatePresence>{noSignal && <NoSignal key="nosignal" />}</AnimatePresence>
        <AnimatePresence>{incident && <TamperBanner key={incident.id} incident={incident} onOpen={() => openDrawer(incident.id)} />}</AnimatePresence>
        {stopped && !incident && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-bg/60 backdrop-grayscale">
            <div className="flex items-center gap-3 rounded-xl border border-border bg-surface/95 px-5 py-3 text-sm">
              <SquareStop className="size-5 text-muted" />
              <div>
                <div className="font-semibold text-text">Session ended — recording sealed</div>
                {session.seal && (
                  <div className="font-mono text-xs text-muted">
                    {session.seal.frame_count} frames · head {shortHash(session.seal.chain_hash)} · sig {shortHash(session.seal.signature)}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
