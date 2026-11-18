// Typed REST client for CONTRACT §8. Components never call fetch directly — they go through `api`
// (see backend.ts), which is either this client or the mock.

import type {
  AttackAck,
  AttackType,
  ChainRecord,
  Device,
  ExportResult,
  Health,
  Incident,
  Session,
  StartRequest,
  Stats,
  TamperSampleMode,
  VerificationReport,
  AttackInfo,
} from './types'

/** Thrown for every non-2xx response; `detail` is the contract's `{"detail": ...}` message. */
export class ApiRequestError extends Error {
  readonly status: number
  readonly detail: string

  constructor(status: number, detail: string) {
    super(detail)
    this.name = 'ApiRequestError'
    this.status = status
    this.detail = detail
  }
}

/** Everything the UI may ask the backend. The mock implements the same interface. */
export interface ApiClient {
  health(): Promise<Health>
  getDevice(): Promise<Device>
  getSession(): Promise<Session>
  startSession(req: StartRequest): Promise<Session>
  stopSession(): Promise<Session>
  getStats(): Promise<Stats>
  getAttackCatalog(): Promise<AttackInfo[]>
  launchAttack(type: AttackType, params?: Record<string, unknown>): Promise<AttackAck>
  getIncidents(): Promise<Incident[]>
  ackIncident(id: string): Promise<Incident>
  getChain(limit?: number): Promise<ChainRecord[]>
  exportEvidence(): Promise<ExportResult>
  /** GET /api/evidence/download/{filename} as a Blob (e.g. to feed it straight back into verify). */
  downloadEvidence(filename: string): Promise<Blob>
  verifyEvidence(file: Blob, filename?: string): Promise<VerificationReport>
  tamperSample(mode: TamperSampleMode): Promise<ExportResult>
  getReport(reportId: string): Promise<VerificationReport>
  /** Image URLs for <img src>. They may 404 (absent) — handle onError. */
  originalUrl(seq: number): string
  receivedUrl(seq: number): string
  diffUrl(seq: number): string
}

const API = '/api'
const OFFLINE = 'Verifier offline — cannot reach the backend'

async function readError(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json()
    if (body && typeof body === 'object' && 'detail' in body) {
      const detail = (body as { detail: unknown }).detail
      if (typeof detail === 'string') return detail
      // FastAPI validation errors: [{loc, msg, type}, …]
      if (Array.isArray(detail)) {
        return detail
          .map((d) => (d && typeof d === 'object' && 'msg' in d ? String((d as { msg: unknown }).msg) : JSON.stringify(d)))
          .join('; ')
      }
      return JSON.stringify(detail)
    }
  } catch {
    // not JSON — fall through
  }
  // The Vite dev proxy answers 502/504 without a body when FastAPI is not running.
  if (res.status === 502 || res.status === 504) return OFFLINE
  return `${res.status} ${res.statusText || 'Request failed'}`
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(API + path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiRequestError(0, OFFLINE)
  }
  if (!res.ok) throw new ApiRequestError(res.status, await readError(res))
  return (await res.json()) as T
}

export const restClient: ApiClient = {
  health: () => request<Health>('GET', '/health'),
  getDevice: () => request<Device>('GET', '/device'),
  getSession: () => request<Session>('GET', '/session'),
  startSession: (req) => request<Session>('POST', '/session/start', req),
  stopSession: () => request<Session>('POST', '/session/stop'),
  getStats: () => request<Stats>('GET', '/stats'),
  getAttackCatalog: () => request<AttackInfo[]>('GET', '/attacks/catalog'),
  launchAttack: (type, params = {}) => request<AttackAck>('POST', '/attacks', { type, params }),
  getIncidents: () => request<Incident[]>('GET', '/incidents'),
  ackIncident: (id) => request<Incident>('POST', `/incidents/${encodeURIComponent(id)}/ack`),
  getChain: (limit = 50) => request<ChainRecord[]>('GET', `/chain?limit=${limit}`),
  exportEvidence: () => request<ExportResult>('POST', '/evidence/export'),

  async downloadEvidence(filename) {
    const res = await fetch(`${API}/evidence/download/${encodeURIComponent(filename)}`)
    if (!res.ok) throw new ApiRequestError(res.status, await readError(res))
    return res.blob()
  },

  async verifyEvidence(file, filename) {
    const form = new FormData()
    form.append('file', file, filename ?? (file instanceof File ? file.name : 'package.zip'))
    let res: Response
    try {
      res = await fetch(`${API}/evidence/verify`, { method: 'POST', body: form })
    } catch {
      throw new ApiRequestError(0, OFFLINE)
    }
    if (!res.ok) throw new ApiRequestError(res.status, await readError(res))
    return (await res.json()) as VerificationReport
  },

  tamperSample: (mode) => request<ExportResult>('POST', '/evidence/tamper-sample', { mode }),
  getReport: (reportId) => request<VerificationReport>('GET', `/reports/${encodeURIComponent(reportId)}`),

  originalUrl: (seq) => `${API}/frames/${seq}/original.jpg`,
  receivedUrl: (seq) => `${API}/frames/${seq}/received.jpg`,
  diffUrl: (seq) => `${API}/frames/${seq}/diff.png`,
}

export const originalUrl = (seq: number) => restClient.originalUrl(seq)
export const receivedUrl = (seq: number) => restClient.receivedUrl(seq)
export const diffUrl = (seq: number) => restClient.diffUrl(seq)
