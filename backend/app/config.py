"""Backend settings and paths."""

from datetime import UTC, datetime
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
DATA_DIR = BACKEND_ROOT / "data"
SAMPLE_VIDEO = REPO_ROOT / "demo" / "sample.mp4"
FRONTEND_DIST = REPO_ROOT / "frontend" / "dist"
SESSION_MAX_SECONDS = 30 * 60
SESSION_MAX_FRAMES = 30_000


def utc_timestamp(timestamp: float | None = None) -> str:
    """Format a Unix timestamp or the current time as UTC."""
    value = datetime.now(UTC) if timestamp is None else datetime.fromtimestamp(timestamp, UTC)
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")
