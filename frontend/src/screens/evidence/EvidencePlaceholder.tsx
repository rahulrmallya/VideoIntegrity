import { ArrowLeft, FileArchive } from 'lucide-react'
import { TopBar } from '../live/TopBar'
import { useUi } from '../../store/useUi'

/** Stub for the Evidence screen (export / verify packages) — built in a later task. */
export function EvidencePlaceholder() {
  const goLive = useUi((s) => s.goLive)
  const evidenceFor = useUi((s) => s.evidenceFor)
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <TopBar />
      <main className="flex min-h-0 flex-1 items-center justify-center p-6">
        <div className="w-full max-w-lg rounded-2xl border border-border bg-surface p-8 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-2xl border border-border bg-raised">
            <FileArchive className="size-6 text-pending" />
          </div>
          <h1 className="mt-4 text-xl font-semibold text-text">Evidence</h1>
          <p className="mt-1 text-sm text-muted">
            Export a signed evidence package and verify it offline — this screen arrives in a later task.
          </p>
          {evidenceFor && (
            <p className="mt-3 font-mono text-xs text-muted">
              requested from incident <span className="text-text">{evidenceFor}</span>
            </p>
          )}
          <button
            type="button"
            onClick={goLive}
            className="mt-6 inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-raised px-4 text-sm text-text hover:border-pending/60"
          >
            <ArrowLeft className="size-4" /> Back to Live Monitor
          </button>
        </div>
      </main>
    </div>
  )
}
