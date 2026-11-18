// Picks the real backend or the in-browser mock. Everything else imports `api` / `live` from here.
//   ?mock=1      mock backend, synthetic session starts automatically
//   ?mock=idle   mock backend, no session until you start one
//   VITE_MOCK=1  same as ?mock=1 for every page load
//   ?debug=1     debug overlay

import { createMockBackend } from '../mock'
import { restClient, type ApiClient } from './client'
import { createLiveConnection, type LiveConnection } from './live'

const params = new URLSearchParams(window.location.search)
const mockParam = params.get('mock')

export const IS_MOCK = mockParam === '1' || mockParam === 'idle' || import.meta.env.VITE_MOCK === '1'
export const IS_DEBUG = params.get('debug') === '1'

const mock = IS_MOCK ? createMockBackend(mockParam !== 'idle') : null

export const api: ApiClient = mock ? mock.api : restClient
export const live: LiveConnection = mock ? mock.live : createLiveConnection()

export const originalUrl = (seq: number) => api.originalUrl(seq)
export const receivedUrl = (seq: number) => api.receivedUrl(seq)
export const diffUrl = (seq: number) => api.diffUrl(seq)
