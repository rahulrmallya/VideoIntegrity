import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { api, IS_DEBUG, live } from './api/backend'
import { startLive, useLive } from './store/useLive'

// The store is wired to the live stream once, outside React (StrictMode double-mounts effects).
startLive()

// ?debug=1: expose handles for poking at the data layer from DevTools.
if (IS_DEBUG) Object.assign(window, { __frameseal: { api, live, store: useLive } })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
