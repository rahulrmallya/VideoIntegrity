import { ArrowLeft, Loader2, Printer, ShieldCheck } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { api } from '../../api/backend'
import { ApiRequestError } from '../../api/client'
import type { Verdict, VerificationReport } from '../../api/types'
import { fmtDateTime } from '../../lib/format'
import { useEvidence } from '../../store/useEvidence'
import { useUi } from '../../store/useUi'

// Printable A4 report: white page, dark-free, prints on one or two pages (see @page in index.css).

const VERDICT_PRINT: Record<Verdict, { border: string; bg: string; text: string; line: string }> = {
  AUTHENTIC: {
    border: 'border-[#15803d]',
    bg: 'bg-[#f0fdf4]',
    text: 'text-[#15803d]',
    line: "Every frame in the package matches the camera's hash chain and every signature verifies with the device public key.",
  },
  TAMPERED: {
    border: 'border-[#b91c1c]',
    bg: 'bg-[#fef2f2]',
    text: 'text-[#b91c1c]',
    line: 'The package does not match what the camera signed: frames were altered, inserted, removed or reordered (details below).',
  },
  INCOMPLETE: {
    border: 'border-[#b45309]',
    bg: 'bg-[#fffbeb]',
    text: 'text-[#b45309]',
    line: 'No altered frame was found, but the signed seal record is missing or does not match the last frame: the recording is truncated.',
  },
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16)
  return out
}

/** SHA-256 of the raw Ed25519 public key, first 128 bits, grouped for reading aloud. */
function useKeyFingerprint(pkHex: string | undefined): string | null {
  const [fp, setFp] = useState<string | null>(null)
  useEffect(() => {
    if (!pkHex || pkHex.length % 2) return
    let alive = true
    void crypto.subtle.digest('SHA-256', hexToBytes(pkHex)).then((d) => {
      const hex = Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('')
      if (alive) setFp(hex.slice(0, 32).match(/.{4}/g)!.join(' '))
    })
    return () => {
      alive = false
    }
  }, [pkHex])
  return fp
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <tr className="border-b border-[#e5e7eb] align-top">
      <th className="w-[38%] py-1.5 pr-3 text-left font-medium text-[#4b5563]">{k}</th>
      <td className="py-1.5 text-[#111827]">{children}</td>
    </tr>
  )
}

const Mono = ({ children }: { children: ReactNode }) => <span className="font-mono text-[9pt] break-all">{children}</span>

function duration(a: string | null, b: string | null): string {
  if (!a || !b) return ''
  const s = Math.max(0, (Date.parse(b) - Date.parse(a)) / 1000)
  const m = Math.floor(s / 60)
  return m ? `${m} min ${Math.round(s - m * 60)} s` : `${s.toFixed(1)} s`
}

function Report({ r }: { r: VerificationReport }) {
  const fp = useKeyFingerprint(r.public_key_hex)
  const v = VERDICT_PRINT[r.verdict]
  const n = r.checkpoints_total > 0 ? Math.round(r.frames_total / r.checkpoints_total) : null

  return (
    <article className="report-page mx-auto bg-white text-[10pt] leading-snug text-[#111827] shadow-2xl print:shadow-none">
      <header className="flex items-start justify-between border-b-2 border-[#111827] pb-3">
        <div>
          <div className="flex items-center gap-1.5 text-[9pt] font-semibold tracking-[0.18em] text-[#4b5563] uppercase">
            <ShieldCheck className="size-4" /> FrameSeal
          </div>
          <h1 className="mt-1 text-[18pt] leading-tight font-bold">Video Integrity Verification Report</h1>
        </div>
        <div className="text-right text-[9pt] text-[#4b5563]">
          <div className="whitespace-nowrap">
            Report ID <span className="font-mono text-[8.5pt]">{r.report_id}</span>
          </div>
          <div>Verified {fmtDateTime(r.verified_at)}</div>
          <div className="font-mono text-[8pt]">{r.verified_at}</div>
        </div>
      </header>

      <section className={`mt-4 flex items-center gap-4 rounded-md border-2 ${v.border} ${v.bg} px-4 py-3`}>
        <div className={`rounded border-[3px] border-double ${v.border} px-3 py-1 text-[16pt] font-black tracking-[0.15em] ${v.text}`}>{r.verdict}</div>
        <p className="text-[10pt]">{v.line}</p>
      </section>

      <div className="mt-4 grid grid-cols-2 gap-x-6">
        <section>
          <h2 className="mb-1 text-[10.5pt] font-bold">Source device &amp; recording</h2>
          <table className="w-full text-[9.5pt]">
            <tbody>
              <Row k="Device ID">
                <Mono>{r.device_id}</Mono>
              </Row>
              <Row k="Public key (Ed25519)">
                <Mono>{r.public_key_hex}</Mono>
              </Row>
              <Row k="Key fingerprint">
                <Mono>{fp ?? '…'}</Mono>
                <div className="text-[8pt] text-[#6b7280]">first 128 bits of SHA-256(public key)</div>
              </Row>
              <Row k="Session ID">
                <Mono>{r.session_id}</Mono>
              </Row>
              <Row k="Recording start">{fmtDateTime(r.first_frame_at)}</Row>
              <Row k="Recording end">
                {fmtDateTime(r.last_frame_at)} {r.first_frame_at && r.last_frame_at && <span className="text-[#6b7280]">({duration(r.first_frame_at, r.last_frame_at)})</span>}
              </Row>
            </tbody>
          </table>
        </section>
        <section>
          <h2 className="mb-1 text-[10.5pt] font-bold">Result</h2>
          <table className="w-full text-[9.5pt]">
            <tbody>
              <Row k="Frames total">{r.frames_total.toLocaleString('en-US')}</Row>
              <Row k="Frames verified OK">{r.frames_ok.toLocaleString('en-US')}</Row>
              <Row k="Frames tampered">{r.frames_tampered}</Row>
              <Row k="Frames missing">{r.frames_missing}</Row>
              <Row k="Checkpoint signatures">
                {r.checkpoints_valid} of {r.checkpoints_total} valid
              </Row>
              <Row k="Final seal">{r.seal_valid ? 'Valid — matches the last frame' : 'Missing or does not match the last frame'}</Row>
              <Row k="Verification time">{r.verify_ms.toFixed(1)} ms</Row>
            </tbody>
          </table>
        </section>
      </div>

      <section className="mt-4">
        <h2 className="mb-1 text-[10.5pt] font-bold">Package</h2>
        <table className="w-full text-[9.5pt]">
          <tbody>
            <Row k="File name">
              <Mono>{r.package_filename}</Mono>
            </Row>
            <Row k="Package SHA-256">
              <Mono>{r.package_sha256}</Mono>
            </Row>
            <Row k="Chain head (last chain hash)">
              <Mono>{r.chain_head ?? '—'}</Mono>
            </Row>
          </tbody>
        </table>
      </section>

      <section className="mt-4">
        <h2 className="mb-1 text-[10.5pt] font-bold">Method</h2>
        <ol className="list-decimal space-y-0.5 pl-5 text-[9.5pt]">
          <li>Every frame's JPEG bytes are fingerprinted with SHA-256 at capture time.</li>
          <li>
            Each fingerprint is linked into a hash chain: every link covers the previous link, the frame hash, a perceptual hash, the
            sequence number and the timestamp — removing, inserting or reordering any frame breaks the chain.
          </li>
          <li>
            The chain head is signed with the device's Ed25519 private key at a checkpoint every {n ?? 'N'} frames, and a final seal
            record signs the last frame and the frame count when recording stops.
          </li>
          <li>
            This verification recomputed every hash and link from the package and checked every signature using only the device public key
            above.
          </li>
        </ol>
      </section>

      <section className="mt-4 break-inside-avoid">
        <h2 className="mb-1 text-[10.5pt] font-bold">Findings ({r.incidents.length})</h2>
        {r.incidents.length === 0 ? (
          <p className="text-[9.5pt] text-[#4b5563]">
            {r.verdict === 'INCOMPLETE'
              ? 'No altered, inserted or reordered frame was found. The recording ends before its signed seal.'
              : 'None — no frame was altered, inserted, removed or reordered.'}
          </p>
        ) : (
          <table className="w-full border-collapse text-[9pt]">
            <thead>
              <tr className="border-b-2 border-[#111827] text-left">
                <th className="py-1 pr-2">Kind</th>
                <th className="py-1 pr-2">Finding</th>
                <th className="py-1 pr-2">Frames</th>
                <th className="py-1">Proof</th>
              </tr>
            </thead>
            <tbody>
              {r.incidents.map((i) => (
                <tr key={i.id} className="border-b border-[#e5e7eb] align-top">
                  <td className="py-1.5 pr-2 font-mono text-[8pt]">{i.kind}</td>
                  <td className="py-1.5 pr-2">
                    <div className="font-semibold">{i.title}</div>
                    <div className="text-[8.5pt] text-[#4b5563]">{i.explanation}</div>
                  </td>
                  <td className="py-1.5 pr-2 whitespace-nowrap">
                    #{i.seq_from}
                    {i.seq_to !== i.seq_from && `–${i.seq_to}`}
                    <div className="text-[8pt] text-[#6b7280]">
                      {i.affected_count} affected{i.missing_count ? `, ${i.missing_count} missing` : ''}
                    </div>
                  </td>
                  <td className="py-1.5 font-mono text-[8pt] break-words">{i.proof}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <footer className="mt-6 border-t border-[#d1d5db] pt-2 text-[8.5pt] text-[#4b5563]">
        Provides the hash value details for Part A of a Section 63(4) Bharatiya Sakshya Adhiniyam certificate. This is a technical report,
        not the legal certificate.
      </footer>
    </article>
  )
}

export function ReportView() {
  const reportId = useUi((s) => s.reportId)
  const navigate = useUi((s) => s.navigate)
  const cached = useEvidence((s) => s.report)
  const [report, setReport] = useState<VerificationReport | null>(cached?.report_id === reportId ? cached : null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!reportId || report?.report_id === reportId) return
    let alive = true
    api
      .getReport(reportId)
      .then((r) => alive && setReport(r))
      .catch((err: unknown) => alive && setError(err instanceof ApiRequestError ? err.detail : String(err)))
    return () => {
      alive = false
    }
  }, [reportId, report])

  return (
    <div className="min-h-full bg-[#0b0f18] pb-10 print:bg-white print:pb-0">
      <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-surface/90 px-4 py-2.5 backdrop-blur print:hidden">
        <button
          type="button"
          onClick={() => navigate('evidence')}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-raised px-3 text-[13px] text-text hover:border-pending/60"
        >
          <ArrowLeft className="size-4" /> Evidence
        </button>
        <span className="text-[13px] text-muted">Verification report — A4, prints on one or two pages</span>
        <button
          type="button"
          disabled={!report}
          onClick={() => window.print()}
          className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-lg bg-pending px-3 text-[13px] font-semibold text-bg hover:bg-pending/90 disabled:opacity-50"
        >
          <Printer className="size-4" /> Print / Save as PDF
        </button>
      </div>
      <div className="pt-6 print:pt-0">
        {report ? (
          <Report r={report} />
        ) : error ? (
          <div className="mx-auto max-w-md rounded-xl border border-tampered/50 bg-surface p-6 text-center text-sm text-tampered">{error}</div>
        ) : (
          <div className="flex items-center justify-center gap-2 py-20 text-muted">
            <Loader2 className="size-5 animate-spin" /> Loading report…
          </div>
        )}
      </div>
    </div>
  )
}
