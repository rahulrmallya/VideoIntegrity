import { useState } from 'react'
import { copyText, shortHash } from '../../lib/format'

type Props = { value: string | null | undefined; n?: number; className?: string; label?: string }

/** Shortened hash in mono; full value on hover, click to copy. */
export function Hash({ value, n = 4, className = '', label }: Props) {
  const [copied, setCopied] = useState(false)
  if (!value) return <span className={`font-mono ${className}`}>—</span>
  return (
    <button
      type="button"
      title={`${label ? label + ': ' : ''}${value}\n(click to copy)`}
      onClick={async (e) => {
        e.stopPropagation()
        if (await copyText(value)) {
          setCopied(true)
          setTimeout(() => setCopied(false), 900)
        }
      }}
      className={`cursor-copy font-mono tabular-nums hover:text-text ${className}`}
    >
      {copied ? 'copied' : shortHash(value, n)}
    </button>
  )
}
