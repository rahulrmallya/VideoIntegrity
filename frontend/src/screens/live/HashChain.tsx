import { motion } from 'motion/react'
import { BadgeCheck, Link2, Link2Off, OctagonX, Hourglass } from 'lucide-react'
import type { ChainRecord, SealMessage } from '../../api/types'
import { Hash } from '../../components/ui/Hash'
import { clockFromNs, STATUS_COLOR } from '../../lib/format'
import { useChain, useSeals, useSeqStatus, useSession } from '../../store/useLive'

const SHOWN = 6

function Stamp({ seal }: { seal: SealMessage | undefined }) {
  const state = seal === undefined ? 'pending' : seal.valid ? 'valid' : 'invalid'
  const cls = {
    pending: 'border-pending/40 text-pending/80',
    valid: 'border-sealed/70 bg-sealed/10 text-sealed',
    invalid: 'border-tampered bg-tampered/15 text-tampered shadow-[0_0_14px_rgb(239_68_68/0.45)]',
  }[state]
  const Icon = state === 'valid' ? BadgeCheck : state === 'invalid' ? OctagonX : Hourglass
  return (
    <motion.span
      initial={{ scale: 1.6, opacity: 0, rotate: -12 }}
      animate={{ scale: 1, opacity: 1, rotate: -4 }}
      transition={{ type: 'spring', stiffness: 500, damping: 22 }}
      key={state}
      className={`inline-flex items-center gap-1 rounded border-2 px-1.5 py-px text-[9.5px] font-bold tracking-[0.14em] uppercase ${cls}`}
      title={seal?.signature ? `signature ${seal.signature}` : 'awaiting signature check'}
    >
      <Icon className="size-3" strokeWidth={2.6} />
      Signed · Ed25519{state === 'invalid' && ' · invalid'}
    </motion.span>
  )
}

function Cell({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className="text-[9.5px] font-semibold tracking-wider text-muted/70 uppercase">{label}</span>
      {icon}
      <Hash value={value} label={label} className="text-[0.95em] text-text/90" />
    </div>
  )
}

function Block({ rec, seal, broken, last }: { rec: ChainRecord; seal: SealMessage | undefined; broken: boolean; last: boolean }) {
  const status = useSeqStatus(rec.seq)
  const tampered = status === 'tampered'
  return (
    <div className="flex h-full flex-col">
      <div
        className={`flex min-h-0 flex-1 flex-col justify-center gap-1 rounded-lg border px-3 transition-colors duration-300 ${
          tampered ? 'border-tampered/70 bg-tampered/10' : rec.is_checkpoint ? 'border-border bg-raised' : 'border-border/70 bg-raised/60'
        }`}
        style={{ fontSize: 'clamp(11px, 2.1cqh, 13.5px)' }}
      >
        <div className="flex items-center gap-2">
          <span
            className={`size-2 shrink-0 rounded-full ${status === 'missing' ? 'border border-tampered' : ''}`}
            style={status && status !== 'missing' ? { background: STATUS_COLOR[status] } : undefined}
            title={status ?? 'unknown'}
          />
          <span className="font-mono font-semibold tabular-nums text-text">#{rec.seq}</span>
          <span className="font-mono text-[0.85em] text-muted/70 tabular-nums">{clockFromNs(rec.ts_ns)}</span>
          <span className="ml-auto">{rec.is_checkpoint && <Stamp seal={seal} />}</span>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Cell label="frame" value={rec.frame_hash} />
          <Cell
            label="prev"
            value={rec.prev_hash}
            icon={broken ? <Link2Off className="size-3 shrink-0 text-tampered" /> : <Link2 className="size-3 shrink-0 text-pending/70" />}
          />
          <Cell label="chain" value={rec.chain_hash} />
        </div>
      </div>
      {/* connector to the older block below */}
      <div className="relative h-2.5 shrink-0">
        {!last &&
          (broken ? (
            <>
              <span className="absolute top-0 left-6 h-full border-l-2 border-dashed border-tampered" />
              <span className="absolute top-1/2 left-9 -translate-y-1/2 text-[9px] font-bold tracking-widest text-tampered">BREAK</span>
            </>
          ) : (
            <span className="absolute top-0 left-6 h-full w-0.5 bg-gradient-to-b from-pending/50 to-pending/20" />
          ))}
      </div>
    </div>
  )
}

export function HashChain() {
  const chain = useChain().slice(0, SHOWN)
  const seals = useSeals()
  const ci = useSession()?.checkpoint_interval ?? 15
  const sealFor = (r: ChainRecord) => seals.find((s) => s.seq === r.seq && s.chain_hash === r.chain_hash)

  return (
    <section className="flex min-h-0 flex-1 flex-col rounded-2xl border border-border bg-surface p-3 pb-1">
      <div className="mb-2 flex items-center gap-2 px-1">
        <h2 className="shrink-0 text-[11px] font-semibold tracking-[0.14em] whitespace-nowrap text-muted uppercase">Live hash chain</h2>
        <span className="min-w-0 truncate text-[11px] text-muted/70">SHA-256 linked · signed every {ci} frames</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px] text-muted">
          head <Hash value={chain[0]?.chain_hash} className="text-pending" />
        </span>
      </div>
      <div
        className="relative min-h-0 flex-1 overflow-hidden"
        style={{ containerType: 'size', maskImage: 'linear-gradient(to bottom, black 88%, transparent)' }}
      >
        {chain.length === 0 && <div className="flex h-full items-center justify-center text-sm text-muted">No frames yet</div>}
        {/* 15 records/s is faster than any layout/exit animation can settle, so the list shifts instantly
            and only the newest block slides in with a short cyan flash; the oldest drops off under the fade. */}
        <ul className="relative">
            {chain.map((rec, i) => {
              const older = chain[i + 1]
              return (
                <motion.li
                  key={`${rec.seq}-${rec.chain_hash}`}
                  initial={{ opacity: 0, y: -14, filter: 'drop-shadow(0 0 10px rgb(34 211 238 / 0.55))' }}
                  animate={{ opacity: 1, y: 0, filter: 'drop-shadow(0 0 0px rgb(34 211 238 / 0))' }}
                  transition={{ duration: 0.12, ease: [0.22, 1, 0.36, 1], filter: { duration: 0.5 } }}
                  style={{ height: `calc(100cqh / ${SHOWN})` }}
                >
                  <Block rec={rec} seal={sealFor(rec)} broken={older !== undefined && rec.prev_hash !== older.chain_hash} last={i === chain.length - 1} />
                </motion.li>
              )
            })}
        </ul>
      </div>
    </section>
  )
}
