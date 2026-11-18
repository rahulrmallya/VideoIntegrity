"""Count live FrameSeal WebSocket messages for ten seconds."""

import argparse
import json
import logging
import sys
from collections import Counter
from time import monotonic

from websockets.exceptions import WebSocketException
from websockets.sync.client import connect

logger = logging.getLogger(__name__)
DEFAULT_URL = "ws://127.0.0.1:8000/ws/live"
DURATION_S = 10


def main() -> int:
    """Connect to FrameSeal and report counts and one sample per type."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url", nargs="?", default=DEFAULT_URL)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stdout)
    counts: Counter[str] = Counter()
    samples: dict[str, dict[str, object]] = {}
    valid_seals = 0

    try:
        with connect(args.url, proxy=None) as websocket:
            end = monotonic() + DURATION_S
            while (remaining := end - monotonic()) > 0:
                try:
                    message = json.loads(websocket.recv(timeout=remaining))
                except TimeoutError:
                    break
                kind = message["type"]
                counts[kind] += 1
                if kind == "seal" and message["valid"]:
                    valid_seals += 1
                if kind not in samples:
                    message.pop("jpeg_b64", None)
                    samples[kind] = message
    except (OSError, WebSocketException, ValueError, KeyError) as error:
        logger.error("WebSocket probe failed: %s", error)
        return 1

    for kind in ("hello", "session", "frame", "status", "seal", "stats", "incident", "attack"):
        if kind == "seal":
            logger.info("%s: %d (%d valid, %d invalid)", kind, counts[kind],
                        valid_seals, counts[kind] - valid_seals)
        else:
            logger.info("%s: %d", kind, counts[kind])
        if kind in samples:
            logger.info("  %s", json.dumps(samples[kind], ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
