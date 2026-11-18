import { Fingerprint, Link2, Play, ShieldAlert, ShieldCheck, ShieldOff, Square, Volume2, VolumeX } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { SourceKind } from '../../api/types'
import { copyText } from '../../lib/format'
import { loadSoundPref, playAlarm, saveSoundPref, unlockAudio } from '../../lib/sound'
import { useConnection, useDevice, useIntegrity, useLive, useSession, useStats } from '../../store/useLive'
import { SOURCES, useSessionControl } from './useSessionControl'

function Logo() {
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
        <div className="text-[11px] text-muted">Every frame sealed. Every edit caught.</div>
      </div>
    </div>
  )
}

function SessionPill() {
  const session = useSession()
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
        <span className="max-w-40 truncate text-muted" title={session.source_label ?? ''}>
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
  const styles = {
    SECURE: 'border-sealed/50 bg-sealed/10 text-sealed animate-breathe',
    COMPROMISED: 'border-tampered bg-tampered/15 text-tampered animate-alarm',
    IDLE: 'border-border bg-raised text-muted',
  }[integrity]
  const Icon = integrity === 'SECURE' ? ShieldCheck : integrity === 'COMPROMISED' ? ShieldAlert : ShieldOff
  return (
    <div className={`flex items-center gap-2 rounded-lg border px-4 py-1.5 ${styles}`} title="Stream integrity">
      <Icon className="size-4.5" strokeWidth={2.4} />
      <span className="text-[13px] font-bold tracking-[0.18em]">{integrity}</span>
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

export function TopBar() {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface/60 px-4">
      <Logo />
      <div className="ml-4 flex items-center gap-2">
        <SessionPill />
        <DeviceChip />
      </div>
      <div className="ml-auto flex items-center gap-2">
        <SoundToggle />
        <ConnectionDot />
        <IntegrityPill />
        <div className="mx-1 h-6 w-px bg-border" />
        <SessionControls />
      </div>
    </header>
  )
}
