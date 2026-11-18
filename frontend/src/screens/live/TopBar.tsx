import { Fingerprint, Link2, Play, Presentation, ShieldAlert, ShieldCheck, ShieldOff, Square, Volume2, VolumeX } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { SourceKind } from '../../api/types'
import { copyText } from '../../lib/format'
import { loadSoundPref, playAlarm, saveSoundPref, unlockAudio } from '../../lib/sound'
import { useConnection, useDevice, useIntegrity, useLive, useSession, useStats } from '../../store/useLive'
import { SOURCES, useSessionControl } from './useSessionControl'
import { useUi, type View } from '../../store/useUi'

function Logo() {
  const presenter = useUi((s) => s.presenter)
  return (
    <div className="flex items-center gap-3">
      <div className="relative flex size-9 items-center justify-center rounded-xl border border-border bg-raised">
        <ShieldCheck className="size-5 text-sealed" strokeWidth={2.2} />
        <span className="absolute -right-1.5 -bottom-1.5 flex size-4.5 items-center justify-center rounded-md border border-border bg-surface">
          <Link2 className="size-3 text-pending" strokeWidth={2.5} />
        </span>
      </div>
      <div className="leading-tight">
        <div className="text-[17px] font-semibold tracking-tight text-text">FrameSeal</div>
        {!presenter && <div className="text-[11px] text-muted">Every frame sealed. Every edit caught.</div>}
      </div>
    </div>
  )
}

function SessionPill() {
  const session = useSession()
  const presenter = useUi((s) => s.presenter)
  const fps = useStats()?.fps_actual ?? 0
  if (session?.status === 'running') {
    return (
      <div className="flex items-center gap-2 rounded-full border border-border bg-raised px-3 py-1 text-xs">
        <span className="size-2 animate-blink rounded-full bg-tampered" />
        <span className="font-semibold tracking-wider text-text">LIVE</span>
        <span className="text-border">·</span>
        <span className="font-mono tabular-nums text-text">{fps.toFixed(1)}</span>
        <span className="text-muted">fps</span>
        <span className="text-border">·</span>
        <span className={`max-w-40 truncate text-muted ${presenter ? 'hidden' : ''}`} title={session.source_label ?? ''}>
          {session.source_label ?? session.source}
        </span>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2 rounded-full border border-border bg-raised px-3 py-1 text-xs text-muted">
      <span className={`size-2 rounded-full ${session?.status === 'stopped' ? 'bg-muted' : 'border border-muted'}`} />
      <span className="font-semibold tracking-wider">{session?.status === 'stopped' ? 'STOPPED' : 'NO SESSION'}</span>
    </div>
  )
}

function DeviceChip() {
  const device = useDevice()
  const [copied, setCopied] = useState(false)
  if (!device) return null
  return (
    <button
      type="button"
      onClick={async () => {
        if (await copyText(device.device_id)) {
          setCopied(true)
          setTimeout(() => setCopied(false), 1000)
        }
      }}
      title={`Device ${device.device_id}\n${device.algorithm} public key ${device.public_key_hex}\n(click to copy device id)`}
      className="flex items-center gap-1.5 rounded-full border border-border bg-raised px-2.5 py-1 text-xs text-muted hover:border-pending/50 hover:text-text"
    >
      <Fingerprint className="size-3.5" />
      <span className="font-mono tabular-nums">{copied ? 'copied' : device.device_id}</span>
    </button>
  )
}

/** Sound toggle + plays the alarm when a new incident opens. */
function SoundToggle() {
  const [on, setOn] = useState(loadSoundPref)
  const seen = useRef<Set<string> | null>(null)
  const onRef = useRef(on)
  useEffect(() => {
    onRef.current = on
  }, [on])

  useEffect(
    () =>
      useLive.subscribe((s) => {
        const ids = new Set(s.incidents.map((i) => i.id))
        if (seen.current) {
          const fresh = s.incidents.find((i) => i.status === 'open' && !seen.current!.has(i.id))
          if (fresh && onRef.current) playAlarm(fresh.severity)
        }
        seen.current = ids
      }),
    [],
  )

  const Icon = on ? Volume2 : VolumeX
  return (
    <button
      type="button"
      onClick={() => {
        const next = !on
        if (next) unlockAudio()
        setOn(next)
        saveSoundPref(next)
      }}
      title={on ? 'Alarm sound on' : 'Alarm sound off'}
      className={`flex size-8 items-center justify-center rounded-full border border-border bg-raised hover:text-text ${on ? 'text-pending' : 'text-muted'}`}
    >
      <Icon className="size-4" />
    </button>
  )
}

function ConnectionDot() {
  const c = useConnection()
  const cls = c === 'open' ? 'bg-sealed' : c === 'connecting' ? 'bg-unverified animate-blink' : 'bg-tampered'
  const label = c === 'open' ? 'Verifier connected' : c === 'connecting' ? 'Connecting to verifier…' : 'Verifier offline'
  return (
    <span title={label} className="flex size-8 items-center justify-center">
      <span className={`size-2.5 rounded-full ${cls}`} />
    </span>
  )
}

function IntegrityPill() {
  const integrity = useIntegrity()
  const big = useUi((s) => s.presenter && s.view === 'live')
  const styles = {
    SECURE: 'border-sealed/50 bg-sealed/10 text-sealed animate-breathe',
    COMPROMISED: 'border-tampered bg-tampered/15 text-tampered animate-alarm',
    IDLE: 'border-border bg-raised text-muted',
  }[integrity]
  const Icon = integrity === 'SECURE' ? ShieldCheck : integrity === 'COMPROMISED' ? ShieldAlert : ShieldOff
  return (
    <div
      className={`flex items-center rounded-lg border ${big ? 'gap-2.5 px-6 py-2' : 'gap-2 px-4 py-1.5'} ${styles}`}
      title="Stream integrity"
    >
      <Icon className={big ? 'size-6' : 'size-4.5'} strokeWidth={2.4} />
      <span className={`font-bold ${big ? 'text-[19px] tracking-[0.2em]' : 'text-[13px] tracking-[0.18em]'}`}>{integrity}</span>
    </div>
  )
}

function SessionControls() {
  const session = useSession()
  const { busy, error, start, stop } = useSessionControl()
  const [source, setSource] = useState<SourceKind>('synthetic')
  const running = session?.status === 'running'
  return (
    <div className="relative flex items-center gap-2">
      <select
        value={source}
        disabled={running || busy}
        onChange={(e) => setSource(e.target.value as SourceKind)}
        className="h-8 rounded-lg border border-border bg-raised px-2 text-xs text-text outline-none focus:border-pending/60 disabled:opacity-50"
        aria-label="Video source"
      >
        {SOURCES.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
      {running ? (
        <button
          type="button"
          disabled={busy}
          onClick={stop}
          className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-raised px-3 text-xs font-medium text-text hover:border-tampered/60 disabled:opacity-50"
        >
          <Square className="size-3.5 fill-current" /> Stop
        </button>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => start(source)}
          className="flex h-8 items-center gap-1.5 rounded-lg bg-sealed px-3 text-xs font-semibold text-bg hover:bg-sealed/90 disabled:opacity-50"
        >
          <Play className="size-3.5 fill-current" /> Start
        </button>
      )}
      {error && (
        <div className="absolute top-10 right-0 z-30 w-64 rounded-md border border-tampered/50 bg-surface px-3 py-2 text-xs text-tampered shadow-xl">
          {error}
        </div>
      )}
    </div>
  )
}

function PresenterChip() {
  const presenter = useUi((s) => s.presenter)
  const toggle = useUi((s) => s.togglePresenter)
  const openHelp = useUi((s) => s.setShortcuts)
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={toggle}
        title="Presenter mode (P)"
        className={`flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-semibold tracking-wider ${
          presenter ? 'border-pending/60 bg-pending/10 text-pending' : 'border-border bg-raised text-muted hover:text-text'
        }`}
      >
        <Presentation className="size-3.5" /> {presenter ? 'PRESENTER' : 'P'}
      </button>
      <button
        type="button"
        onClick={() => openHelp(true)}
        title="Keyboard shortcuts (?)"
        className="flex size-8 items-center justify-center rounded-full border border-border bg-raised font-mono text-[13px] text-muted hover:text-text"
      >
        ?
      </button>
    </div>
  )
}

const NAV: { view: View; label: string; key: string }[] = [
  { view: 'live', label: 'Live', key: 'L' },
  { view: 'evidence', label: 'Evidence', key: 'E' },
  { view: 'how', label: 'How it works', key: 'H' },
]

function NavTabs() {
  const view = useUi((s) => s.view)
  const navigate = useUi((s) => s.navigate)
  const current = view === 'report' ? 'evidence' : view
  return (
    <nav className="flex items-center gap-0.5 rounded-lg border border-border bg-raised/60 p-0.5" aria-label="Main">
      {NAV.map((n) => (
        <button
          key={n.view}
          type="button"
          onClick={() => navigate(n.view)}
          title={`${n.label} (${n.key})`}
          className={`flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium whitespace-nowrap transition-colors ${
            current === n.view ? 'bg-surface text-text shadow-sm ring-1 ring-border' : 'text-muted hover:text-text'
          }`}
        >
          {n.label}
          <kbd className="font-mono text-[9.5px] text-muted/60">{n.key}</kbd>
        </button>
      ))}
    </nav>
  )
}

/** L / E / H switch views (ignored while typing or with modifier keys). */
/** Global keys: L / E / H views, P presenter mode, ? shortcuts, Esc closes the shortcuts overlay. */
export function useNavKeys() {
  const navigate = useUi((s) => s.navigate)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      const ui = useUi.getState()
      if (e.key === '?') {
        ui.setShortcuts(!ui.shortcutsOpen)
        return
      }
      if (e.key === 'Escape' && ui.shortcutsOpen) {
        ui.setShortcuts(false)
        return
      }
      if (e.key.toUpperCase() === 'P') {
        ui.togglePresenter()
        return
      }
      const hit = NAV.find((n) => n.key === e.key.toUpperCase())
      if (hit) navigate(hit.view)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate])
}

export function TopBar() {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface/60 px-4 print:hidden">
      <Logo />
      <NavTabs />
      <div className="flex min-w-0 items-center gap-2">
        <SessionPill />
        <div className="hidden 2xl:block">
          <DeviceChip />
        </div>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <PresenterChip />
        <SoundToggle />
        <ConnectionDot />
        <IntegrityPill />
        <div className="mx-1 h-6 w-px bg-border" />
        <SessionControls />
      </div>
    </header>
  )
}
