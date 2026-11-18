// Shared vocabulary for incidents and attacks: icons, short blurbs, "detected in" wording, time-ago.

import {
  ArrowDownUp,
  Eraser,
  ImageOff,
  ImagePlus,
  KeyRound,
  Link2Off,
  Repeat,
  Scissors,
  Stamp,
  Unplug,
  WifiOff,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AttackType, Incident, IncidentKind } from '../api/types'

export const KIND_ICON: Record<IncidentKind, LucideIcon> = {
  FRAME_MODIFIED: ImageOff,
  FRAME_DELETED: Scissors,
  FRAME_INSERTED: ImagePlus,
  FRAME_REORDERED: ArrowDownUp,
  REPLAY_DETECTED: Repeat,
  CHAIN_FORGED: KeyRound,
  CHAIN_BROKEN: Link2Off,
  STREAM_INTERRUPTED: WifiOff,
}

export const ATTACK_ICON: Record<AttackType, LucideIcon> = {
  PIXEL_TAMPER: Eraser,
  FRAME_DROP: Scissors,
  FRAME_INSERT: ImagePlus,
  FRAME_REORDER: ArrowDownUp,
  LOOP_REPLAY: Repeat,
  CHAIN_FORGE: Stamp,
  STREAM_CUT: Unplug,
}

/** One-liners for the console cards (the catalog's description is the tooltip). */
export const ATTACK_BLURB: Record<AttackType, string> = {
  PIXEL_TAMPER: 'Blur the centre of the next 30 frames',
  FRAME_DROP: 'Silently drop 10 frames',
  FRAME_INSERT: 'Slip in one forged frame',
  FRAME_REORDER: 'Swap two frames in transit',
  LOOP_REPLAY: 'Replay the last 3 s on a loop',
  CHAIN_FORGE: 'Edit frames & recompute every hash',
  STREAM_CUT: 'Kill the feed for 4 seconds',
}

/** Order of CONTRACT §7 — also the 1–7 shortcut keys. */
export const ATTACK_ORDER: AttackType[] = [
  'PIXEL_TAMPER',
  'FRAME_DROP',
  'FRAME_INSERT',
  'FRAME_REORDER',
  'LOOP_REPLAY',
  'CHAIN_FORGE',
  'STREAM_CUT',
]

export function detectedText(inc: Incident, watchdogS = 2): string {
  if (inc.kind === 'CHAIN_FORGED') return 'Detected at the next signature'
  if (inc.kind === 'STREAM_INTERRUPTED') return `Detected after ${watchdogS.toFixed(1)} s of silence`
  if (inc.detection_latency_ms === null) return 'Detected live'
  return `Detected in ${inc.detection_latency_ms} ms`
}

export function seqRange(inc: Incident): string {
  return inc.seq_from === inc.seq_to ? `#${inc.seq_from}` : `#${inc.seq_from}–${inc.seq_to}`
}

export function timeAgo(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s} s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  return `${Math.floor(m / 60)} h ago`
}

/** Re-render every `ms` (for "time ago" and timed gates). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}
