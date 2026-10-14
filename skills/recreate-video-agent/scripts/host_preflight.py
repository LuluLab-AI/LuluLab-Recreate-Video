#!/usr/bin/env python3
"""Check the host capabilities required by this file-based Skill."""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


SKILL_ROOT = Path(__file__).resolve().parent.parent


def inspect(root: Path = SKILL_ROOT) -> dict:
    checks = {"python": sys.version_info >= (3, 9),
              "node": False, "ffmpeg": bool(shutil.which("ffmpeg")),
              "ffprobe": bool(shutil.which("ffprobe")), "fileReadWrite": False,
              "cliExecution": False}
    node = os.environ.get("LULULAB_NODE", "").strip() or shutil.which("node")
    if node:
        try:
            version = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=10, check=True).stdout.strip()
            checks["node"] = int(version.lstrip("v").split(".", 1)[0]) >= 20
            if checks["node"]:
                result = subprocess.run([node, str(root / "scripts" / "lululab_cli.mjs"), "--help"],
                                        capture_output=True, text=True, timeout=15, check=False)
                checks["cliExecution"] = result.returncode == 0
        except (OSError, ValueError, subprocess.TimeoutExpired, subprocess.CalledProcessError):
            pass
    try:
        with tempfile.TemporaryDirectory() as directory:
            sample = Path(directory) / "probe"
            sample.write_text("ok", encoding="utf-8")
            checks["fileReadWrite"] = sample.read_text(encoding="utf-8") == "ok"
    except OSError:
        pass
    missing = [name for name, valid in checks.items() if not valid]
    return {"ok": not missing, "checks": checks, "missing": missing,
            "reason": "缺少必要宿主能力：" + ", ".join(missing) if missing else ""}


def main() -> int:
    argparse.ArgumentParser(description=__doc__).parse_args()
    result = inspect()
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
