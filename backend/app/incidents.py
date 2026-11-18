"""Integrity incident grouping."""

from collections import deque
from collections.abc import Callable
from datetime import UTC, datetime

from app.models import Incident, IncidentEvidence, IncidentKind

RECENT_LIMIT = 900

TITLES: dict[IncidentKind, str] = {
    "FRAME_MODIFIED": "Frame content altered",
    "FRAME_DELETED": "Frames deleted",
    "FRAME_INSERTED": "Fake frame inserted",
    "FRAME_REORDERED": "Frames shuffled",
    "REPLAY_DETECTED": "Old footage replayed",
    "CHAIN_FORGED": "Forgery caught by signature",
    "CHAIN_BROKEN": "Chain broken",
    "STREAM_INTERRUPTED": "Live feed cut",
}


def _utc_now() -> str:
    """Return a UTC timestamp for an incident event."""
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _explanation(incident: Incident, span: tuple[int, int], silence_s: float) -> str:
    """Describe the primary failure using its evidence or sequence range."""
    sample = incident.evidence.sample_seq
    first, last = span
    match incident.kind:
        case "FRAME_MODIFIED":
            return (
                f"The pixels of frame #{sample} don't match the fingerprint the camera "
                "recorded. Someone edited this frame after it was captured."
            )
        case "FRAME_DELETED":
            return (
                f"{incident.missing_count} frames (#{first}–#{last}) never arrived. "
                "The chain jumps over them, so the missing footage is provable."
            )
        case "FRAME_INSERTED":
            return (
                f"Two different frames claimed to be #{sample}. "
                "Only one belongs to the camera's signed chain."
            )
        case "FRAME_REORDERED":
            return (
                f"Frame #{sample} arrived after a later frame. "
                "The chain order proves it was moved."
            )
        case "REPLAY_DETECTED":
            return (
                f"The stream is showing frames #{first}–#{last} a second time. "
                "Someone is looping recorded footage instead of live video."
            )
        case "CHAIN_FORGED":
            return (
                "Every frame hash looked valid, but the camera's signature over the "
                "chain does not match. Someone edited frames and recomputed the hashes "
                "— they cannot forge the camera's private-key signature."
            )
        case "CHAIN_BROKEN":
            return f"Frame #{sample} does not link to the previous frame's hash."
        case "STREAM_INTERRUPTED":
            return f"No signed frames reached the viewer for {silence_s:g} s."


class _RecentRanges:
    """Count distinct sequences while retaining recent ranges for deduplication."""

    def __init__(self) -> None:
        """Start with no sequence ranges."""
        self._ranges: list[tuple[int, int]] = []

    def add(self, first: int, last: int) -> int:
        """Merge a range and return the count of newly covered sequences."""
        added = last - first + 1
        merged: list[tuple[int, int]] = []
        for start, stop in self._ranges:
            if stop < first - 1:
                merged.append((start, stop))
            elif start > last + 1:
                merged.append((first, last))
                first, last = start, stop
            else:
                added -= max(0, min(last, stop) - max(first, start) + 1)
                first, last = min(first, start), max(last, stop)
        merged.append((first, last))
        self._ranges = merged[-RECENT_LIMIT:]
        return added

    def discard(self, seq: int) -> bool:
        """Remove a late sequence from the outstanding ranges if present."""
        for index, (first, last) in enumerate(self._ranges):
            if first <= seq <= last:
                remaining = []
                if first < seq:
                    remaining.append((first, seq - 1))
                if seq < last:
                    remaining.append((seq + 1, last))
                self._ranges[index:index + 1] = remaining
                if len(self._ranges) > RECENT_LIMIT:
                    self._ranges.pop(0)
                return True
        return False


class IncidentManager:
    """Group consecutive verifier failures and emit an incident on every change."""

    def __init__(self, on_event: Callable[[Incident], None] | None = None) -> None:
        """Create a session-local incident manager with an optional event sink."""
        self._on_event = on_event
        self._open: Incident | None = None
        self._closed: deque[Incident] = deque(maxlen=RECENT_LIMIT)
        self._affected = _RecentRanges()
        self._missing = _RecentRanges()
        self._primary_span = (0, 0)
        self.total = 0

    @property
    def open_incident(self) -> Incident | None:
        """Return an independent snapshot of the open incident, if any."""
        return self._open.model_copy(deep=True) if self._open is not None else None

    @property
    def incidents(self) -> list[Incident]:
        """Return the current and recent incidents, newest first."""
        incidents = [incident.model_copy(deep=True) for incident in reversed(self._closed)]
        if self._open is not None:
            incidents.insert(0, self._open.model_copy(deep=True))
        return incidents

    def report(
        self,
        kind: IncidentKind,
        seq_from: int,
        seq_to: int,
        evidence: IncidentEvidence,
        proof: str,
        *,
        silence_s: float = 0.0,
    ) -> Incident:
        """Open or extend an incident and publish the updated snapshot."""
        incident = self._open
        if incident is None:
            self.total += 1
            self._primary_span = (seq_from, seq_to)
            incident = Incident(
                id=f"inc_{self.total:04d}",
                kind=kind,
                kinds_seen=[kind],
                severity="warning" if kind == "STREAM_INTERRUPTED" else "critical",
                status="open",
                title=TITLES[kind],
                explanation="",
                proof=proof,
                seq_from=seq_from,
                seq_to=seq_to,
                affected_count=0,
                missing_count=0,
                opened_at=_utc_now(),
                closed_at=None,
                detection_latency_ms=None,
                attack_id=None,
                attack_type=None,
                evidence=evidence.model_copy(),
                acknowledged=False,
            )
            self._open = incident
        elif kind not in incident.kinds_seen:
            incident.kinds_seen.append(kind)

        incident.seq_from = min(incident.seq_from, seq_from)
        incident.seq_to = max(incident.seq_to, seq_to)
        incident.affected_count += self._affected.add(seq_from, seq_to)
        if kind == incident.kind:
            first, last = self._primary_span
            self._primary_span = (min(first, seq_from), max(last, seq_to))
        if kind == "FRAME_DELETED":
            incident.missing_count += self._missing.add(seq_from, seq_to)
        elif kind == "FRAME_REORDERED":
            if self._missing.discard(evidence.sample_seq):
                incident.missing_count -= 1
            if incident.kind == "FRAME_DELETED":
                incident.kind = kind
                incident.title = TITLES[kind]
                incident.evidence = evidence.model_copy()
                incident.proof = proof
                incident.explanation = ""
                self._primary_span = (seq_from, seq_to)

        if not incident.explanation or incident.kind in {"FRAME_DELETED", "REPLAY_DETECTED"}:
            incident.explanation = _explanation(incident, self._primary_span, silence_s)
        return self._emit(incident)

    def close(self) -> Incident | None:
        """Close the open incident and emit its final snapshot."""
        incident = self._open
        if incident is None:
            return None
        incident.status = "closed"
        incident.closed_at = _utc_now()
        self._open = None
        self._affected = _RecentRanges()
        self._missing = _RecentRanges()
        self._closed.append(incident)
        return self._emit(incident)

    def _emit(self, incident: Incident) -> Incident:
        """Publish a snapshot that subsequent incident changes cannot mutate."""
        snapshot = incident.model_copy(deep=True)
        if self._on_event is not None:
            self._on_event(snapshot.model_copy(deep=True))
        return snapshot
