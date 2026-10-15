#!/usr/bin/env python3
"""Read saved recreation artifacts without contacting the provider or submitting work."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

try:
    from scripts import entity_bindings
except ModuleNotFoundError:
    import entity_bindings


def existing_file(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    path = Path(value).expanduser().resolve()
    return str(path) if path.is_file() and path.stat().st_size > 0 else None


def summarize(manifest: dict[str, Any], manifest_path: Path | None = None) -> dict[str, Any]:
    final_record = manifest.get("finalVideo") or {}
    final_path = existing_file(final_record.get("file"))
    videos = manifest.get("videos") or []
    segments = []
    for item in videos:
        if not isinstance(item, dict):
            continue
        entry = {
            "segmentId": item.get("segmentId"),
            "status": item.get("status"),
            "taskId": item.get("taskId"),
            "file": existing_file(item.get("output_file")),
        }
        segments.append(entry)
    video_by_id = {int(item["segmentId"]): item for item in segments if item.get("segmentId") is not None}
    edited_ids = {int(item["storyboardId"]) for item in manifest.get("storyboards", {}).get("edited", [])}
    prompt_ids = {int(item["segmentId"]) for item in manifest.get("videoPrompts", {}).get("segments", [])}
    ready_actions = []
    waiting_dependencies = []
    windows = manifest.get("benchmarkVideo", {}).get("analysis", {}).get("recommendedSegments", [])
    for window in windows:
        segment_id = int(window["segmentId"])
        video = video_by_id.get(segment_id, {})
        if video.get("taskId") or video.get("file"):
            continue
        action = None
        if segment_id in prompt_ids:
            action = "dispatch_video"
        elif segment_id in edited_ids:
            action = "prepare_prompt_and_dispatch"
        elif manifest_path is not None:
            edited_dir = manifest_path.parent / "storyboards" / "edited"
            final_file = edited_dir / f"segment-{segment_id:02d}-final.png"
            report_file = edited_dir / f"segment-{segment_id:02d}-report.json"
            if existing_file(str(final_file)):
                action = "register_storyboard_and_dispatch"
            elif report_file.is_file():
                try:
                    report = json.loads(report_file.read_text(encoding="utf-8"))
                    if report.get("status") == "success":
                        action = "fast_prepare_and_dispatch"
                except (OSError, json.JSONDecodeError):
                    pass
            if action is None:
                original = manifest.get("storyboards", {}).get("original", [])
                registered = any(int(item.get("storyboardId", -1)) == segment_id for item in original)
                raw_dir = manifest_path.parent / "storyboards" / "original"
                metadata = raw_dir / f"segment-{segment_id:02d}-storyboard-metadata.json"
                if registered or metadata.is_file():
                    context = entity_bindings.segment_context(manifest, {"segmentId": segment_id})
                    needed = set(context["creatorIds"]) if context is not None else set()
                    if context is None:
                        for item in original:
                            if int(item.get("storyboardId", -1)) == segment_id:
                                needed.update(str(value) for anchor in item.get("anchors", [])
                                              for value in anchor.get("creatorIds", []))
                    creator = manifest.get("creator", {})
                    if creator.get("mode") == "ai_generated":
                        target_ids = set(creator.get("targetCreatorIds", []))
                        registered_ids = {str(item.get("creatorId")) for item in manifest.get("creators", [])}
                        missing = sorted((needed & target_ids) - registered_ids)
                        if missing:
                            waiting_dependencies.append({"segmentId": segment_id, "creatorIds": missing})
                        else:
                            action = "register_raw_and_prepare_image_edit"
                    else:
                        action = "register_raw_and_prepare_image_edit"
        if action:
            ready_actions.append({"segmentId": segment_id, "action": action})
    quality_path = existing_file(final_record.get("qualityReport"))
    quality = None
    if quality_path:
        try:
            report = json.loads(Path(quality_path).read_text(encoding="utf-8"))
            quality = {
                "file": quality_path,
                "technicalPassed": report.get("technicalPassed"),
                "semanticStatus": report.get("semanticStatus"),
                "deliveryBlocked": report.get("deliveryBlocked"),
            }
        except (OSError, json.JSONDecodeError):
            quality = {"file": quality_path, "readable": False}
    blueprint = manifest.get("videoBlueprint") or {}
    analysis_file = existing_file(blueprint.get("file"))
    analysis = {
        "status": blueprint.get("status"),
        "taskId": blueprint.get("taskId"),
        "file": analysis_file,
    }
    source = manifest.get("benchmarkVideo", {}).get("analysis", {})
    if source.get("sourceSha256") and source.get("sourceFile"):
        path = Path(str(source["sourceFile"])).expanduser().resolve()
        digest = hashlib.sha256()
        if path.is_file():
            with path.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
        analysis["cacheValid"] = path.is_file() and digest.hexdigest() == source["sourceSha256"]
    else:
        analysis["cacheValid"] = None
    if final_path:
        status = "video_ready"
    elif final_record.get("file"):
        status = "final_file_missing"
    elif any(item.get("status") in {"terminal_failed", "failed", "failure", "error", "cancelled", "timeout"} for item in segments):
        status = "segment_terminal_failed"
    elif any(item.get("taskId") and not item.get("file") for item in segments):
        status = "video_task_pending"
    elif segments and all(item.get("file") for item in segments):
        status = "segments_ready"
    elif analysis_file:
        status = "analysis_ready"
    elif analysis.get("taskId"):
        status = "analysis_task_pending"
    else:
        status = "initialized"
    return {
        "status": status,
        "deliverableReady": bool(final_path),
        "finalVideo": final_path,
        "analysis": analysis,
        "segments": segments,
        "readySegmentActions": ready_actions,
        "waitingDependencies": waiting_dependencies,
        "quality": quality,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--assert-no-ready-segments", action="store_true", help="Exit 2 when a completed Segment needs immediate handoff before waiting.")
    parser.add_argument("--assert-can-wait", action="store_true", help="Exit 2 for ready Segment handoff or 3 for terminal video failure.")
    args = parser.parse_args()
    try:
        manifest_path = Path(args.manifest).expanduser().resolve()
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if not isinstance(manifest, dict):
            raise ValueError("Manifest must be a JSON object.")
        result = summarize(manifest, manifest_path)
        print(json.dumps(result, ensure_ascii=False))
        if (args.assert_no_ready_segments or args.assert_can_wait) and result["readySegmentActions"]:
            return 2
        if args.assert_can_wait and result["status"] == "segment_terminal_failed":
            return 3
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        parser.exit(1, f"Cannot inspect saved task: {exc}\n")


if __name__ == "__main__":
    raise SystemExit(main())
