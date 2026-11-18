"""Exercise FrameSeal against an already running backend."""

import argparse
import json
import logging
import sys
from collections.abc import Callable
from hashlib import file_digest
from tempfile import TemporaryFile
from time import monotonic, sleep
from urllib.parse import urlsplit, urlunsplit

import httpx
from websockets.exceptions import WebSocketException
from websockets.sync.client import connect

logger = logging.getLogger(__name__)
ATTACKS = (
    ("LOOP_REPLAY", "REPLAY_DETECTED"),
    ("PIXEL_TAMPER", "FRAME_MODIFIED"),
    ("FRAME_DROP", "FRAME_DELETED"),
    ("FRAME_INSERT", "FRAME_INSERTED"),
    ("FRAME_REORDER", "FRAME_REORDERED"),
    ("CHAIN_FORGE", "CHAIN_FORGED"),
    ("STREAM_CUT", "STREAM_INTERRUPTED"),
)
SAMPLES = (("modify", "TAMPERED"), ("delete", "TAMPERED"), ("truncate", "INCOMPLETE"))


class SmokeFailure(ValueError):
    """A live response did not match the expected behavior."""


def require(condition: bool, detail: str) -> None:
    """Make a check fail with a readable message."""
    if not condition:
        raise SmokeFailure(detail)


class SmokeTest:
    """Track the session and exercise the public API as a client."""

    def __init__(self, client: httpx.Client) -> None:
        """Keep the REST client and the session ID set by start()."""
        self.client = client
        self.session_id: str | None = None

    def start(self) -> str:
        """Start a synthetic recording."""
        session = self.client.post("/api/session/start", json={"source": "synthetic"}).raise_for_status().json()
        self.session_id = session["session_id"]
        require(session["status"] == "running" and session["source"] == "synthetic", str(session))
        return "synthetic session running"

    def websocket(self) -> str:
        """Verify the live WebSocket identifies the same session and attack catalog."""
        base = urlsplit(str(self.client.base_url))
        scheme = "wss" if base.scheme == "https" else "ws"
        url = urlunsplit((scheme, base.netloc, "/ws/live", "", ""))
        with connect(url, open_timeout=5, close_timeout=1, proxy=None) as socket:
            hello = json.loads(socket.recv(timeout=5))
        require(hello["type"] == "hello" and hello["session"]["session_id"] == self.session_id,
                "WebSocket did not identify the current session")
        expected_catalog = dict(ATTACKS)
        catalog = {attack["type"]: attack["expected_kind"] for attack in hello["catalog"]}
        require(catalog == expected_catalog, f"Unexpected attack catalog: {catalog}")
        return "hello and all seven catalog entries"

    def attack(self, kind: str, expected: str) -> str:
        """Trigger one attack and wait at most ten seconds for its incident to close."""
        deadline = monotonic() + 10
        ack = self.client.post(
            "/api/attacks", json={"type": kind, "params": {}}, timeout=10,
        ).raise_for_status().json()
        require(ack["expected_kind"] == expected, f"ACK expected {ack['expected_kind']}")
        attack_id = ack["attack_id"]
        while (remaining := deadline - monotonic()) > 0:
            incidents = self.client.get("/api/incidents", timeout=min(remaining, 2)).raise_for_status().json()
            linked = [incident for incident in incidents if incident["attack_id"] == attack_id]
            require(len(linked) <= 1, f"{attack_id} opened more than one incident")
            if linked and linked[0]["status"] == "closed":
                incident = linked[0]
                require(incident["kind"] == expected, f"Expected {expected}, got {incident['kind']}")
                require(incident["attack_type"] == kind, f"Incident linked to {incident['attack_type']}")
                return f"{incident['kind']}, closed"
            sleep(min(0.15, max(0, deadline - monotonic())))
        raise SmokeFailure(f"No linked incident closed within 10 s for {attack_id}")

    def stop(self) -> str:
        """Stop and confirm that a second stop returns the same sealed session."""
        stopped = self.client.post("/api/session/stop").raise_for_status().json()
        require(stopped["status"] == "stopped" and stopped["session_id"] == self.session_id
                and stopped["seal"] is not None, "Missing seal for the smoke-test session")
        again = self.client.post("/api/session/stop").raise_for_status().json()
        require(again == stopped, "A repeated stop changed the session")
        return f"{stopped['seal']['frame_count']} frames sealed, repeat stop safe"

    def evidence(self, expected: str, mode: str | None = None) -> str:
        """Download a freshly generated package and verify it via multipart upload."""
        if mode is None:
            response = self.client.post("/api/evidence/export")
        else:
            response = self.client.post("/api/evidence/tamper-sample", json={"mode": mode})
        package = response.raise_for_status().json()
        with TemporaryFile() as archive:
            with self.client.stream("GET", package["download_url"]) as download:
                for chunk in download.raise_for_status().iter_bytes():
                    archive.write(chunk)
            archive.seek(0)
            require(file_digest(archive, "sha256").hexdigest() == package["package_sha256"],
                    "Downloaded ZIP hash differed from the export result")
            archive.seek(0)
            verification = self.client.post(
                "/api/evidence/verify", files={"file": (package["filename"], archive, "application/zip")},
            )
        report = verification.raise_for_status().json()
        require(report["verdict"] == expected, f"Expected {expected}, got {report['verdict']}")
        require(report["session_id"] == self.session_id and report["package_sha256"] == package["package_sha256"],
                "Report identified a different session or ZIP")
        return (f"{report['verdict']}, ok={report['frames_ok']}, tampered={report['frames_tampered']}, "
                f"missing={report['frames_missing']}")


def run(client: httpx.Client) -> int:
    """Execute the flow, collect every result, and render the summary."""
    smoke = SmokeTest(client)
    rows: list[tuple[str, str, str]] = []

    def check(label: str, action: Callable[..., str], *args: str) -> bool:
        """Record a stage's outcome and allow independent stages to continue."""
        try:
            rows.append((label, "PASS", action(*args)))
        except (httpx.HTTPError, WebSocketException, OSError, ValueError, KeyError, TypeError) as error:
            rows.append((label, "FAIL", str(error)))
            return False
        return True

    if check("Start session", smoke.start):
        try:
            check("Live WebSocket", smoke.websocket)
            sleep(3)
            for kind, expected in ATTACKS:
                check(kind, smoke.attack, kind, expected)
        finally:
            stopped = check("Stop session", smoke.stop)
        if stopped and check("Export and verify", smoke.evidence, "AUTHENTIC"):
            for mode, expected in SAMPLES:
                check(f"{mode.capitalize()} and verify", smoke.evidence, expected, mode)
    elif smoke.session_id is not None:
        check("Stop session", smoke.stop)

    logger.info("%-20s  %-6s  %s", "CHECK", "RESULT", "DETAIL")
    for label, status, detail in rows:
        logger.info("%-20s  %-6s  %s", label, status, detail)
    return int(any(status == "FAIL" for _, status, _ in rows))


def main() -> int:
    """Parse the backend URL and run the smoke test."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8000")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stdout)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    with httpx.Client(base_url=args.url, timeout=30, trust_env=False) as client:
        return run(client)


if __name__ == "__main__":
    raise SystemExit(main())
