import { motion } from 'motion/react'
import { Keyboard, X } from 'lucide-react'
import { useUi } from '../store/useUi'

const GROUPS: { title: string; keys: [string, string][] }[] = [
  {
    title: 'Live',
    keys: [
      ['1 – 7', 'Launch an attack (Erase · Delete · Insert · Swap · Loop · Forge · Cut)'],
      ['P', 'Presenter mode — bigger video & integrity pill, no debug bits'],
      ['Esc', 'Close the incident drawer'],
    ],
  },
  {
    title: 'Navigate',
    keys: [
      ['L', 'Live monitor'],
      ['E', 'Evidence — export & verify'],
      ['H', 'How it works'],
      ['← →', 'Previous / next step (How it works)'],
    ],
  },
  { title: 'Help', keys: [['?', 'Show / hide this list'], ['Esc', 'Close this list']] },
]

export function ShortcutsOverlay() {
  const open = useUi((s) => s.shortcutsOpen)
  const close = () => useUi.getState().setShortcuts(false)
  if (!open) return null
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-bg/70 backdrop-blur-sm print:hidden" onClick={close}>
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.15 }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Keyboard shortcuts"
        className="w-full max-w-lg rounded-2xl border border-border bg-surface p-5 shadow-2xl shadow-black/60"
      >
        <div className="mb-3 flex items-center gap-2">
          <Keyboard className="size-5 text-pending" />
          <h2 className="text-[16px] font-semibold text-text">Keyboard shortcuts</h2>
          <button type="button" onClick={close} className="ml-auto rounded-md p-1 text-muted hover:bg-raised hover:text-text" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
        <div className="space-y-3">
          {GROUPS.map((g) => (
            <div key={g.title}>
              <div className="mb-1 text-[10.5px] font-semibold tracking-[0.14em] text-muted uppercase">{g.title}</div>
              <ul className="space-y-1">
                {g.keys.map(([k, what]) => (
                  <li key={g.title + k} className="flex items-center gap-3 text-[13px]">
                    <kbd className="min-w-14 rounded-md border border-border bg-raised px-2 py-0.5 text-center font-mono text-[12px] text-text">{k}</kbd>
                    <span className="text-muted">{what}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </motion.div>
    </div>
  )
}
