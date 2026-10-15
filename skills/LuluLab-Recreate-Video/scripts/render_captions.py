#!/usr/bin/env python3
"""Render an editable ASS subtitle layer onto a clean video without regenerating it."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path


def render(input_video: Path, ass_file: Path, output_video: Path, ffmpeg: str) -> None:
    input_video = input_video.expanduser().resolve()
    ass_file = ass_file.expanduser().resolve()
    output_video = output_video.expanduser().resolve()
    if not input_video.is_file() or input_video.stat().st_size == 0:
        raise ValueError(f"Clean video is missing or empty: {input_video}")
    if not ass_file.is_file() or ass_file.stat().st_size == 0:
        raise ValueError(f"ASS file is missing or empty: {ass_file}")
    if ass_file.suffix.lower() != ".ass":
        raise ValueError("Subtitle source must be an .ass file")
    if output_video == input_video:
        raise ValueError("Captioned output must not overwrite the clean video")
    if output_video.suffix.lower() != ".mp4":
        raise ValueError("Captioned output must use .mp4")
    executable = shutil.which(ffmpeg) or (ffmpeg if Path(ffmpeg).is_file() else None)
    if not executable:
        raise ValueError(f"FFmpeg is unavailable: {ffmpeg}")

    output_video.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="caption-assets-") as asset_dir:
        assets = Path(asset_dir)
        # Simple local names keep arbitrary input paths out of FFmpeg filter syntax.
        (assets / "input.mp4").symlink_to(input_video)
        shutil.copyfile(ass_file, assets / "captions.ass")
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{output_video.stem}-", suffix=".mp4", dir=output_video.parent
        )
        os.close(descriptor)
        temporary = Path(temporary_name)
        temporary.unlink()
        try:
            command = [
                executable, "-hide_banner", "-loglevel", "error", "-y",
                "-i", "input.mp4", "-map", "0:v:0", "-map", "0:a?",
                "-vf", "ass=captions.ass", "-c:v", "libx264", "-crf", "18",
                "-preset", "medium", "-pix_fmt", "yuv420p", "-c:a", "copy",
                "-movflags", "+faststart", str(temporary),
            ]
            result = subprocess.run(command, cwd=assets, text=True, capture_output=True, check=False)
            if result.returncode != 0:
                raise RuntimeError(f"Subtitle rendering failed: {result.stderr[-1200:]}")
            if not temporary.is_file() or temporary.stat().st_size == 0:
                raise RuntimeError("FFmpeg produced no captioned video")
            temporary.replace(output_video)
        finally:
            if temporary.exists():
                temporary.unlink()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path, help="Uncaptioned final video")
    parser.add_argument("--ass", required=True, type=Path, help="Editable ASS subtitle source")
    parser.add_argument("--output", required=True, type=Path, help="Captioned MP4 output")
    parser.add_argument("--ffmpeg", default="ffmpeg")
    args = parser.parse_args()
    try:
        render(args.input, args.ass, args.output, args.ffmpeg)
    except (OSError, ValueError, RuntimeError) as exc:
        parser.exit(1, f"{exc}\n")
    print(json.dumps({"ok": True, "output": str(args.output.expanduser().resolve())}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
