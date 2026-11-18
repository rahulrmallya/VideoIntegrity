import { AnimatePresence, motion } from 'motion/react'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { sha256Hex } from '../../lib/demoCrypto'
import { useLive } from '../../store/useLive'
import { useUi } from '../../store/useUi'
import { TopBar } from '../live/TopBar'
import { DemoChain } from './DemoChain'
import { CaptureArt, ChainArt, FingerprintArt, SealArt, VerifyArt } from './StepArt'

type Step = { title: string; art: ReactNode; text: string; why: string }

/** A real SHA-256: the live camera's latest frame if a session is running, else of a sample string. */
function useRealHash(): { hash: string; source: string } {
  const liveHash = useLive((s) => s.frame?.frame_hash ?? null)
  const liveSeq = useLive((s) => s.frame?.seq ?? null)
  const [sample, setSample] = useState('')
  useEffect(() => {
    void sha256Hex('frame 1').then(setSample)
  }, [])
  if (liveHash) return { hash: liveHash, source: `live frame #${liveSeq}` }
  return { hash: sample || '0'.repeat(64), source: 'SHA-256("frame 1")' }
}

function Stepper() {
  const [i, setI] = useState(0)
  const view = useUi((s) => s.view)
  const real = useRealHash()

  const steps: Step[] = [
    {
      title: 'Capture',
      art: <CaptureArt />,
      text: 'The camera captures each frame and stamps it with a sequence number and the time.',
      why: 'Every one of the 15 frames per second is counted — none can quietly disappear.',
    },
    {
      title: 'Fingerprint',
      art: <FingerprintArt hash={real.hash} />,
      text: 'Each frame is turned into a SHA-256 fingerprint; change a single pixel and the fingerprint changes completely.',
      why: `You cannot edit a frame without its fingerprint giving it away. (Shown: ${real.source}.)`,
    },
    {
      title: 'Chain',
      art: <ChainArt />,
      text: "Every block also stores the previous block's fingerprint, so the frames are linked like a chain.",
      why: 'Deleting, inserting or reordering any frame breaks every link after it.',
    },
    {
      title: 'Seal',
      art: <SealArt />,
      text: "Every second the camera signs the end of the chain with its secret private key (Ed25519).",
      why: "Even an attacker who recomputes every fingerprint cannot produce the camera's signature.",
    },
    {
      title: 'Verify',
      art: <VerifyArt />,
      text: "Anyone can check the recording with only the camera's public key — offline, no blockchain, no trust in us.",
      why: 'A court, a newsroom or a judge can verify the evidence themselves.',
    },
  ]

  useEffect(() => {
    if (view !== 'how') return
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return
      if (e.key === 'ArrowRight') setI((x) => Math.min(steps.length - 1, x + 1))
      if (e.key === 'ArrowLeft') setI((x) => Math.max(0, x - 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view, steps.length])

  const s = steps[i]
  return (
    <section className="flex min-h-0 flex-col rounded-2xl border border-border bg-surface p-4">
      <ol className="flex gap-1.5">
        {steps.map((st, k) => (
          <li key={st.title} className="flex-1">
            <button
              type="button"
              onClick={() => setI(k)}
              className={`w-full rounded-lg border px-2 py-1.5 text-left transition-colors ${
                k === i ? 'border-pending/70 bg-pending/10' : k < i ? 'border-sealed/30 bg-sealed/[0.04]' : 'border-border bg-raised/40'
              }`}
            >
              <span className={`font-mono text-[10px] ${k <= i ? 'text-pending' : 'text-muted'}`}>{k + 1}</span>
              <span className={`ml-1.5 text-[12.5px] font-semibold ${k === i ? 'text-text' : 'text-muted'}`}>{st.title}</span>
            </button>
          </li>
        ))}
      </ol>
      <div className="mt-3 grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-5">
        <div className="aspect-[2/1] w-full overflow-hidden rounded-xl border border-border bg-bg/60">
          <AnimatePresence mode="wait">
            <motion.div key={i} initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }} transition={{ duration: 0.2 }} className="h-full w-full">
              {s.art}
            </motion.div>
          </AnimatePresence>
        </div>
        <div className="min-w-0">
          <div className="text-[11px] font-semibold tracking-[0.14em] text-pending uppercase">
            Step {i + 1} of {steps.length} · {s.title}
          </div>
          <p className="mt-2 text-[17px] leading-snug text-text">{s.text}</p>
          <p className="mt-3 border-l-2 border-sealed/60 pl-3 text-[13px] leading-snug text-muted">
            <span className="font-semibold text-sealed">Why it matters: </span>
            {s.why}
          </p>
          <div className="mt-4 flex items-center gap-2">
            <button
              type="button"
              disabled={i === 0}
              onClick={() => setI(i - 1)}
              className="inline-flex h-8 items-center gap-1 rounded-lg border border-border bg-raised px-3 text-[12.5px] text-text disabled:opacity-40"
            >
              <ArrowLeft className="size-4" /> Back
            </button>
            <button
              type="button"
              disabled={i === steps.length - 1}
              onClick={() => setI(i + 1)}
              className="inline-flex h-8 items-center gap-1 rounded-lg bg-pending px-3 text-[12.5px] font-semibold text-bg disabled:opacity-40"
            >
              Next <ArrowRight className="size-4" />
            </button>
            <span className="ml-1 text-[11px] text-muted/70">or ← →</span>
          </div>
        </div>
      </div>
    </section>
  )
}

const ROWS: [string, string, string][] = [
  ['File hash at export', 'Proves nothing about edits made before the export.', 'Every frame fingerprinted at capture, live.'],
  ['Blockchain anchoring', 'Fees, latency, needs internet.', 'Signed locally every second — offline and free.'],
  ['Camera-vendor signed video', 'Needs special cameras.', 'Any ordinary camera + a software key.'],
  ['AI forgery detectors', 'A guess, not a proof.', 'Cryptographic proof, down to the exact frame.'],
]

function Comparison() {
  return (
    <section className="flex min-h-0 flex-col rounded-2xl border border-border bg-surface p-4">
      <h2 className="text-[15px] font-semibold text-text">Why not just…?</h2>
      <table className="mt-2 w-full text-[12.5px] leading-snug">
        <thead>
          <tr className="text-left text-[10.5px] tracking-[0.1em] text-muted uppercase">
            <th className="pb-1.5 font-semibold">Existing approach</th>
            <th className="pb-1.5 font-semibold">Its gap</th>
            <th className="pb-1.5 font-semibold text-sealed">FrameSeal</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map(([a, gap, ours]) => (
            <tr key={a} className="border-t border-border align-top">
              <td className="py-2 pr-3 font-medium text-text">{a}</td>
              <td className="py-2 pr-3 text-tampered/90">{gap}</td>
              <td className="py-2 text-sealed">{ours}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

export function HowItWorks() {
  return (
    <div className="flex h-screen min-h-0 flex-col overflow-hidden">
      <TopBar />
      <main className="flex min-h-0 flex-1 flex-col gap-4 p-4">
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.75fr)_minmax(0,1fr)] gap-4">
          <Stepper />
          <Comparison />
        </div>
        <DemoChain />
      </main>
    </div>
  )
}
