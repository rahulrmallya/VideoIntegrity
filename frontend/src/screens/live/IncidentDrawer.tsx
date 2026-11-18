import { AnimatePresence, motion } from 'motion/react'
import { BadgeCheck, Check, FileArchive, ImageOff, OctagonX, ScanSearch, Swords, Timer, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, diffUrl, originalUrl, receivedUrl } from '../../api/backend'
import { ApiRequestError } from '../../api/client'
import type { Incident, IncidentKind, TimelineStatus } from '../../api/types'
import { toast } from '../../components/ui/Toasts'
import { detectedText, fmtLatency, KIND_ICON, seqRange } from '../../lib/incidents'
import { useCatalog, useCheckpoints, useIncident, useSession, useTimeline } from '../../store/useLive'
import { useUi } from '../../store/useUi'

// --- hash comparison ---------------------------------------------------------------------------

function DiffLine({ label, value, other, tone }: { label: string; value: string | null; other: string | null; tone: 'expected' | 'actual' }) {
  return (
    <div className="flex items-start gap-3">
      <span className={`w-28 shrink-0 pt-0.5 text-[11px] font-medium ${tone === 'expected' ? 'text-sealed' : 'text-muted'}`}>{label}</span>
      {value ? (
        <code className="flex flex-wrap font-mono text-[13px] leading-6" title={value}>
          {Array.from({ length: Math.ceil(value.length / 8) }, (_, g) => (
            <span key={g} className="mr-1.5">
              {value
                .slice(g * 8, g * 8 + 8)
                .split('')
                .map((ch, j) => {
                  const i = g * 8 + j
                  const differs = other !== null && other[i] !== ch
                  return (
                    <span key={j} className={other === null ? 'text-text' : differs ? 'font-bold text-tampered' : 'text-muted/55'}>
                      {ch}
                    </span>
                  )
                })}
            </span>
          ))}
        </code>
      ) : (
        <span className="pt-0.5 text-[12px] text-muted italic">— none</span>
      )}
    </div>
  )
}

type Pair = { title: string; expectedLabel: string; actualLabel: string; expected: string | null; actual: string | null; note?: string }

function hashPairs(inc: Incident): Pair[] {
  const ev = inc.evidence
  const out: Pair[] = []
  if (ev.expected_hash || ev.actual_hash) {
    const labels: Partial<Record<IncidentKind, [string, string, string]>> = {
      FRAME_MODIFIED: ['Frame fingerprint · SHA-256', "camera's record", 'viewer computed'],
      FRAME_INSERTED: [`Two frames claim #${ev.sample_seq}`, 'genuine frame', 'first received'],
      REPLAY_DETECTED: ['Chain hash', 'already received', 'received again'],
      CHAIN_FORGED: ['Checkpoint chain hash', 'camera signed', 'forged chain'],
      FRAME_REORDERED: ['Chain hash of the late frame', 'in order', 'arrived late'],
    }
    const [title, e, a] = labels[inc.kind] ?? ['Hash', 'expected', 'received']
    let note: string | undefined
    if (inc.kind === 'REPLAY_DETECTED' && ev.expected_hash === ev.actual_hash)
      note = 'Identical — this exact frame had already been received once. A genuine stream never repeats a frame.'
    if (inc.kind === 'CHAIN_FORGED' && !ev.expected_hash)
      note = "The attacker can recompute every hash, but not the camera's Ed25519 signature — so no valid signature covers this chain."
    out.push({ title, expectedLabel: e, actualLabel: a, expected: ev.expected_hash, actual: ev.actual_hash, note })
  }
  if (ev.expected_prev || ev.actual_prev) {
    out.push({
      title: 'Chain link · prev_hash',
      expectedLabel: 'last verified',
      actualLabel: 'frame claims',
      expected: ev.expected_prev,
      actual: ev.actual_prev,
    })
  }
  return out
}

function HashComparison({ inc }: { inc: Incident }) {
  const pairs = hashPairs(inc)
  if (pairs.length === 0) return null
  return (
    <section className="space-y-3">
      {pairs.map((p) => (
        <div key={p.title} className="rounded-xl border border-border bg-raised/50 p-4">
          <h3 className="mb-2 text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">{p.title}</h3>
          <div className="space-y-1">
            <DiffLine label={p.expectedLabel} value={p.expected} other={p.actual} tone="expected" />
            <DiffLine label={p.actualLabel} value={p.actual} other={p.expected} tone="actual" />
          </div>
          {p.note && <p className="mt-2 text-[12px] text-muted">{p.note}</p>}
        </div>
      ))}
    </section>
  )
}

// --- FRAME_MODIFIED: three images --------------------------------------------------------------

function ImageTile({ label, getSrc, accent }: { label: string; getSrc: () => string; accent: string }) {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<'loading' | 'ok' | 'missing'>('loading')
  // the diff may still be rendering when the drawer opens: retry a couple of times
  useEffect(() => {
    if (state !== 'missing' || attempt >= 2) return
    const t = setTimeout(() => {
      setAttempt((a) => a + 1)
      setState('loading')
    }, 1500)
    return () => clearTimeout(t)
  }, [state, attempt])
  const raw = getSrc()
  const src = attempt > 0 && raw.startsWith('/') ? `${raw}?retry=${attempt}` : raw
  return (
    <figure className="min-w-0">
      <div className={`relative aspect-[4/3] overflow-hidden rounded-lg border bg-black ${accent}`}>
        {state !== 'missing' && (
          <img
            key={src + attempt}
            src={src}
            alt={label}
            onLoad={() => setState('ok')}
            onError={() => setState('missing')}
            className={`size-full object-cover transition-opacity ${state === 'ok' ? 'opacity-100' : 'opacity-0'}`}
          />
        )}
        {state === 'loading' && <div className="absolute inset-0 animate-pulse bg-raised" />}
        {state === 'missing' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-raised text-muted">
            <ImageOff className="size-5" />
            <span className="text-[11px]">Not available</span>
          </div>
        )}
      </div>
      <figcaption className="mt-1.5 text-center text-[11px] font-medium text-muted">{label}</figcaption>
    </figure>
  )
}

function ModifiedView({ inc }: { inc: Incident }) {
  const seq = inc.evidence.sample_seq
  const pct = inc.evidence.visual_change_pct
  return (
    <section>
      <h3 className="mb-2 text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">Frame #{seq} — side by side</h3>
      <div className="grid grid-cols-3 gap-2.5">
        <ImageTile label="Camera original" getSrc={() => originalUrl(seq)} accent="border-sealed/40" />
        <ImageTile label="What the viewer received" getSrc={() => receivedUrl(seq)} accent="border-tampered/60" />
        <ImageTile label="Difference heatmap" getSrc={() => diffUrl(seq)} accent="border-unverified/50" />
      </div>
      {pct !== null && (
        <div className="mt-3">
          <div className="mb-1 flex justify-between text-[11px]">
            <span className="text-muted">Visual change (perceptual dHash distance)</span>
            <span className="font-mono text-text">{pct.toFixed(1)}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-raised">
            <div className="h-full rounded-full bg-gradient-to-r from-unverified to-tampered" style={{ width: `${Math.max(1.5, Math.min(100, pct))}%` }} />
          </div>
          <p className="mt-1 text-[11px] text-muted/80">
            Even a change too small to see flips the SHA-256 completely — the fingerprint, not the eye, catches it.
          </p>
        </div>
      )}
    </section>
  )
}

// --- every other kind: a mini chain around the incident ----------------------------------------

type ChainNode = { type: 'seq'; seq: number } | { type: 'gap'; count: number }

const BLOCK: Record<TimelineStatus | 'unknown', string> = {
  sealed: 'border-sealed/60 bg-sealed/10 text-sealed',
  pending: 'border-pending/60 bg-pending/10 text-pending',
  unverified: 'border-unverified/60 bg-unverified/10 text-unverified',
  tampered: 'border-tampered bg-tampered/20 text-tampered',
  missing: 'border-dashed border-tampered/80 bg-transparent text-tampered/80',
  unknown: 'border-border bg-raised/40 text-muted',
}

function chainCaption(inc: Incident, ckpt: number | null): string {
  const s = inc.evidence.sample_seq
  switch (inc.kind) {
    case 'FRAME_DELETED':
      return `${inc.missing_count} frame${inc.missing_count === 1 ? '' : 's'} never arrived — the chain link jumps over the hole.`
    case 'FRAME_REORDERED':
      return `Frame #${s} arrived after the frame that follows it; it can never re-enter the chain.`
    case 'FRAME_INSERTED':
      return `A forged frame took #${s}'s place. When the real #${s} arrived, the two chain hashes disagreed and the next link broke.`
    case 'REPLAY_DETECTED':
      return `Old frames were sent a second time${inc.missing_count ? `, while ${inc.missing_count} live frames were withheld` : ''}.`
    case 'CHAIN_FORGED':
      return `Every frame passed its own checks, but the Ed25519 signature on checkpoint #${ckpt ?? s} does not match the forged chain — the whole window is rejected.`
    case 'CHAIN_BROKEN':
      return `Frame #${s} does not link to the chain hash before it.`
    case 'STREAM_INTERRUPTED':
      return `No packet for over 2 s${inc.missing_count ? `; ${inc.missing_count} frames never arrived` : ''}.`
    default:
      return ''
  }
}

function MiniChain({ inc, offline }: { inc: Incident; offline: boolean }) {
  const live = useTimeline()
  const liveCheckpoints = useCheckpoints()
  // A verification-report incident has nothing to do with the live timeline: use only its own data.
  const timeline = offline ? EMPTY_TIMELINE : live.timeline
  const checkpoints = offline ? EMPTY_CHECKPOINTS : liveCheckpoints
  const span = inc.seq_to - inc.seq_from + 1
  const pad = Math.max(2, Math.ceil((8 - Math.min(span, 4)) / 2))
  const seqs: number[] = []
  for (let s = Math.max(0, inc.seq_from - pad); s <= inc.seq_to + pad; s++) seqs.push(s)
  const nodes: ChainNode[] =
    seqs.length > 9
      ? [
          ...seqs.slice(0, 4).map((seq) => ({ type: 'seq' as const, seq })),
          { type: 'gap', count: seqs.length - 8 },
          ...seqs.slice(-4).map((seq) => ({ type: 'seq' as const, seq })),
        ]
      : seqs.map((seq) => ({ type: 'seq' as const, seq }))

  // The live timeline only covers the last 900 seqs of this page load (e.g. not after a reload):
  // fall back to what the incident itself says about its range.
  const inferred = (seq: number): TimelineStatus | 'unknown' => {
    if (seq < inc.seq_from || seq > inc.seq_to) return offline ? 'sealed' : 'unknown'
    if (inc.kind === 'REPLAY_DETECTED') return 'unknown'
    return inc.kind === 'FRAME_DELETED' || inc.kind === 'STREAM_INTERRUPTED' ? 'missing' : 'tampered'
  }
  const statusOf = (seq: number): TimelineStatus | 'unknown' => timeline.get(seq) ?? inferred(seq)
  const bad = (n: ChainNode | undefined) =>
    n?.type === 'gap' ? false : n ? ['tampered', 'missing'].includes(statusOf(n.seq)) || checkpoints.get(n.seq) === false : false
  const invalidCkpt = seqs.find((s) => checkpoints.get(s) === false) ?? null
  const inRange = (seq: number) => seq >= inc.seq_from && seq <= inc.seq_to

  return (
    <section>
      <h3 className="mb-2 text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">The chain around it</h3>
      <div className="flex items-center overflow-x-auto rounded-xl border border-border bg-raised/30 px-3 py-4">
        {nodes.map((n, i) => {
          const prev = nodes[i - 1]
          const broken = i > 0 && (bad(prev) || bad(n) || (n.type === 'gap' && bad(nodes[i + 1])) || (prev?.type === 'gap' && bad(nodes[i - 2])))
          return (
            <div key={n.type === 'seq' ? n.seq : `gap${i}`} className="flex items-center">
              {i > 0 && (
                <span
                  className={`h-0 w-2.5 shrink-0 border-t-2 ${broken ? 'border-dashed border-tampered' : 'border-pending/50'}`}
                  title={broken ? 'broken link' : 'linked'}
                />
              )}
              {n.type === 'gap' ? (
                <div className="flex h-16 w-[52px] shrink-0 flex-col items-center justify-center rounded-lg border border-dashed border-border text-muted">
                  <span className="text-sm leading-none">⋯</span>
                  <span className="mt-1 font-mono text-[9.5px]">+{n.count}</span>
                </div>
              ) : (
                (() => {
                  const st = statusOf(n.seq)
                  const ck = checkpoints.get(n.seq)
                  const resent = inc.kind === 'REPLAY_DETECTED' && inRange(n.seq) && st !== 'missing'
                  return (
                    <div
                      className={`relative flex h-16 w-[52px] shrink-0 flex-col items-center justify-center rounded-lg border-2 ${BLOCK[st]} ${
                        resent ? 'ring-2 ring-unverified/60 ring-offset-1 ring-offset-surface' : ''
                      }`}
                      title={`#${n.seq} · ${st}${ck !== undefined ? ` · checkpoint ${ck ? 'signature valid' : 'signature INVALID'}` : ''}`}
                    >
                      {ck !== undefined &&
                        (ck ? (
                          <BadgeCheck className="absolute -top-2 -right-2 size-4 rounded-full bg-surface text-sealed" />
                        ) : (
                          <OctagonX className="absolute -top-2 -right-2 size-4 rounded-full bg-surface text-tampered" />
                        ))}
                      <span className="font-mono text-[11px] font-semibold text-text">#{n.seq}</span>
                      <span className="mt-0.5 text-[8.5px] font-bold tracking-wider uppercase">{resent ? 're-sent' : st === 'unknown' ? '—' : st}</span>
                    </div>
                  )
                })()
              )}
            </div>
          )
        })}
      </div>
      <p className="mt-2 text-[12.5px] text-muted">{chainCaption(inc, invalidCkpt)}</p>
      <div className="mt-2 flex flex-wrap gap-3 text-[10.5px] text-muted/80">
        <span className="flex items-center gap-1">
          <span className="size-2.5 rounded-sm border-2 border-sealed/60" /> sealed
        </span>
        <span className="flex items-center gap-1">
          <span className="size-2.5 rounded-sm border-2 border-tampered bg-tampered/30" /> tampered / forged
        </span>
        <span className="flex items-center gap-1">
          <span className="size-2.5 rounded-sm border-2 border-dashed border-tampered" /> missing
        </span>
        <span className="flex items-center gap-1">
          <span className="w-3 border-t-2 border-dashed border-tampered" /> broken link
        </span>
        <span className="flex items-center gap-1">
          <OctagonX className="size-3 text-tampered" /> invalid signature
        </span>
      </div>
    </section>
  )
}

// --- drawer --------------------------------------------------------------------------------------

const EMPTY_TIMELINE = new Map<number, TimelineStatus>()
const EMPTY_CHECKPOINTS = new Map<number, boolean>()

function DrawerBody({ inc, onClose, offline }: { inc: Incident; onClose: () => void; offline: boolean }) {
  const catalog = useCatalog()
  const session = useSession()
  const goEvidence = useUi((s) => s.goEvidence)
  const [acking, setAcking] = useState(false)
  const Icon = KIND_ICON[inc.kind]
  const critical = inc.severity === 'critical'
  const attack = inc.attack_type ? catalog.find((c) => c.type === inc.attack_type) : undefined
  const watchdogS = session ? (2 * session.checkpoint_interval) / session.fps : 2

  const ack = async () => {
    setAcking(true)
    try {
      await api.ackIncident(inc.id)
    } catch (err) {
      toast({ tone: 'danger', title: 'Acknowledge failed', body: err instanceof ApiRequestError ? err.detail : String(err) })
    } finally {
      setAcking(false)
    }
  }

  return (
    <>
      <header className="relative shrink-0 border-b border-border px-6 pt-5 pb-4">
        <span className={`absolute inset-x-0 top-0 h-1 ${critical ? 'bg-tampered' : 'bg-unverified'}`} />
        <div className="flex items-start gap-3">
          <span
            className={`mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl ${
              critical ? 'bg-tampered/15 text-tampered' : 'bg-unverified/15 text-unverified'
            }`}
          >
            <Icon className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-xl leading-tight font-semibold text-text">{inc.title}</h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
              <span className="rounded bg-raised px-1.5 py-0.5 font-mono text-muted">{inc.kind}</span>
              <span
                className={`rounded px-1.5 py-0.5 font-semibold tracking-wider ${
                  inc.status === 'open' ? 'bg-tampered/15 text-tampered' : 'bg-sealed/10 text-sealed'
                }`}
              >
                {offline ? 'FOUND IN PACKAGE' : inc.status === 'open' ? 'OPEN' : 'CLOSED · stream re-sealed'}
              </span>
              <span className="font-mono text-muted">{seqRange(inc)}</span>
              <span className="text-muted">
                · {inc.affected_count} affected{inc.missing_count ? ` · ${inc.missing_count} missing` : ''}
              </span>
              <span className="font-mono text-muted/70">{inc.id}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-raised hover:text-text"
            title="Close (Esc)"
          >
            <X className="size-5" />
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5 [scrollbar-color:#1F2A40_transparent] [scrollbar-width:thin]">
        <p className="text-[17px] leading-relaxed text-text">{inc.explanation}</p>

        <section className="rounded-xl border border-pending/30 bg-pending/[0.05] p-4">
          <h3 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.12em] text-pending uppercase">
            <ScanSearch className="size-3.5" /> Why we know
          </h3>
          <p className="font-mono text-[13px] leading-relaxed break-words text-text">{inc.proof}</p>
          {inc.kinds_seen.length > 1 && (
            <p className="mt-2 text-[11.5px] text-muted">Also seen during this incident: {inc.kinds_seen.filter((k) => k !== inc.kind).join(', ')}</p>
          )}
        </section>

        <HashComparison inc={inc} />

        {inc.kind === 'FRAME_MODIFIED' ? <ModifiedView inc={inc} /> : <MiniChain inc={inc} offline={offline} />}
      </div>

      <footer className="flex shrink-0 items-center gap-4 border-t border-border bg-surface px-6 py-3.5">
        {offline ? (
          <div className="flex min-w-0 flex-1 items-center gap-1.5 text-[12px] text-muted">
            <ScanSearch className="size-3.5 shrink-0 text-pending" />
            Found by offline verification of the evidence package. Live extras (latency, attack, received image) are not part of a package.
          </div>
        ) : (
          <>
            <div className="min-w-0 flex-1 space-y-0.5 text-[12px]">
              <div className="flex items-center gap-1.5 text-text">
                <Timer className="size-3.5 text-unverified" />
                {detectedText(inc, watchdogS)}
                {inc.detection_latency_ms !== null && (inc.kind === 'CHAIN_FORGED' || inc.kind === 'STREAM_INTERRUPTED') && (
                  <span className="font-mono text-muted">· {fmtLatency(inc.detection_latency_ms)}</span>
                )}
              </div>
              <div className="flex items-center gap-1.5 truncate text-muted">
                <Swords className="size-3.5 shrink-0" />
                {inc.attack_id ? (
                  <span className="truncate">
                    Caused by <span className="font-mono text-text">{inc.attack_id}</span> · {attack?.label ?? inc.attack_type}
                  </span>
                ) : (
                  'Not linked to a console attack'
                )}
              </div>
            </div>
            <button
              type="button"
              disabled={inc.acknowledged || acking}
              onClick={ack}
              className="flex h-9 items-center gap-1.5 rounded-lg border border-border bg-raised px-3.5 text-[13px] font-medium text-text hover:border-sealed/60 disabled:cursor-default disabled:opacity-60"
            >
              <Check className="size-4" />
              {inc.acknowledged ? 'Acknowledged' : acking ? 'Acknowledging…' : 'Acknowledge'}
            </button>
            <button
              type="button"
              onClick={() => goEvidence(inc.id)}
              className="flex h-9 items-center gap-1.5 rounded-lg bg-pending px-3.5 text-[13px] font-semibold text-bg hover:bg-pending/90"
            >
              <FileArchive className="size-4" /> Export evidence
            </button>
          </>
        )}
      </footer>
    </>
  )
}

export function IncidentDrawer() {
  const drawerId = useUi((s) => s.drawerId)
  const reportIncident = useUi((s) => s.drawerIncident)
  const close = useUi((s) => s.closeDrawer)
  const liveIncident = useIncident(drawerId)
  const inc = liveIncident ?? reportIncident
  const offline = liveIncident === null && reportIncident !== null

  useEffect(() => {
    if (!inc) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [inc, close])

  return (
    <AnimatePresence>
      {inc && (
        <>
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={close}
            className="fixed inset-0 z-40 bg-bg/60 backdrop-blur-[2px] print:hidden"
          />
          <motion.aside
            key="drawer"
            role="dialog"
            aria-label={`Incident ${inc.id}`}
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 380, damping: 38 }}
            className="fixed top-0 right-0 z-50 flex h-full w-[min(640px,50vw)] min-w-[520px] flex-col border-l border-border bg-surface shadow-2xl shadow-black/70"
          >
            <DrawerBody inc={inc} onClose={close} offline={offline} />
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )
}
