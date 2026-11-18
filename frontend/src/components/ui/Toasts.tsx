import { motion } from 'motion/react'
import { CheckCircle2, Info, ShieldAlert, TriangleAlert, X } from 'lucide-react'
import { create } from 'zustand'

export type ToastTone = 'info' | 'success' | 'danger' | 'warning'
export type Toast = { id: number; tone: ToastTone; title: string; body?: string }

type ToastState = { toasts: Toast[]; push(t: Omit<Toast, 'id'>, ms?: number): void; dismiss(id: number): void }

let nextId = 1

export const useToasts = create<ToastState>()((set, get) => ({
  toasts: [],
  push: (t, ms = 4200) => {
    const id = nextId++
    set({ toasts: [...get().toasts, { ...t, id }].slice(-4) })
    setTimeout(() => get().dismiss(id), ms)
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}))

export const toast = (t: Omit<Toast, 'id'>, ms?: number) => useToasts.getState().push(t, ms)

const STYLE: Record<ToastTone, { cls: string; Icon: typeof Info }> = {
  info: { cls: 'border-border text-text', Icon: Info },
  success: { cls: 'border-sealed/50 text-sealed', Icon: CheckCircle2 },
  danger: { cls: 'border-tampered/70 text-tampered', Icon: ShieldAlert },
  warning: { cls: 'border-unverified/60 text-unverified', Icon: TriangleAlert },
}

/** Bottom-right stack, above the console strip so it never hides the incident feed. */
export function Toaster() {
  const toasts = useToasts((s) => s.toasts)
  const dismiss = useToasts((s) => s.dismiss)
  return (
    <div className="pointer-events-none fixed right-4 bottom-[calc(clamp(176px,24vh,224px)+2.25rem)] z-40 flex w-80 flex-col gap-2">
      {/* enter animation only: exit animations stall when the window is occluded and toasts would pile up */}
      {toasts.map((t) => {
          const { cls, Icon } = STYLE[t.tone]
          return (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, x: 40 }}
              animate={{ opacity: 1, x: 0 }}
              className={`pointer-events-auto flex items-start gap-2.5 rounded-xl border bg-surface/95 px-3 py-2.5 shadow-2xl shadow-black/50 backdrop-blur ${cls}`}
            >
              <Icon className="mt-0.5 size-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold">{t.title}</div>
                {t.body && <div className="mt-0.5 truncate text-xs text-muted">{t.body}</div>}
              </div>
              <button type="button" onClick={() => dismiss(t.id)} className="text-muted hover:text-text" aria-label="Dismiss">
                <X className="size-3.5" />
              </button>
            </motion.div>
          )
        })}
    </div>
  )
}
