import { CheckCircle2, ShieldCheck, Siren } from 'lucide-react'
import type { Incident } from '../../api/types'
import { detectedText, KIND_ICON, seqRange, timeAgo, useNow } from '../../lib/incidents'
import { useIncidents, useSession } from '../../store/useLive'
import { useUi } from '../../store/useUi'

function Row({ inc, now, watchdogS }: { inc: Incident; now: number; watchdogS: number }) {
  const openDrawer = useUi((s) => s.openDrawer)
  const Icon = KIND_ICON[inc.kind]
  const open = inc.status === 'open'
  const critical = inc.severity === 'critical'
  const glow = critical && !inc.acknowledged
  const accent = critical ? 'bg-tampered' : 'bg-unverified'
  return (
    <button
      type="button"
      onClick={() => openDrawer(inc.id)}
      className={`flex w-full items-stretch overflow-hidden rounded-lg border text-left transition-colors hover:bg-raised ${
        glow ? 'animate-glow-red border-tampered/50 bg-tampered/[0.06]' : 'border-border bg-raised/50'
      }`}
    >
      <span className={`w-1 shrink-0 ${accent} ${open ? '' : 'opacity-50'}`} />
      <span className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-1.5">
        <Icon className={`size-4 shrink-0 ${critical ? 'text-tampered' : 'text-unverified'}`} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-[12.5px] font-semibold text-text">{inc.title}</span>
            <span className="shrink-0 font-mono text-[10.5px] text-muted">{seqRange(inc)}</span>
          </span>
          <span className="mt-0.5 flex items-center gap-2">
            <span
              className={`truncate rounded px-1.5 py-px font-mono text-[10px] ${
                critical ? 'bg-tampered/10 text-tampered' : 'bg-unverified/10 text-unverified'
              }`}
            >
              {detectedText(inc, watchdogS)}
            </span>
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-0.5">
          {open ? (
            <span className="flex items-center gap-1 text-[10px] font-bold tracking-wider text-tampered">
              <span className="size-1.5 animate-blink rounded-full bg-tampered" /> OPEN
            </span>
          ) : (
            <span className="flex items-center gap-1 text-[10px] font-semibold tracking-wider text-muted">
              <CheckCircle2 className="size-3" /> CLOSED
            </span>
          )}
          <span className="text-[10px] text-muted/70">{timeAgo(inc.opened_at, now)}</span>
        </span>
      </span>
    </button>
  )
}

export function IncidentFeed({ collapsed }: { collapsed: boolean }) {
  const incidents = useIncidents()
  const session = useSession()
  const now = useNow(1000)
  const watchdogS = session ? (2 * session.checkpoint_interval) / session.fps : 2
  const openCount = incidents.filter((i) => i.status === 'open').length

  return (
    <section className="flex min-h-0 min-w-0 flex-col rounded-2xl border border-border bg-surface px-3 pt-2 pb-2">
      <div className="flex items-center gap-2">
        <Siren className={`size-4 shrink-0 ${openCount ? 'text-tampered' : 'text-muted'}`} />
        <h2 className="text-[12px] font-semibold tracking-wide text-text">Incident feed</h2>
        <span className="font-mono text-[11px] text-muted">
          {incidents.length} total{openCount > 0 && <span className="text-tampered"> · {openCount} open</span>}
        </span>
        <span className="ml-auto truncate text-[11px] text-muted/70">click a row for forensics</span>
      </div>
      {!collapsed && (
        <div className="mt-2 min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1 [scrollbar-color:#1F2A40_transparent] [scrollbar-width:thin]">
          {incidents.length === 0 ? (
            <div className="flex h-full items-center justify-center gap-2 text-[12px] text-muted">
              <ShieldCheck className="size-4 text-sealed" /> No incidents — every frame verified.
            </div>
          ) : (
            incidents.map((inc) => <Row key={inc.id} inc={inc} now={now} watchdogS={watchdogS} />)
          )}
        </div>
      )}
    </section>
  )
}
