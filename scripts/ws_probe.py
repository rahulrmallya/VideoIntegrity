"""Inspect a live FrameSeal WebSocket and optionally launch an attack."""

import argparse
import json
import logging
import sys
from collections import Counter
from time import monotonic
from urllib.parse import urlsplit, urlunsplit

import httpx
from websockets.exceptions import WebSocketException
from websockets.sync.client import connect

logger = logging.getLogger(__name__)
DEFAULT_URL = "ws://127.0.0.1:8000/ws/live"
DURATION_S = 10


def attack_url(ws_url: str) -> str:
    """Derive the attacks API URL from the WebSocket URL."""
    ws = urlsplit(ws_url)
    scheme = "https" if ws.scheme == "wss" else "http"
    return urlunsplit((scheme, ws.netloc, "/api/attacks", "", ""))


def main() -> int:
    """Connect to FrameSeal and report counts and one sample per type."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url", nargs="?", default=DEFAULT_URL)
    parser.add_argument("--attack", metavar="TYPE", help="POST this attack after two seconds")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stdout)
    counts: Counter[str] = Counter()
    samples: dict[str, dict[str, object]] = {}
    valid_seals = 0
    ack = None
    attack_incident = None
    attack_ended = False

    try:
        with connect(args.url, proxy=None) as websocket:
            start = monotonic()
            end = start + DURATION_S
            launch_at = start + 2 if args.attack else end
            while (remaining := end - monotonic()) > 0:
                if args.attack and ack is None and monotonic() >= launch_at:
                    with httpx.Client(trust_env=False) as client:
                        response = client.post(attack_url(args.url), json={"type": args.attack})
                        if response.is_error:
                            logger.error("Attack POST returned %d: %s", response.status_code, response.text)
                            return 1
                        ack = response.json()
                timeout = remaining if ack else min(remaining, launch_at - monotonic())
                if timeout <= 0:
                    continue
                try:
                    message = json.loads(websocket.recv(timeout=timeout))
                except TimeoutError:
                    continue
                kind = message["type"]
                counts[kind] += 1
                if kind == "seal" and message["valid"]:
                    valid_seals += 1
                if args.attack and kind == "incident":
                    logger.info("%s", json.dumps(message, ensure_ascii=True))
                    incident = message["incident"]
                    if ack and incident["attack_id"] == ack["attack_id"]:
                        attack_incident = incident
                if kind == "attack" and ack and message["attack"]["attack_id"] == ack["attack_id"]:
                    attack_ended = message["phase"] == "ended"
                if kind not in samples:
                    message.pop("jpeg_b64", None)
                    samples[kind] = message
                if attack_ended and attack_incident and attack_incident["status"] == "closed":
                    break
    except (OSError, WebSocketException, httpx.HTTPError, ValueError, KeyError) as error:
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
    if args.attack:
        if attack_incident is None:
            logger.error("%s: no linked incident received", args.attack)
            return 1
        closed = attack_incident["status"] == "closed"
        logger.info("%s: kind=%s detection_latency_ms=%s closed=%s", args.attack,
                    attack_incident["kind"], attack_incident["detection_latency_ms"],
                    "yes" if closed else "no")
        return 0 if attack_ended and closed and ack and attack_incident["kind"] == ack["expected_kind"] else 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
