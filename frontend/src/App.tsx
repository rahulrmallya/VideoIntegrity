import { IS_DEBUG } from './api/backend'
import { DebugOverlay } from './components/DebugOverlay'
import { ShortcutsOverlay } from './components/ShortcutsOverlay'
import { Toaster } from './components/ui/Toasts'
import { EvidenceScreen } from './screens/evidence/EvidenceScreen'
import { HowItWorks } from './screens/how/HowItWorks'
import { IncidentDrawer } from './screens/live/IncidentDrawer'
import { LiveMonitor } from './screens/live/LiveMonitor'
import { useNavKeys } from './screens/live/TopBar'
import { ReportView } from './screens/report/ReportView'
import { useUi } from './store/useUi'

export default function App() {
  const view = useUi((s) => s.view)
  const presenter = useUi((s) => s.presenter)
  useNavKeys()
  return (
    <>
      {view === 'evidence' ? <EvidenceScreen /> : view === 'how' ? <HowItWorks /> : view === 'report' ? <ReportView /> : <LiveMonitor />}
      <IncidentDrawer />
      <Toaster />
      <ShortcutsOverlay />
      {IS_DEBUG && !presenter && <DebugOverlay />}
    </>
  )
}
