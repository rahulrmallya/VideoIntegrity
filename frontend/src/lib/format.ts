// Display helpers shared by the screens.

/** `9f3a…c71e` — CLAUDE.md hash convention. */
export function shortHash(h: string | null | undefined, n = 4): string {
  if (!h) return '—'
  return h.length <= n * 2 + 1 ? h : `${h.slice(0, n)}…${h.slice(-n)}`
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/** ts_ns is display-only (CONTRACT 1.1c): ms precision is all we need. */
export function clockFromNs(tsNs: number): string {
  const d = new Date(tsNs / 1e6)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

export function dateFromNs(tsNs: number): string {
  const d = new Date(tsNs / 1e6)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Clipboard API can be blocked (insecure origin, no focus): fall back to execCommand
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}

export const STATUS_COLOR = {
  sealed: '#22C55E',
  pending: '#22D3EE',
  unverified: '#F59E0B',
  tampered: '#EF4444',
  missing: '#EF4444',
  border: '#1F2A40',
  raised: '#141C2E',
  muted: '#8A97AD',
} as const
