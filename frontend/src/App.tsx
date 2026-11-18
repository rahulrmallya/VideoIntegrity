import { IS_DEBUG } from './api/backend'
import { DebugOverlay } from './components/DebugOverlay'
import { Toaster } from './components/ui/Toasts'
import { EvidencePlaceholder } from './screens/evidence/EvidencePlaceholder'
import { LiveMonitor } from './screens/live/LiveMonitor'
import { useUi } from './store/useUi'

export default function App() {
  const view = useUi((s) => s.view)
  return (
    <>
      {view === 'evidence' ? <EvidencePlaceholder /> : <LiveMonitor />}
      <Toaster />
      {IS_DEBUG && <DebugOverlay />}
    </>
  )
}
