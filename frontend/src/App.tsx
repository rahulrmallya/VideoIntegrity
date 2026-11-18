import { IS_DEBUG } from './api/backend'
import { DebugOverlay } from './components/DebugOverlay'
import { DevPreview } from './components/DevPreview'

export default function App() {
  return (
    <>
      <DevPreview />
      {IS_DEBUG && <DebugOverlay />}
    </>
  )
}
