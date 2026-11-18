import { BadgeCheck, Hash as HashIcon, ShieldCheck, Timer } from 'lucide-react'
import type { ReactNode } from 'react'
import { AnimatedNumber } from '../../components/ui/AnimatedNumber'
import { useStats } from '../../store/useLive'

function Tile({ icon, label, children, sub, tone = 'normal' }: { icon: ReactNode; label: string; children: ReactNode; sub: ReactNode; tone?: 'normal' | 'alert' }) {
  return (
    <div
      className={`flex min-w-0 flex-col justify-between rounded-xl border px-3 py-2 ${
        tone === 'alert' ? 'border-tampered/50 bg-tampered/5' : 'border-border bg-raised/60'
      }`}
    >
      <div className="flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.12em] text-muted uppercase">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-0.5 flex items-baseline gap-1 text-[22px] leading-tight font-medium text-text">{children}</div>
      <div className="truncate text-[10.5px] text-muted/80">{sub}</div>
    </div>
  )
}

export function MetricTiles() {
  const s = useStats()
  const failed = s?.checkpoints_failed ?? 0
  return (
    <section className="grid shrink-0 grid-cols-2 gap-2.5">
      <Tile icon={<ShieldCheck className="size-3.5 text-sealed" />} label="Frames sealed" sub={<>of {s?.frames_delivered ?? 0} delivered</>}>
        <AnimatedNumber value={s?.frames_sealed ?? 0} className="text-sealed" />
      </Tile>
      <Tile icon={<HashIcon className="size-3.5 text-pending" />} label="Avg hash time" sub="SHA-256 per frame">
        <AnimatedNumber value={s?.avg_hash_ms ?? 0} decimals={3} />
        <span className="text-xs text-muted">ms</span>
      </Tile>
      <Tile icon={<Timer className="size-3.5 text-unverified" />} label="Detection latency" sub="last attack → alarm">
        {s?.last_detection_latency_ms != null ? (
          s.last_detection_latency_ms < 1 ? (
            <>
              <span className="font-mono">&lt;&nbsp;1</span>
              <span className="text-xs text-muted">ms</span>
            </>
          ) : (
            <>
              <AnimatedNumber value={s.last_detection_latency_ms} decimals={s.last_detection_latency_ms < 10 ? 1 : 0} />
              <span className="text-xs text-muted">ms</span>
            </>
          )
        ) : (
          <span className="font-mono text-muted">—</span>
        )}
      </Tile>
      <Tile
        icon={<BadgeCheck className="size-3.5 text-sealed" />}
        label="Checkpoints"
        sub="Ed25519 seals ok / failed"
        tone={failed > 0 ? 'alert' : 'normal'}
      >
        <AnimatedNumber value={s?.checkpoints_ok ?? 0} className="text-sealed" />
        <span className="text-base text-muted">/</span>
        <AnimatedNumber value={failed} className={failed > 0 ? 'text-tampered' : 'text-muted'} />
      </Tile>
    </section>
  )
}
