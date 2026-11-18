"""Webcam, file, and synthetic frame sources."""

import logging
from datetime import UTC, datetime
from math import cos, sin
from pathlib import Path
from time import monotonic
from typing import Literal, Protocol

import cv2
import numpy as np

from app.config import REPO_ROOT, SAMPLE_VIDEO
from app.models import Source, StartRequest

logger = logging.getLogger(__name__)


class FrameSource(Protocol):
    """A source of capture frames at the requested dimensions."""

    kind: Source
    label: str

    def read(self) -> np.ndarray | None:
        """Read the next image or report a read failure."""
        ...

    def close(self) -> None:
        """Release resources held by the source."""
        ...


class _VideoSource:
    """Read and resize frames from an OpenCV capture."""

    def __init__(
        self, capture: cv2.VideoCapture, width: int, height: int, label: str, *, loop: bool
    ) -> None:
        """Open the capture and save the first successfully read frame."""
        self._capture = capture
        self._width = width
        self._height = height
        self.label = label
        self._loop = loop
        self._first: np.ndarray | None = None
        try:
            if not self._capture.isOpened():
                raise OSError(f"Could not open {label}")
            self._first = self.read()
            if self._first is None:
                raise OSError(f"Could not read a frame from {label}")
        except (OSError, cv2.error):
            self.close()
            raise

    def read(self) -> np.ndarray | None:
        """Read a resized frame, rewinding a looped file when needed."""
        if self._first is not None:
            frame, self._first = self._first, None
            return frame
        ok, frame = self._capture.read()
        if not ok and self._loop:
            self._capture.set(cv2.CAP_PROP_POS_FRAMES, 0)
            ok, frame = self._capture.read()
        if not ok or frame is None:
            return None
        if frame.shape[:2] != (self._height, self._width):
            return cv2.resize(frame, (self._width, self._height), interpolation=cv2.INTER_AREA)
        return frame

    def close(self) -> None:
        """Release the OpenCV capture."""
        self._capture.release()


class WebcamSource(_VideoSource):
    """Capture local webcam frames through DirectShow."""

    kind: Literal["webcam"] = "webcam"

    def __init__(
        self, index: int = 0, width: int = 640, height: int = 480, fps: float = 15
    ) -> None:
        """Request the configured resolution and frame rate from the camera."""
        capture = cv2.VideoCapture(index, cv2.CAP_DSHOW)
        try:
            if capture.isOpened():
                capture.set(cv2.CAP_PROP_FRAME_WIDTH, width)
                capture.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
                capture.set(cv2.CAP_PROP_FPS, fps)
        except cv2.error:
            capture.release()
            raise
        super().__init__(capture, width, height, f"Webcam {index}", loop=False)


class FileSource(_VideoSource):
    """Loop a local video file at the capture pipeline's pace."""

    kind: Literal["file"] = "file"

    def __init__(self, path: Path, width: int = 640, height: int = 480) -> None:
        """Open a file and validate that it supplies frames."""
        super().__init__(cv2.VideoCapture(str(path)), width, height, f"File: {path.name}", loop=True)


class SyntheticSource:
    """Generate a moving offline test image and a live UTC clock."""

    kind: Literal["synthetic"] = "synthetic"
    label = "Synthetic camera"

    def __init__(self, width: int = 640, height: int = 480) -> None:
        """Prepare the dark gradient shared by all synthetic frames."""
        self._width = width
        self._height = height
        self._started = monotonic()
        horizontal = np.linspace(0, 1, width, dtype=np.float32)
        vertical = np.linspace(0, 1, height, dtype=np.float32)[:, None]
        shade = 12 + 30 * horizontal + 25 * vertical
        self._background = np.stack((shade * 1.6, shade * 1.2, shade), axis=-1).astype(np.uint8)

    def read(self) -> np.ndarray:
        """Draw a moving circle and current clock on a fresh frame."""
        frame = self._background.copy()
        elapsed = monotonic() - self._started
        point = (
            int(self._width * (0.5 + 0.30 * sin(elapsed * 1.3))),
            int(self._height * (0.54 + 0.24 * cos(elapsed * 1.8))),
        )
        scale = min(self._width / 640, self._height / 480)
        cv2.circle(frame, point, max(1, int(35 * scale)), (220, 195, 55), -1, cv2.LINE_AA)
        font_scale = max(0.1, scale * 0.8)
        margin = max(1, int(20 * scale))
        for text, offset in (
            ("SYNTHETIC CAMERA", 38),
            (datetime.now(UTC).strftime("%Y-%m-%d %H:%M:%S UTC"), 70),
        ):
            cv2.putText(frame, text, (margin, max(1, int(offset * scale))),
                        cv2.FONT_HERSHEY_SIMPLEX, font_scale, (225, 235, 245), 1, cv2.LINE_AA)
        return frame

    def close(self) -> None:
        """Release the synthetic source, which holds no capture handle."""


def open_source(request: StartRequest) -> tuple[FrameSource, str]:
    """Open the requested source, falling back through file and synthetic."""
    source: FrameSource | None = None
    if request.source == "webcam":
        try:
            index = request.camera_index if request.camera_index is not None else 0
            source = WebcamSource(index, request.width, request.height, request.fps)
        except (OSError, cv2.error) as error:
            logger.info("Webcam unavailable (%s). Trying the demo file.", error)

    if source is None and request.source in ("webcam", "file"):
        path = SAMPLE_VIDEO
        if request.source == "file" and request.file_path:
            path = REPO_ROOT / request.file_path
        if path.is_file():
            try:
                source = FileSource(path, request.width, request.height)
            except (OSError, cv2.error) as error:
                logger.info("Video file unavailable (%s). Trying synthetic capture.", error)

    if source is None:
        source = SyntheticSource(request.width, request.height)
    logger.info("Using source %s", source.label)
    return source, source.label
