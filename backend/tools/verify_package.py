"""Standalone offline evidence package verifier."""

import argparse
import logging
import os
import sys
from pathlib import Path

# Running a file directly places tools/, not backend/, on the import path.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.package_verifier import InvalidPackage, verify_package

logger = logging.getLogger(__name__)
_VERDICTS = {"AUTHENTIC": (0, 32), "TAMPERED": (1, 31), "INCOMPLETE": (2, 33)}


def main() -> int:
    """Print the verdict and frame summary for a single archive."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package", type=Path, help="Path to the evidence ZIP")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stdout)
    try:
        with args.package.open("rb") as stream:
            result = verify_package(stream, args.package.name)
    except (OSError, InvalidPackage) as error:
        logger.error("Invalid package: %s", error)
        return 2

    report = result.report
    code, color = _VERDICTS[report.verdict]
    verdict = report.verdict
    if sys.stdout.isatty() and "NO_COLOR" not in os.environ:
        verdict = f"\x1b[{color}m{verdict}\x1b[0m"
    bad_frames = ", ".join(f"#{seq}" for seq in result.first_bad_frames) or "none"
    logger.info(
        "%s | frames ok=%d tampered=%d missing=%d | first bad frames=%s",
        verdict, report.frames_ok, report.frames_tampered, report.frames_missing, bad_frames,
    )
    return code


if __name__ == "__main__":
    raise SystemExit(main())
