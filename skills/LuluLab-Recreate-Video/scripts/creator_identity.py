#!/usr/bin/env python3
"""Generate one reusable AI creator identity sheet with the existing LuluLab image CLI."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import time
from pathlib import Path
from typing import Any

try:
    from scripts import entity_bindings, generation_manifest, local_video_cli, lululab_image_generate, server_video_analysis
except ModuleNotFoundError:
    import entity_bindings  # type: ignore[no-redef]
    import generation_manifest  # type: ignore[no-redef]
    import local_video_cli  # type: ignore[no-redef]
    import lululab_image_generate  # type: ignore[no-redef]
    import server_video_analysis  # type: ignore[no-redef]


PROMPT_TEMPLATE_VERSION = "creator-2x2-v1"
VIEWS = ["close_up", "front", "side_profile", "back"]


def creator_profile(manifest: dict[str, Any]) -> dict[str, str]:
    selected = manifest.get("creator", {})
    country = str(selected.get("targetCountry") or manifest.get("userConfig", {}).get("targetCountry") or "source market")
    if country == "跟原视频一致":
        country = "the source video's target market"
    return {
        "targetCountry": country,
        "gender": str(selected.get("gender") or "appropriate to the source character's role"),
        "ageRange": str(selected.get("ageRange") or "appropriate to the source character's role"),
        "appearanceStyle": str(selected.get("appearanceStyle") or "natural everyday UGC creator"),
        "clothingStyle": str(selected.get("clothingStyle") or "appropriate to the product and source role"),
        "vibe": str(selected.get("vibe") or "authentic, friendly, trustworthy"),
        "otherRequirements": str(selected.get("otherRequirements") or "none"),
    }


def build_prompt(profile: dict[str, str], role: str) -> str:
    return (
        "Create exactly ONE photorealistic square 2x2 identity reference sheet for an original "
        "short-form ecommerce UGC creator. The role in the source video is: " + role + "\n"
        "Target market: " + profile["targetCountry"] + "\n"
        "Gender: " + profile["gender"] + "; age range: " + profile["ageRange"] + "\n"
        "Appearance: " + profile["appearanceStyle"] + "; clothing: " + profile["clothingStyle"] + "\n"
        "Vibe: " + profile["vibe"] + "; additional requirements: " + profile["otherRequirements"] + "\n"
        "Exactly four equal panels of the SAME person: top-left close-up portrait with natural eyes, "
        "skin texture, pores and subtle imperfections; top-right full-body front view with natural "
        "proportions; bottom-left side profile showing face, hair and silhouette; bottom-right "
        "full-body back view. Keep face, hairstyle, skin tone, clothing, body and identity consistent "
        "in every panel. Everyday smartphone photography, unretouched appearance, soft natural "
        "light, clean neutral background. Adapt styling to the specified role and requirements. "
        "No product, prop, text, caption, logo, watermark, beauty filter, airbrushing, CGI, "
        "fashion editorial styling, glamour lighting or excessive sharpening."
    )


def role_from_blueprint(manifest: dict[str, Any], creator_id: str) -> str:
    blueprint = entity_bindings.load_blueprint(manifest)
    if blueprint is None:
        return "primary on-camera commerce presenter"
    bindings = entity_bindings.validate_bindings(manifest, blueprint)
    sources = {str(item["sourceId"]) for item in bindings
               if item["entityType"] == "character" and item["targetId"] == creator_id}
    people = [item for item in blueprint["视频元素"]["人物"] if item["characterId"] in sources]
    if not people:
        raise ValueError("AI 达人目标没有对应的 Blueprint 来源人物。")
    role_keys = ("role", "角色", "角色功能", "身份", "职业", "人物定位", "function")
    roles = [str(item[key]).strip() for item in people for key in role_keys
             if isinstance(item.get(key), str) and str(item[key]).strip()]
    return "; ".join(roles) if roles else "primary on-camera commerce presenter"


def inspect_sheet(path: Path) -> dict[str, Any]:
    if not path.is_file() or path.stat().st_size == 0:
        raise ValueError("AI 达人身份图不存在或为空。")
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
             "-of", "json", str(path)], capture_output=True, text=True, timeout=20, check=True,
        )
        stream = json.loads(result.stdout)["streams"][0]
        width, height = int(stream["width"]), int(stream["height"])
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, IndexError, TypeError) as exc:
        raise ValueError("无法读取 AI 达人身份图的画布尺寸。") from exc
    if min(width, height) < 768 or abs(width - height) > .1 * max(width, height):
        raise ValueError("AI 达人身份图须为至少 768×768 的方形四宫格画布。")
    return {"width": width, "height": height, "panelWidth": width // 2,
            "panelHeight": height // 2, "semanticReviewRequired": True}


def _record(path: Path, creator_id: str, value: dict[str, Any]) -> None:
    def mutate(data: dict[str, Any]) -> None:
        data.setdefault("creatorGeneration", {})[creator_id] = value
        if value.get("status") == "ready_for_review" and isinstance(value.get("durationSeconds"), (int, float)):
            data.setdefault("stageDurations", {})["creatorGenerationDuration"] = value["durationSeconds"]
    generation_manifest.update(path, mutate)


def run(manifest_path: Path, creator_id: str, role: str | None = None, *, register_reviewed: bool = False) -> dict[str, Any]:
    manifest_path = manifest_path.expanduser().resolve()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,79}", creator_id):
        raise ValueError("creatorId 只能包含字母、数字、下划线或连字符。")
    lock_path = manifest_path.parent / "creators" / f"{creator_id}.generation.lock"
    lock = server_video_analysis.acquire_run_lock(lock_path, lock_path=lock_path)
    try:
        data = generation_manifest.load_manifest(manifest_path)
        creator = data.get("creator", {})
        if not isinstance(creator, dict) or creator.get("mode") != "ai_generated":
            raise ValueError("当前任务未选择 AI 自动生成达人；不得提交图片任务。")
        if creator_id not in creator.get("targetCreatorIds", []):
            raise ValueError("creatorId 未登记为本任务需要替换的 AI 达人。")
        saved = data.get("creatorGeneration", {}).get(creator_id, {})
        role = role or saved.get("input", {}).get("role") or role_from_blueprint(data, creator_id)
        profile = creator_profile(data)
        prompt = build_prompt(profile, role)
        identity = {"creatorId": creator_id, "profile": profile, "role": role,
                    "model": local_video_cli.LULULAB_IMAGE_MODEL_ID,
                    "templateVersion": PROMPT_TEMPLATE_VERSION, "aspectRatio": "1:1", "resolution": "1K"}
        fingerprint = hashlib.sha256(json.dumps(identity, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
        output = manifest_path.parent / "creators" / f"{creator_id}-identity-2x2.png"
        report = manifest_path.parent / "creators" / f"{creator_id}-identity-task.json"
        if saved and saved.get("inputFingerprint") != fingerprint:
            raise ValueError("达人设定或模板已变化；现有图片任务不得自动重提。需要明确授权新候选。")
        if saved.get("status") == "structural_failed":
            raise ValueError("现有身份板未通过结构检查；未经重新授权不得再次生成。")
        if report.is_file():
            previous = json.loads(report.read_text(encoding="utf-8"))
            if not isinstance(previous, dict):
                raise ValueError("图片任务报告格式无效。")
            task_id = str(previous.get("taskId") or "")
            status = str(previous.get("status") or "")
            if not saved:
                raise ValueError("已有图片任务报告但无对应配置指纹；禁止重复提交。")
            if status in {"submit_pending", "submit_outcome_unknown"} and not task_id:
                raise ValueError("图片提交结果不确定且无 taskId；禁止自动重复付费提交。")
            if status in {"terminal_failed", "invalid_input"}:
                raise ValueError("现有达人图片任务已失败；未经重新授权不得再次提交。")
            if status == "success" and output.is_file() and saved.get("sha256") == generation_manifest.file_sha256(output):
                if register_reviewed and saved.get("status") == "ready_for_review":
                    generation_manifest.add_creator(manifest_path, str(output), creator_id, "ai_generated",
                                                    VIEWS, product_free_verified=True)
                    saved["status"] = "ready"
                    saved["visualReview"] = "agent_confirmed_four_views_and_product_free"
                    _record(manifest_path, creator_id, saved)
                return saved
            if status == "success" and output.is_file() and saved.get("sha256") and saved.get("sha256") != generation_manifest.file_sha256(output):
                raise ValueError("已保存的达人身份图 SHA256 不匹配；不能复用。")
            if register_reviewed:
                raise ValueError("达人身份图尚未可用，不能登记视觉检查。")
        elif register_reviewed:
            raise ValueError("尚无 AI 达人生成任务。")
        elif saved:
            raise ValueError("达人图片任务已有提交记录但报告缺失；禁止自动重复付费提交。")
        else:
            _record(manifest_path, creator_id, {"status": "submit_pending", "inputFingerprint": fingerprint,
                                               "input": identity, "taskId": "", "file": str(output),
                                               "report": str(report)})
            task_id = ""
        started = time.monotonic()
        code, result = lululab_image_generate.execute(argparse.Namespace(
            prompt=prompt, prompt_file=None, reference_image=[], aspect_ratio="1:1",
            output=str(output), report=str(report), resume_task_id=task_id or None,
        ))
        record = {"status": result.get("status"), "inputFingerprint": fingerprint, "input": identity,
                  "taskId": result.get("taskId", ""), "file": str(output), "report": str(report),
                  "durationSeconds": round(time.monotonic() - started, 3)}
        if code == 0:
            try:
                record["structure"] = inspect_sheet(output)
                record["sha256"] = generation_manifest.file_sha256(output)
                record["status"] = "ready_for_review"
            except ValueError as exc:
                record["status"] = "structural_failed"
                record["message"] = str(exc)
        _record(manifest_path, creator_id, record)
        return record
    finally:
        server_video_analysis.release_run_lock(lock)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--creator-id", required=True)
    parser.add_argument("--role", help="Optional role override; otherwise read the selected source character from Blueprint.")
    parser.add_argument("--register-reviewed", action="store_true",
                        help="Use only after checking four views show one person and contain no product.")
    args = parser.parse_args()
    try:
        result = run(args.manifest, args.creator_id, args.role, register_reviewed=args.register_reviewed)
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result.get("status") in {"ready", "ready_for_review"} else 2
    except (OSError, ValueError, json.JSONDecodeError, server_video_analysis.AnalysisError) as exc:
        print(json.dumps({"status": "blocked", "message": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
