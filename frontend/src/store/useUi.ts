// UI-only state: which view is showing and which incident the drawer has open.
// The view is mirrored in location.hash (#evidence) so the browser Back button works.

import { create } from 'zustand'

export type View = 'live' | 'evidence'

type UiState = {
  view: View
  /** Incident the "Export evidence" button came from (evidence view placeholder shows it). */
  evidenceFor: string | null
  drawerId: string | null
  openDrawer(id: string): void
  closeDrawer(): void
  goEvidence(incidentId?: string): void
  goLive(): void
}

const viewFromHash = (): View => (window.location.hash === '#evidence' ? 'evidence' : 'live')

export const useUi = create<UiState>()((set) => ({
  view: viewFromHash(),
  evidenceFor: null,
  drawerId: null,
  openDrawer: (id) => set({ drawerId: id }),
  closeDrawer: () => set({ drawerId: null }),
  goEvidence: (incidentId) => {
    set({ view: 'evidence', evidenceFor: incidentId ?? null, drawerId: null })
    if (window.location.hash !== '#evidence') window.location.hash = 'evidence'
  },
  goLive: () => {
    set({ view: 'live' })
    if (window.location.hash) history.pushState(null, '', window.location.pathname + window.location.search)
  },
}))

window.addEventListener('hashchange', () => useUi.setState({ view: viewFromHash() }))
window.addEventListener('popstate', () => useUi.setState({ view: viewFromHash() }))
