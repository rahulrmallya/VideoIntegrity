import { useEffect } from 'react'
import { live } from '../../api/backend'
import type { IncidentStatus } from '../../api/types'
import { toast } from '../../components/ui/Toasts'
import { detectedText, seqRange } from '../../lib/incidents'
import { useLive } from '../../store/useLive'

/** Toasts for attack started/ended and incident opened/closed, straight from the live stream. */
export function useLiveToasts() {
  useEffect(() => {
    const known = new Map<string, IncidentStatus>(useLive.getState().incidents.map((i) => [i.id, i.status]))
    return live.onMessage((msg) => {
      if (msg.type === 'attack') {
        const a = msg.attack
        if (msg.phase === 'started') toast({ tone: 'danger', title: `Attack launched: ${a.label}`, body: `${a.attack_id} · expect ${a.expected_kind}` })
        else toast({ tone: 'info', title: `Attack ended: ${a.label}`, body: 'Waiting for the verifier to re-seal the stream…' })
      } else if (msg.type === 'incident') {
        const inc = msg.incident
        const before = known.get(inc.id)
        known.set(inc.id, inc.status)
        if (before === undefined && inc.status === 'open') {
          // A FRAME_DELETED incident is re-classified to FRAME_REORDERED a few ms later (§5.1):
          // wait a beat and toast the latest version.
          setTimeout(() => {
            const st = useLive.getState()
            const cur = st.incidents.find((i) => i.id === inc.id) ?? inc
            const watchdogS = st.session ? (2 * st.session.checkpoint_interval) / st.session.fps : 2
            toast({
              tone: cur.severity === 'critical' ? 'danger' : 'warning',
              title: `Incident opened — ${cur.title}`,
              body: `${detectedText(cur, watchdogS)} · ${cur.kind}`,
            })
          }, 250)
        } else if (before === 'open' && inc.status === 'closed') {
          toast({ tone: 'success', title: 'Incident closed — stream re-sealed', body: `${inc.title} · ${seqRange(inc)}` })
        }
      }
    })
  }, [])
}
