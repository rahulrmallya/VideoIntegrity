// Debug overlay (?debug=1 only): live message rates, session controls, the 7 attacks and evidence checks.

import { useEffect, useState } from 'react'
import { ApiRequestError } from '../api/client'
import { api, IS_MOCK, live } from '../api/backend'
import type { AttackType, LiveMessageType, TamperSampleMode } from '../api/types'
import { fmtLatency } from '../lib/incidents'
import { useActiveAttack, useConnection, useIncidents, useSession } from '../store/useLive'

const TYPES: LiveMessageType[] = ['frame', 'status', 'seal', 'stats', 'incident', 'attack', 'session', 'hello']

const ATTACKS: { type: AttackType; short: string }[] = [
  { type: 'PIXEL_TAMPER', short: 'PIXEL' },
  { type: 'FRAME_DROP', short: 'DROP' },
  { type: 'FRAME_INSERT', short: 'INSERT' },
  { type: 'FRAME_REORDER', short: 'REORDER' },
  { type: 'LOOP_REPLAY', short: 'REPLAY' },
  { type: 'CHAIN_FORGE', short: 'FORGE' },
  { type: 'STREAM_CUT', short: 'CUT' },
]

function errText(err: unknown): string {
  if (err instanceof ApiRequestError) return `${err.status}: ${err.detail}`
  return err instanceof Error ? err.message : String(err)
}

function useMessageRates(): Record<string, number> {
  const [rates, setRates] = useState<Record<string, number>>({})
  useEffect(() => {
    let counts: Record<string, number> = {}
    const off = live.onMessage((m) => {
      counts[m.type] = (counts[m.type] ?? 0) + 1
    })
    const timer = setInterval(() => {
      setRates(counts)
      counts = {}
    }, 1000)
    return () => {
      off()
      clearInterval(timer)
    }
  }, [])
  return rates
}

const btn =
  'rounded border border-border bg-raised px-1.5 py-0.5 text-[10px] font-medium text-text hover:border-pending/60 disabled:cursor-not-allowed disabled:opacity-40'

export function DebugOverlay() {
  const [open, setOpen] = useState(true)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const rates = useMessageRates()
  const connection = useConnection()
  const session = useSession()
  const attack = useActiveAttack()
  const incidents = useIncidents()
  const running = session?.status === 'running'

  const run = async (label: string, fn: () => Promise<string>) => {
    setBusy(true)
    try {
      setNote(`${label}: ${await fn()}`)
    } catch (err) {
      setNote(`${label} failed — ${errText(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const verify = async (mode: 'authentic' | TamperSampleMode) => {
    const pkg = mode === 'authentic' ? await api.exportEvidence() : await api.tamperSample(mode)
    const blob = await api.downloadEvidence(pkg.filename)
    const report = await api.verifyEvidence(blob, pkg.filename)
    return `${report.verdict} (${report.frames_total} frames, ${report.frames_missing} missing, ${report.frames_tampered} tampered)`
  }

  if (!open) {
    return (
      <button className={`fixed top-16 right-3 z-50 ${btn}`} onClick={() => setOpen(true)}>
        debug
      </button>
    )
  }

  return (
    <aside className="fixed top-16 right-3 z-50 w-[340px] rounded-lg border border-border bg-surface/95 p-3 font-mono text-[11px] text-muted shadow-2xl shadow-black/60 backdrop-blur">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-text">
          DEBUG · {IS_MOCK ? 'MOCK' : 'LIVE'} ·{' '}
          <span className={connection === 'open' ? 'text-sealed' : connection === 'connecting' ? 'text-unverified' : 'text-tampered'}>
            {connection}
          </span>
        </span>
        <button className={btn} onClick={() => setOpen(false)}>
          hide
        </button>
      </div>

      <div className="grid grid-cols-4 gap-x-2 gap-y-0.5">
        {TYPES.map((t) => (
          <div key={t} className="flex justify-between">
            <span>{t}</span>
            <span className={(rates[t] ?? 0) > 0 ? 'text-pending' : ''}>{rates[t] ?? 0}</span>
          </div>
        ))}
      </div>
      <div className="mt-0.5 text-[10px]">messages per second</div>

      <div className="mt-3 flex items-center gap-1.5">
        <span className="mr-auto">
          session <span className="text-text">{session?.status ?? '—'}</span>
          {session?.session_id ? ` ${session.session_id.slice(0, 8)}` : ''}
        </span>
        <button className={btn} disabled={busy} onClick={() => run('start', async () => (await api.startSession({ source: 'synthetic' })).status)}>
          start
        </button>
        <button className={btn} disabled={busy || !running} onClick={() => run('stop', async () => (await api.stopSession()).status)}>
          stop
        </button>
      </div>

      <div className="mt-3">
        attack{' '}
        <span className={attack ? 'text-tampered' : 'text-text'}>{attack ? `${attack.attack_id} ${attack.type}` : 'none'}</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        {ATTACKS.map((a) => (
          <button
            key={a.type}
            className={btn}
            disabled={!running || attack !== null}
            title={a.type}
            onClick={() => run(a.type, async () => (await api.launchAttack(a.type)).attack_id)}
          >
            {a.short}
          </button>
        ))}
      </div>

      <div className="mt-3">incidents ({incidents.length})</div>
      <ul className="mt-1 space-y-0.5">
        {incidents.slice(0, 5).map((i) => (
          <li key={i.id} className="flex gap-2">
            <span>{i.id.replace('inc_', '#')}</span>
            <span className={i.status === 'open' ? 'text-tampered' : 'text-text'}>{i.kind}</span>
            <span className="ml-auto">{i.detection_latency_ms !== null ? fmtLatency(i.detection_latency_ms) : '—'}</span>
            <span className={i.status === 'open' ? 'text-tampered' : 'text-sealed'}>{i.status}</span>
          </li>
        ))}
      </ul>
      {incidents[0] && (
        <div className="mt-1 truncate text-[10px]" title={incidents[0].kinds_seen.join(', ')}>
          seen {incidents[0].kinds_seen.join(',')} · seq {incidents[0].seq_from}–{incidents[0].seq_to} · aff {incidents[0].affected_count} · miss{' '}
          {incidents[0].missing_count}
        </div>
      )}

      <div className="mt-3">evidence → verify</div>
      <div className="mt-1 flex flex-wrap gap-1">
        {(['authentic', 'modify', 'delete', 'truncate'] as const).map((m) => (
          <button key={m} className={btn} disabled={busy} onClick={() => run(m, () => verify(m))}>
            {m}
          </button>
        ))}
      </div>

      {note && <div className="mt-2 break-words text-[10px] text-text">{note}</div>}
    </aside>
  )
}
