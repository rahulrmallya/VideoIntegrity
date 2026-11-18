// UI-only state: which view is showing and which incident the drawer has open.
// The view lives in location.hash so Back/Forward and reloads work:
//   (none) live · #evidence · #how · #report/<report_id>

import { create } from 'zustand'
import type { Incident } from '../api/types'

export type View = 'live' | 'evidence' | 'how' | 'report'

type Route = { view: View; reportId: string | null }

function parseHash(): Route {
  const h = window.location.hash.replace(/^#/, '')
  if (h === 'evidence') return { view: 'evidence', reportId: null }
  if (h === 'how') return { view: 'how', reportId: null }
  if (h.startsWith('report/')) return { view: 'report', reportId: decodeURIComponent(h.slice(7)) || null }
  return { view: 'live', reportId: null }
}

function hashFor(view: View, reportId?: string | null): string {
  if (view === 'live') return ''
  if (view === 'report') return `#report/${encodeURIComponent(reportId ?? '')}`
  return `#${view}`
}

type UiState = Route & {
  /** Live incident shown in the drawer (looked up in the live store, so it updates). */
  drawerId: string | null
  /** Incident from a verification report (not in the live store): shown as-is. */
  drawerIncident: Incident | null
  /** Presenter mode (key P): no debug bits, bigger video and integrity pill. Remembered across reloads. */
  presenter: boolean
  /** Keyboard-shortcuts overlay (key ?). */
  shortcutsOpen: boolean
  togglePresenter(): void
  setShortcuts(open: boolean): void
  navigate(view: View, reportId?: string | null): void
  openDrawer(id: string): void
  openReportIncident(inc: Incident): void
  closeDrawer(): void
  goEvidence(incidentId?: string): void
  goLive(): void
}

const PRESENTER_KEY = 'frameseal.presenter'
const loadPresenter = () => {
  try {
    return localStorage.getItem(PRESENTER_KEY) === '1'
  } catch {
    return false
  }
}

export const useUi = create<UiState>()((set, get) => ({
  ...parseHash(),
  drawerId: null,
  drawerIncident: null,
  presenter: loadPresenter(),
  shortcutsOpen: false,
  togglePresenter: () => {
    const next = !get().presenter
    set({ presenter: next })
    try {
      localStorage.setItem(PRESENTER_KEY, next ? '1' : '0')
    } catch {
      // private mode
    }
  },
  setShortcuts: (open) => set({ shortcutsOpen: open }),
  navigate: (view, reportId = null) => {
    set({ view, reportId, drawerId: null, drawerIncident: null })
    const target = hashFor(view, reportId)
    if (window.location.hash !== target) {
      if (target) window.location.hash = target
      else history.pushState(null, '', window.location.pathname + window.location.search)
    }
  },
  openDrawer: (id) => set({ drawerId: id, drawerIncident: null }),
  openReportIncident: (inc) => set({ drawerId: null, drawerIncident: inc }),
  closeDrawer: () => set({ drawerId: null, drawerIncident: null }),
  goEvidence: () => get().navigate('evidence'),
  goLive: () => get().navigate('live'),
}))

const sync = () => useUi.setState({ ...parseHash(), drawerId: null, drawerIncident: null })
window.addEventListener('hashchange', sync)
window.addEventListener('popstate', sync)
