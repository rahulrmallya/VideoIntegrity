import { useState } from 'react'
import { useSession } from '../../store/useLive'
import { useUi } from '../../store/useUi'
import { AttackConsole } from './AttackConsole'
import { OfflineBanner, StartCard } from './EmptyStates'
import { HashChain } from './HashChain'
import { IncidentFeed } from './IncidentFeed'
import { IntegrityTimeline } from './IntegrityTimeline'
import { MetricTiles } from './MetricTiles'
import { TopBar } from './TopBar'
import { useLiveToasts } from './useLiveToasts'
import { VideoStage } from './VideoStage'

const COLLAPSE_KEY = 'frameseal.console.collapsed'
const loadCollapsed = () => {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1'
  } catch {
    return false
  }
}

const COLUMNS = 'grid-cols-[minmax(0,65fr)_minmax(0,35fr)]'
/** Presenter mode: the video gets more room; the console stays armed (keys 1–7) but folds to its header. */
const COLUMNS_PRESENTER = 'grid-cols-[minmax(0,71fr)_minmax(0,29fr)]'

/** The Live Monitor — one screen, no page scroll at 1366×768 and 1920×1080. */
export function LiveMonitor() {
  const session = useSession()
  const noSession = !session || session.status === 'idle'
  const [userCollapsed, setCollapsed] = useState(loadCollapsed)
  const presenter = useUi((s) => s.presenter)
  const collapsed = userCollapsed || presenter
  const cols = presenter ? COLUMNS_PRESENTER : COLUMNS
  useLiveToasts()

  const toggle = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1')
      } catch {
        // ignore
      }
      return !c
    })
  }

  return (
    <div className="flex h-screen min-h-0 flex-col overflow-hidden">
      <TopBar />
      <OfflineBanner />
      {noSession ? (
        <main className="flex min-h-0 flex-1 items-center justify-center p-4">
          <StartCard />
        </main>
      ) : (
        <main className={`grid min-h-0 flex-1 ${cols} gap-4 px-4 pt-4`}>
          <div className="flex min-h-0 flex-col gap-4">
            <VideoStage />
            <IntegrityTimeline />
          </div>
          <div className="flex min-h-0 flex-col gap-4">
            <HashChain />
            <MetricTiles />
          </div>
        </main>
      )}
      <div className={`grid shrink-0 ${cols} gap-4 p-4 ${collapsed ? '' : 'h-[clamp(176px,24vh,224px)]'}`}>
        <AttackConsole collapsed={collapsed} onToggle={toggle} />
        <IncidentFeed collapsed={collapsed} />
      </div>
    </div>
  )
}
