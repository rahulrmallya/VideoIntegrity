import type { ApiClient } from '../api/client'
import type { LiveConnection } from '../api/live'
import { MockBackend } from './backend'

export type Mock = { api: ApiClient; live: LiveConnection; backend: MockBackend }

/**
 * In-browser stand-in for the FastAPI backend. `autoStart` begins a synthetic session as soon as the
 * mock is ready (use `?mock=idle` to start with no session, e.g. to see the empty state).
 */
export function createMockBackend(autoStart: boolean): Mock {
  const backend = new MockBackend()
  if (autoStart) void backend.ready.then(() => backend.startSession({ source: 'synthetic' }))
  return { api: backend.createApi(), live: backend.createLive(), backend }
}
