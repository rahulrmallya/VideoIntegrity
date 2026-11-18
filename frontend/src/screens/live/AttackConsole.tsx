import { ChevronDown, ChevronUp, Crosshair, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../api/backend'
import { ApiRequestError } from '../../api/client'
import type { AttackInfo, AttackType } from '../../api/types'
import { toast } from '../../components/ui/Toasts'
import { ATTACK_BLURB, ATTACK_ICON, ATTACK_ORDER, useNow } from '../../lib/incidents'
import { useActiveAttack, useCatalog, useIncidents, useIntegrity, useLastEndedAttack, useSession } from '../../store/useLive'

/**
 * Launch gate: one attack at a time, and the next only after the previous attack has ended AND the
 * stream is back to SECURE (its incident closed) — so the presenter can't stack attacks into one incident.
 */
export function useAttackGate(catalog: AttackInfo[]) {
  const session = useSession()
  const active = useActiveAttack()
  const { attack: lastEnded, at: endedAt } = useLastEndedAttack()
  const integrity = useIntegrity()
  const incidents = useIncidents()
  const now = useNow(250)
  const [inFlight, setInFlight] = useState<AttackType | null>(null)

  let settling = false
  if (lastEnded && endedAt) {
    const linked = incidents.find((i) => i.attack_id === lastEnded.attack_id)
    // its incident is still open, or it hasn't been reported yet (give it 3 s)
    settling = linked ? linked.status === 'open' : now - endedAt < 3000
  }
  const runningType = inFlight ?? active?.type ?? null
  const labelOf = (t: AttackType) => catalog.find((c) => c.type === t)?.label ?? t

  let reason: string | null = null
  if (session?.status !== 'running') reason = 'Start a session to arm the console'
  else if (runningType) reason = `${labelOf(runningType)} — attack in progress…`
  else if (settling || integrity !== 'SECURE') reason = 'Waiting for the verifier to re-seal the stream…'

  const launch = async (type: AttackType) => {
    if (reason !== null) {
      if (runningType || settling || integrity === 'COMPROMISED') toast({ tone: 'warning', title: 'One attack at a time', body: reason })
      return
    }
    setInFlight(type)
    try {
      await api.launchAttack(type)
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 409) toast({ tone: 'warning', title: 'One attack at a time', body: err.detail })
      else if (err instanceof ApiRequestError && err.status === 422) toast({ tone: 'danger', title: 'Attack rejected', body: err.detail })
      else toast({ tone: 'danger', title: 'Could not launch attack', body: err instanceof Error ? err.message : String(err) })
    } finally {
      setInFlight(null)
    }
  }

  return { reason, canLaunch: reason === null, runningType, launch }
}

function AttackCard({
  info,
  index,
  running,
  disabled,
  onLaunch,
}: {
  info: AttackInfo
  index: number
  running: boolean
  disabled: boolean
  onLaunch: () => void
}) {
  const Icon = ATTACK_ICON[info.type]
  return (
    <button
      type="button"
      onClick={onLaunch}
      disabled={disabled && !running}
      title={`${info.description}\nExpected detection: ${info.expected_kind}\nShortcut: ${index + 1}`}
      className={`group relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border px-2 py-1.5 text-left transition-[border-color,background-color,opacity] duration-200 ${
        running
          ? 'animate-shimmer border-tampered/80 bg-[linear-gradient(110deg,rgb(239_68_68/0.08)_30%,rgb(239_68_68/0.28)_50%,rgb(239_68_68/0.08)_70%)] bg-[length:200%_100%]'
          : disabled
            ? 'cursor-not-allowed border-border bg-raised/40 opacity-40'
            : 'border-border bg-raised/70 hover:border-tampered/60 hover:bg-tampered/[0.06]'
      }`}
    >
      <div className="flex items-center justify-between">
        <span
          className={`flex size-6 items-center justify-center rounded-md ${
            running ? 'bg-tampered text-white' : 'bg-tampered/10 text-tampered group-hover:bg-tampered/20'
          }`}
        >
          {running ? <Loader2 className="size-3.5 animate-spin" /> : <Icon className="size-3.5" />}
        </span>
        <kbd className="rounded border border-border bg-surface px-1.5 font-mono text-[10px] text-muted">{index + 1}</kbd>
      </div>
      <div className="mt-1 line-clamp-2 text-[12px] leading-[1.2] font-semibold text-text">{info.label}</div>
      <div className="mt-0.5 line-clamp-2 text-[10px] leading-[1.25] text-muted">
        {running ? 'Running — watch the verifier…' : ATTACK_BLURB[info.type]}
      </div>
    </button>
  )
}

export function AttackConsole({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const storeCatalog = useCatalog()
  // keep CONTRACT §7 order (= shortcut keys) whatever order the server sends
  const catalog = useMemo(
    () => ATTACK_ORDER.map((t) => storeCatalog.find((c) => c.type === t)).filter((c): c is AttackInfo => !!c),
    [storeCatalog],
  )
  const { reason, canLaunch, runningType, launch } = useAttackGate(catalog)

  const launchRef = useRef(launch)
  useEffect(() => {
    launchRef.current = launch
  })
  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      const n = Number(e.key)
      if (Number.isInteger(n) && n >= 1 && n <= catalog.length) {
        e.preventDefault()
        void launchRef.current(catalog[n - 1].type)
      }
    },
    [catalog],
  )
  useEffect(() => {
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onKey])

  return (
    <section className="flex min-h-0 min-w-0 flex-col rounded-2xl border border-border bg-surface px-3 pt-2 pb-2.5">
      <div className="flex items-center gap-2">
        <Crosshair className="size-4 shrink-0 text-tampered" />
        <h2 className="shrink-0 text-[12px] font-semibold tracking-wide whitespace-nowrap text-text">
          Red Team Console <span className="font-normal text-muted">— try to fool the verifier</span>
        </h2>
        <span
          className={`ml-auto min-w-0 truncate text-[11px] ${canLaunch ? 'text-muted' : runningType ? 'text-tampered' : 'text-unverified'}`}
        >
          {reason ?? 'Armed — click a card or press 1–7'}
        </span>
        <button
          type="button"
          onClick={onToggle}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-text"
          title={collapsed ? 'Expand console' : 'Collapse console'}
        >
          {collapsed ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        </button>
      </div>
      {!collapsed && (
        <div className="mt-2 grid min-h-0 flex-1 grid-cols-7 gap-2">
          {catalog.map((info, i) => (
            <AttackCard
              key={info.type}
              info={info}
              index={i}
              running={runningType === info.type}
              disabled={!canLaunch}
              onLaunch={() => void launch(info.type)}
            />
          ))}
        </div>
      )}
    </section>
  )
}
