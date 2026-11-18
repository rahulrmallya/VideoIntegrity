import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileArchive,
  FileCheck2,
  FileX2,
  FlaskConical,
  Loader2,
  Scissors,
  ScissorsLineDashed,
  ShieldCheck,
  Square,
  Upload,
  XCircle,
} from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import type { TamperSampleMode, VerificationReport } from '../../api/types'
import { Hash } from '../../components/ui/Hash'
import { fmtBytes } from '../../lib/format'
import { useNow } from '../../lib/incidents'
import { useSession } from '../../store/useLive'
import { useEvidence } from '../../store/useEvidence'
import { useUi } from '../../store/useUi'
import { IncidentRow } from '../live/IncidentFeed'
import { TopBar } from '../live/TopBar'
import { Card, CopyField, VERDICT_STYLE, VerdictStamp, VerifyProgress } from './parts'

const btnPrimary =
  'inline-flex h-10 items-center gap-2 rounded-lg bg-pending px-4 text-[13.5px] font-semibold text-bg hover:bg-pending/90 disabled:cursor-not-allowed disabled:opacity-50'
const btnGhost =
  'inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-raised px-3 text-[13px] font-medium text-text hover:border-pending/60 disabled:cursor-not-allowed disabled:opacity-50'

function ErrorBox({ children }: { children: ReactNode }) {
  return (
    <div className="mt-3 flex items-start gap-2 rounded-lg border border-tampered/50 bg-tampered/[0.07] px-3 py-2.5 text-[13px] text-tampered">
      <XCircle className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 break-words">{children}</span>
    </div>
  )
}

// --- 1. Export -------------------------------------------------------------------------------------

function ExportCard() {
  const session = useSession()
  const { exportStep, exportError, exported, exportPackage, verifyExported, verifyPhase } = useEvidence()
  const running = session?.status === 'running'
  const busy = exportStep === 'stopping' || exportStep === 'packaging'

  return (
    <Card title="Export signed evidence" icon={<FileArchive className="size-4 text-pending" />}>
      <p className="text-[13px] leading-relaxed text-muted">
        {running
          ? 'Stops the live session, waits for the final Ed25519 seal, then packs every frame, the hash-chain ledger and the seal into one zip.'
          : 'Packs every frame of the last session, the hash-chain ledger and the signed seal into one zip.'}
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" className={btnPrimary} disabled={busy} onClick={() => void exportPackage('stop')}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : running ? <Square className="size-4 fill-current" /> : <FileArchive className="size-4" />}
          {running ? 'Stop & Export' : 'Export'}
        </button>
        {running && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void exportPackage('snapshot')}
            className="text-[12.5px] text-muted underline decoration-dotted underline-offset-4 hover:text-text disabled:opacity-50"
          >
            Export snapshot (keep recording)
          </button>
        )}
        {busy && (
          <span className="text-[12.5px] text-pending">
            {exportStep === 'stopping' ? 'Stopping session · waiting for the seal…' : 'Packaging frames, ledger and seal…'}
          </span>
        )}
      </div>
      {exportStep === 'error' && exportError && <ErrorBox>{exportError}</ErrorBox>}

      {exported && exportStep !== 'stopping' && exportStep !== 'packaging' && (
        <div className="mt-4 space-y-3 rounded-xl border border-border bg-raised/40 p-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
            <span className="font-mono text-text break-all">{exported.filename}</span>
            <span className="text-muted">
              {exported.frame_count.toLocaleString('en-US')} frames · {fmtBytes(exported.size_bytes)}
              {exported.sealSeq !== null && <> · sealed at #{exported.sealSeq}</>}
            </span>
          </div>
          <CopyField label="Package SHA-256" value={exported.package_sha256} />
          {exported.snapshot && (
            <div className="flex items-start gap-2 rounded-lg border border-unverified/50 bg-unverified/[0.07] px-3 py-2 text-[12.5px] text-unverified">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              Snapshot of a running session: it has no final seal yet, so it will verify as INCOMPLETE until the session is stopped and
              exported again.
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <a className={btnGhost} href={exported.download_url} download={exported.filename}>
              <Download className="size-4" /> Download
            </a>
            <button type="button" className={btnGhost} disabled={verifyPhase === 'running'} onClick={() => void verifyExported()}>
              <ShieldCheck className="size-4" /> Verify this package
            </button>
          </div>
        </div>
      )}
    </Card>
  )
}

// --- 3. Judge test ---------------------------------------------------------------------------------

const JUDGE: { mode: TamperSampleMode; label: string; Icon: typeof Scissors; what: string }[] = [
  { mode: 'modify', label: 'Edit a frame', Icon: FlaskConical, what: 'blurs one frame 40% into the recording' },
  { mode: 'delete', label: 'Delete frames', Icon: Scissors, what: 'removes 10 frames and their ledger lines' },
  { mode: 'truncate', label: 'Cut the ending', Icon: ScissorsLineDashed, what: 'drops the last 30 frames' },
]

function JudgeTest() {
  const { judge, makeTamperCopy, verifyTamperCopy, exported, verifyPhase } = useEvidence()
  return (
    <Card title="Judge test" icon={<FlaskConical className="size-4 text-unverified" />}>
      <p className="text-[13px] leading-relaxed text-muted">
        Make a deliberately tampered copy of the {exported ? 'exported' : 'latest exported'} package, then verify it.
      </p>
      <div className="mt-3 space-y-2">
        {JUDGE.map(({ mode, label, Icon, what }) => {
          const j = judge[mode]
          return (
            <div key={mode} className="rounded-xl border border-border bg-raised/40 px-3 py-2.5">
              <div className="flex items-center gap-3">
                <button type="button" className={btnGhost} disabled={j.status === 'working'} onClick={() => void makeTamperCopy(mode)}>
                  {j.status === 'working' ? <Loader2 className="size-4 animate-spin" /> : <Icon className="size-4 text-unverified" />}
                  {label}
                </button>
                <span className="min-w-0 flex-1 truncate text-[12px] text-muted">{j.result?.description ?? what}</span>
                {j.result && (
                  <>
                    <a className="text-[12px] text-pending underline-offset-4 hover:underline" href={j.result.download_url} download={j.result.filename}>
                      Download
                    </a>
                    <button
                      type="button"
                      disabled={verifyPhase === 'running'}
                      onClick={() => void verifyTamperCopy(mode)}
                      className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-unverified/15 px-2.5 text-[12px] font-semibold text-unverified hover:bg-unverified/25 disabled:opacity-50"
                    >
                      <ShieldCheck className="size-3.5" /> Verify this copy
                    </button>
                  </>
                )}
              </div>
              {j.status === 'error' && j.error && <ErrorBox>{j.error}</ErrorBox>}
            </div>
          )
        })}
      </div>
      <p className="mt-3 text-[12px] text-muted/80 italic">Or open the zip, edit any frame in Paint, zip it again and drop it above.</p>
    </Card>
  )
}

// --- 2. Verify -------------------------------------------------------------------------------------

function Dropzone() {
  const verify = useEvidence((s) => s.verify)
  const running = useEvidence((s) => s.verifyPhase === 'running')
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const take = (f: File | undefined) => {
    if (f) void verify(f, f.name)
  }
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        if (!running) take(e.dataTransfer.files[0])
      }}
      onClick={() => !running && input.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !running) input.current?.click()
      }}
      className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors ${
        over ? 'border-pending bg-pending/[0.07]' : 'border-border hover:border-pending/50 hover:bg-raised/40'
      }`}
    >
      <Upload className={`size-7 ${over ? 'text-pending' : 'text-muted'}`} />
      <div className="text-[14px] font-medium text-text">Drop an evidence .zip here</div>
      <div className="text-[12px] text-muted">or click to choose a file — verified with only the camera's public key</div>
      <input
        ref={input}
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        onChange={(e) => {
          take(e.target.files?.[0])
          e.target.value = ''
        }}
      />
    </div>
  )
}

function Stat({ label, value, tone = 'text-text' }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className="rounded-lg border border-border bg-raised/40 px-3 py-2">
      <div className="text-[10.5px] font-semibold tracking-[0.1em] text-muted uppercase">{label}</div>
      <div className={`mt-0.5 font-mono text-[18px] font-medium tabular-nums ${tone}`}>{value}</div>
    </div>
  )
}

function VerifyResult({ report }: { report: VerificationReport }) {
  const navigate = useUi((s) => s.navigate)
  const openReportIncident = useUi((s) => s.openReportIncident)
  const now = useNow(60_000)
  const st = VERDICT_STYLE[report.verdict]
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-5">
        <VerdictStamp verdict={report.verdict} />
        <div className="min-w-0 flex-1">
          <p className={`text-[15px] font-medium ${st.color}`}>{st.line}</p>
          <p className="mt-1 truncate text-[12px] text-muted">
            <span className="font-mono">{report.package_filename}</span> · SHA-256{' '}
            <Hash value={report.package_sha256} className="text-text" />
          </p>
        </div>
      </div>
      <div className="grid grid-cols-4 gap-2">
        <Stat label="Frames" value={report.frames_total.toLocaleString('en-US')} />
        <Stat label="OK" value={report.frames_ok.toLocaleString('en-US')} tone="text-sealed" />
        <Stat label="Tampered" value={report.frames_tampered} tone={report.frames_tampered ? 'text-tampered' : 'text-muted'} />
        <Stat label="Missing" value={report.frames_missing} tone={report.frames_missing ? 'text-tampered' : 'text-muted'} />
        <Stat
          label="Checkpoints"
          value={`${report.checkpoints_valid}/${report.checkpoints_total}`}
          tone={report.checkpoints_valid === report.checkpoints_total ? 'text-sealed' : 'text-tampered'}
        />
        <Stat
          label="Seal"
          value={
            report.seal_valid ? (
              <span className="inline-flex items-center gap-1">
                <CheckCircle2 className="size-4" /> valid
              </span>
            ) : (
              <span className="inline-flex items-center gap-1">
                <XCircle className="size-4" /> {report.verdict === 'INCOMPLETE' ? 'missing' : 'invalid'}
              </span>
            )
          }
          tone={report.seal_valid ? 'text-sealed' : 'text-unverified'}
        />
        <Stat label="Verify time" value={`${report.verify_ms.toFixed(0)} ms`} />
        <Stat label="Chain head" value={<Hash value={report.chain_head} className="text-[15px]" />} />
      </div>
      {report.incidents.length > 0 && (
        <div>
          <div className="mb-1.5 text-[11px] font-semibold tracking-[0.1em] text-muted uppercase">
            Incidents found in the package ({report.incidents.length})
          </div>
          <div className="space-y-1.5">
            {report.incidents.map((inc) => (
              <IncidentRow key={inc.id} inc={inc} now={now} watchdogS={2} offline onOpen={() => openReportIncident(inc)} />
            ))}
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={btnPrimary} onClick={() => navigate('report', report.report_id)}>
          <FileCheck2 className="size-4" /> View report
        </button>
        <span className="font-mono text-[11.5px] text-muted">{report.report_id}</span>
      </div>
    </div>
  )
}

function VerifyCard() {
  const { verifyPhase, verifyFilename, verifyEstimate, verifyError, report, resetVerify } = useEvidence()
  return (
    <Card
      title="Verify a package"
      icon={<ShieldCheck className="size-4 text-sealed" />}
      aside={
        verifyPhase === 'done' || verifyPhase === 'error' ? (
          <button type="button" onClick={resetVerify} className="text-[12px] text-muted hover:text-text">
            Verify another
          </button>
        ) : null
      }
    >
      {verifyPhase === 'idle' && <Dropzone />}
      {verifyPhase === 'running' && <VerifyProgress estimate={verifyEstimate} filename={verifyFilename} />}
      {verifyPhase === 'done' && report && <VerifyResult report={report} />}
      {verifyPhase === 'error' && (
        <div>
          <div className="flex items-start gap-3 rounded-xl border border-tampered/50 bg-tampered/[0.06] p-4">
            <FileX2 className="mt-0.5 size-6 shrink-0 text-tampered" />
            <div className="min-w-0">
              <div className="text-[14px] font-semibold text-text">Could not verify {verifyFilename ?? 'this file'}</div>
              <div className="mt-0.5 text-[13px] break-words text-tampered">{verifyError}</div>
            </div>
          </div>
          <div className="mt-3">
            <Dropzone />
          </div>
        </div>
      )}
    </Card>
  )
}

export function EvidenceScreen() {
  return (
    <div className="flex h-screen min-h-0 flex-col overflow-hidden">
      <TopBar />
      <main className="min-h-0 flex-1 overflow-y-auto p-4 [scrollbar-color:#1F2A40_transparent] [scrollbar-width:thin]">
        <div className="mx-auto grid max-w-[1560px] grid-cols-[minmax(0,1fr)_minmax(0,1.12fr)] gap-4">
          <div className="flex min-w-0 flex-col gap-4">
            <ExportCard />
            <JudgeTest />
          </div>
          <div className="min-w-0">
            <VerifyCard />
          </div>
        </div>
      </main>
    </div>
  )
}
