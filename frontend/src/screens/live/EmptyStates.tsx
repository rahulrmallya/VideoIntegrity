import { AnimatePresence, motion } from 'motion/react'
import { Camera, FileVideo, Loader2, ShieldCheck, Sparkles, WifiOff } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { SourceKind } from '../../api/types'
import { useConnection } from '../../store/useLive'
import { useSessionControl } from './useSessionControl'

const SOURCE_BUTTONS: { value: SourceKind; label: string; hint: string; Icon: typeof Camera }[] = [
  { value: 'webcam', label: 'Webcam', hint: 'Live camera on this laptop', Icon: Camera },
  { value: 'file', label: 'Video file', hint: 'Replay a recorded clip', Icon: FileVideo },
  { value: 'synthetic', label: 'Synthetic', hint: 'Generated test scene', Icon: Sparkles },
]

export function StartCard() {
  const { busy, error, start } = useSessionControl()
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="w-full max-w-xl rounded-2xl border border-border bg-surface p-8 text-center shadow-2xl shadow-black/40"
    >
      <div className="mx-auto flex size-12 items-center justify-center rounded-2xl border border-border bg-raised">
        <ShieldCheck className="size-6 text-sealed" />
      </div>
      <h2 className="mt-4 text-xl font-semibold text-text">Start a live session</h2>
      <p className="mt-1 text-sm text-muted">
        Every frame gets a SHA-256 fingerprint, linked into a hash chain and sealed with an Ed25519 signature every second.
      </p>
      <div className="mt-6 grid grid-cols-3 gap-3">
        {SOURCE_BUTTONS.map(({ value, label, hint, Icon }) => (
          <button
            key={value}
            type="button"
            disabled={busy}
            onClick={() => start(value)}
            className="group flex flex-col items-center gap-2 rounded-xl border border-border bg-raised px-3 py-4 hover:border-sealed/60 hover:bg-sealed/5 disabled:opacity-50"
          >
            <Icon className="size-6 text-muted group-hover:text-sealed" />
            <span className="text-sm font-medium text-text">{label}</span>
            <span className="text-[11px] text-muted">{hint}</span>
          </button>
        ))}
      </div>
      {error && <p className="mt-4 text-sm text-tampered">{error}</p>}
    </motion.div>
  )
}

/** Amber banner when the verifier socket has been down for more than a moment. */
export function OfflineBanner() {
  const connection = useConnection()
  const [show, setShow] = useState(false)
  useEffect(() => {
    if (connection === 'open') {
      setShow(false)
      return
    }
    const t = setTimeout(() => setShow(true), 1200)
    return () => clearTimeout(t)
  }, [connection])
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          className="shrink-0 overflow-hidden"
        >
          <div className="flex items-center justify-center gap-2 border-b border-unverified/40 bg-unverified/15 py-1.5 text-sm font-medium text-unverified">
            <WifiOff className="size-4" />
            Verifier offline — retrying…
            <Loader2 className="size-3.5 animate-spin" />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
