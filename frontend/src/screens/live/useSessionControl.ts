import { useState } from 'react'
import { ApiRequestError } from '../../api/client'
import { api } from '../../api/backend'
import type { SourceKind } from '../../api/types'

export const SOURCES: { value: SourceKind; label: string }[] = [
  { value: 'webcam', label: 'Webcam' },
  { value: 'file', label: 'Video file' },
  { value: 'synthetic', label: 'Synthetic' },
]

/** Start/stop through the api module; components never call fetch. */
export function useSessionControl() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.detail : err instanceof Error ? err.message : String(err))
      setTimeout(() => setError(null), 5000)
    } finally {
      setBusy(false)
    }
  }

  return {
    busy,
    error,
    start: (source: SourceKind) => run(() => api.startSession({ source })),
    stop: () => run(() => api.stopSession()),
  }
}
