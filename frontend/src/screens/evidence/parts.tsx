import { motion } from 'motion/react'
import { Check, Copy, Link2 } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Verdict } from '../../api/types'
import { copyText } from '../../lib/format'

export function Card({ title, icon, children, aside }: { title: string; icon: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-surface p-5">
      <div className="mb-3 flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-lg bg-raised">{icon}</span>
        <h2 className="text-[15px] font-semibold text-text">{title}</h2>
        {aside && <div className="ml-auto">{aside}</div>}
      </div>
      {children}
    </section>
  )
}

/** Full hash in mono with a copy button (the value a 63(4) certificate asks for). */
export function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div>
      <div className="mb-1 text-[11px] font-semibold tracking-[0.1em] text-muted uppercase">{label}</div>
      <div className="flex items-start gap-2 rounded-lg border border-border bg-bg/60 px-3 py-2">
        <code className="min-w-0 flex-1 font-mono text-[12.5px] leading-relaxed break-all text-text">{value}</code>
        <button
          type="button"
          onClick={async () => {
            if (await copyText(value)) {
              setCopied(true)
              setTimeout(() => setCopied(false), 1200)
            }
          }}
          className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-raised px-2 py-1 text-[11px] text-muted hover:text-text"
          title="Copy"
        >
          {copied ? <Check className="size-3.5 text-sealed" /> : <Copy className="size-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  )
}

export const VERDICT_STYLE: Record<Verdict, { color: string; ring: string; bg: string; line: string }> = {
  AUTHENTIC: { color: 'text-sealed', ring: 'border-sealed', bg: 'bg-sealed/[0.07]', line: "Every frame matches the camera's signed hash chain." },
  TAMPERED: { color: 'text-tampered', ring: 'border-tampered', bg: 'bg-tampered/[0.07]', line: 'The package was altered — see the incidents below.' },
  INCOMPLETE: {
    color: 'text-unverified',
    ring: 'border-unverified',
    bg: 'bg-unverified/[0.07]',
    line: 'No edits found, but the recording does not reach its signed seal — it was cut short or exported before Stop.',
  },
}

/** Rubber stamp that slams in. */
export function VerdictStamp({ verdict }: { verdict: Verdict }) {
  const st = VERDICT_STYLE[verdict]
  return (
    <motion.div
      key={verdict}
      initial={{ scale: 2.4, opacity: 0, rotate: -18 }}
      animate={{ scale: 1, opacity: 1, rotate: -6 }}
      transition={{ type: 'spring', stiffness: 420, damping: 18, mass: 0.9 }}
      className={`inline-flex flex-col items-center rounded-xl border-[5px] border-double px-7 py-2 ${st.ring} ${st.color} ${st.bg}`}
      style={{ boxShadow: 'inset 0 0 0 2px currentColor' }}
    >
      <span className="text-[38px] leading-none font-black tracking-[0.18em]">{verdict}</span>
      <span className="mt-1 text-[10px] font-bold tracking-[0.3em] opacity-80">FRAMESEAL · ED25519</span>
    </motion.div>
  )
}

/** "Verifying…" — a frame counter ticking up and chain links lighting one after another. */
export function VerifyProgress({ estimate, filename }: { estimate: number | null; filename: string | null }) {
  const [count, setCount] = useState(0)
  const [lit, setLit] = useState(0)
  const start = useRef(performance.now())
  useEffect(() => {
    let raf = 0
    const target = estimate && estimate > 0 ? estimate : 2000
    const tick = () => {
      const t = (performance.now() - start.current) / 1000
      // eases towards the expected frame count without ever claiming to be done
      setCount(Math.floor(target * (1 - Math.exp(-t * 1.6)) * 0.985))
      setLit(Math.floor(t * 9) % 14)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [estimate])
  return (
    <div className="flex flex-col items-center gap-4 py-6">
      <div className="text-[12px] text-muted">
        Verifying <span className="font-mono text-text">{filename}</span>
      </div>
      <div className="font-mono text-[34px] leading-none font-semibold text-pending tabular-nums">
        {count.toLocaleString('en-US')}
        <span className="ml-2 text-sm font-normal text-muted">frames checked</span>
      </div>
      <div className="flex items-center gap-1">
        {Array.from({ length: 14 }, (_, i) => (
          <Link2
            key={i}
            className={`size-5 transition-colors duration-150 ${i < lit ? 'text-sealed' : i === lit ? 'text-pending' : 'text-border'}`}
            strokeWidth={2.4}
          />
        ))}
      </div>
      <div className="text-[11.5px] text-muted">re-hashing every frame · re-linking the chain · checking every Ed25519 signature</div>
    </div>
  )
}
