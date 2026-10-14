from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from scripts import creator_identity, entity_bindings, generation_manifest, local_video_cli, reference_audit, run_generation


class AiCreatorIdentityTests(unittest.TestCase):
    def manifest(self, root: Path) -> Path:
        manifest = generation_manifest.command_init(type("Args", (), {
            "output_root": str(root), "task_id": "task", "reuse": False,
            "target_country": "Portugal"})())
        generation_manifest.set_creator_mode(manifest, "ai_generated", ["creator-main"])
        return manifest

    @staticmethod
    def mock_download(_media, path):
        Image.new("RGB", (1024, 1024), "#c2a57c").save(path)
        return path

    def test_new_task_defaults_and_legacy_manifest_is_unchanged(self):
        with tempfile.TemporaryDirectory() as td:
            manifest = self.manifest(Path(td))
            data = generation_manifest.load_manifest(manifest)
            self.assertEqual(data["creator"]["mode"], "ai_generated")
            self.assertEqual(data["creator"]["targetCreatorIds"], ["creator-main"])
            del data["creator"]
            generation_manifest.save_manifest(manifest, data)
            self.assertNotIn("creator", generation_manifest.load_manifest(manifest))

    def test_role_comes_from_selected_blueprint_character_without_extra_analysis(self):
        blueprint = {"视频元素": {"人物": [{"characterId": "c1", "role": "presenter"},
                                             {"characterId": "c2", "role": "passerby"}]}}
        bindings = [{"entityType": "character", "sourceId": "c1", "targetId": "creator-main"}]
        with patch.object(entity_bindings, "load_blueprint", return_value=blueprint), \
             patch.object(entity_bindings, "validate_bindings", return_value=bindings):
            role = creator_identity.role_from_blueprint({}, "creator-main")
        self.assertIn("presenter", role)
        self.assertNotIn("passerby", role)

    def test_explicit_keep_source_does_not_force_background_identity_sheets(self):
        with tempfile.TemporaryDirectory() as td:
            manifest = self.manifest(Path(td))
            generation_manifest.set_creator_mode(manifest, "keep_source")
            data = generation_manifest.load_manifest(manifest)
            self.assertEqual(data["creator"]["targetCreatorIds"], [])
            data["videoPrompts"]["segments"] = [{"segmentId": 1, "creatorIds": ["background"]},
                                                  {"segmentId": 2, "creatorIds": ["background"]}]
            reference_audit.validate_creator_references(data, {"background"})

    def test_ai_audit_only_requires_selected_identity_in_each_segment(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            first = root / "first.png"; first.write_bytes(b"first")
            second = root / "second.png"; second.write_bytes(b"second")
            board = root / "board.png"; board.write_bytes(b"board")
            data = {"skillVersion": "1.3.0", "creator": {"mode": "ai_generated",
                    "targetCreatorIds": ["first", "second"]}, "creators": [
                    {"creatorId": "first", "sourceType": "ai_generated", "file": str(first)},
                    {"creatorId": "second", "sourceType": "ai_generated", "file": str(second)}],
                    "product": {"productImages": []}}
            reference_audit.audit_submission_files(data, [str(board), str(first)], segment_id=1,
                                                  selected_creator_ids={"first"})
            with self.assertRaisesRegex(ValueError, "AI 身份板"):
                reference_audit.audit_submission_files(data, [str(board)], segment_id=1,
                                                      selected_creator_ids={"first"})

    def test_storyboard_edit_must_include_same_ai_identity_image(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            identity = root / "identity.png"; identity.write_bytes(b"identity")
            candidate = root / "candidate.png"; candidate.write_bytes(b"candidate")
            report = root / "edit-report.json"
            data = {"creator": {"mode": "ai_generated", "targetCreatorIds": ["creator-main"]},
                    "creators": [{"creatorId": "creator-main", "file": str(identity), "sourceType": "ai_generated"}]}
            board = {"replacementVerified": True, "replacement": {"imageTaskReport": str(report),
                                                               "editedImageFile": str(candidate)}}
            report.write_text(json.dumps({"status": "success", "provider": "lululab_cli",
                                          "output": str(candidate), "referenceSha256": []}))
            with self.assertRaisesRegex(ValueError, "未使用目标身份图"):
                reference_audit.validate_ai_storyboard_input(data, board, {"creator-main"})
            report.write_text(json.dumps({"status": "success", "provider": "lululab_cli",
                                          "output": str(candidate),
                                          "referenceSha256": [generation_manifest.file_sha256(identity)]}))
            reference_audit.validate_ai_storyboard_input(data, board, {"creator-main"})

    def test_one_mock_cli_task_then_review_and_multisegment_reuse(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); manifest = self.manifest(root)
            calls = []
            def cli(args, **_kwargs):
                calls.append(args)
                return {"id": "image-task-1"}
            with patch.object(local_video_cli, "run_lululab_cli", side_effect=cli), \
                 patch.object(local_video_cli, "poll_task", return_value={"output": {"image": {"url": "https://example.com/result.png"}}}), \
                 patch.object(local_video_cli, "download_media", side_effect=self.mock_download):
                first = creator_identity.run(manifest, "creator-main", "primary presenter")
            self.assertEqual(first["status"], "ready_for_review")
            self.assertEqual(first["taskId"], "image-task-1")
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0][:4], ["task", "submit", "--workflow-id", "ImageGenV2"])
            payload = json.loads(calls[0][-1])
            self.assertEqual((payload["model"], payload["resolution"], payload["aspectRatio"]),
                             ("gpt-image-2-5-sunburst", "1K", "1:1"))
            self.assertIn("Portugal", payload["prompt"])
            self.assertIn("top-left close-up", payload["prompt"])
            with self.assertRaisesRegex(ValueError, "缺少已验证"):
                reference_audit.validate_creator_references(
                    generation_manifest.load_manifest(manifest), {"creator-main"})
            with patch.object(local_video_cli, "run_lululab_cli", side_effect=AssertionError("no second paid task")):
                ready = creator_identity.run(manifest, "creator-main", "primary presenter", register_reviewed=True)
                self.assertEqual(ready["status"], "ready")
                self.assertEqual(creator_identity.run(manifest, "creator-main", "primary presenter")["sha256"], ready["sha256"])
            data = generation_manifest.load_manifest(manifest)
            self.assertEqual(data["creators"][0]["sourceType"], "ai_generated")
            self.assertEqual(data["creators"][0]["views"], ["back", "close_up", "front", "side_profile"])
            board = root / "board.png"; board.write_bytes(b"board")
            product = root / "product.png"; product.write_bytes(b"product")
            data["product"]["productImages"] = [{"file": str(product)}]
            data["storyboards"]["generation"] = [{"storyboardId": i, "file": str(board)} for i in (1, 2)]
            for segment_id in (1, 2):
                files = run_generation.prepare_references(data, {"segmentId": segment_id,
                    "storyboardIds": [segment_id], "creatorIds": ["creator-main"]}, root, "seedance-2-mini")
                self.assertEqual(files, [str(board), str(product), ready["file"]])
                reference_audit.audit_submission_files(data, files, segment_id=segment_id)
                with self.assertRaisesRegex(ValueError, "缺少用户上传"):
                    reference_audit.audit_submission_files(data, files[:-1], segment_id=segment_id)

    def test_resume_original_image_task_without_second_submit(self):
        with tempfile.TemporaryDirectory() as td:
            manifest = self.manifest(Path(td))
            with patch.object(local_video_cli, "submit_lululab_image", return_value="task-resume") as submit, \
                 patch.object(local_video_cli, "poll_task", side_effect=local_video_cli.LocalVideoCliError("timeout")):
                first = creator_identity.run(manifest, "creator-main", "presenter")
            self.assertEqual(first["status"], "poll_unknown")
            self.assertEqual(submit.call_count, 1)
            with patch.object(local_video_cli, "submit_lululab_image", side_effect=AssertionError("duplicate submit")), \
                 patch.object(local_video_cli, "poll_task", return_value={"output": {"image": {"url": "https://example.com/result.png"}}}), \
                 patch.object(local_video_cli, "download_media", side_effect=self.mock_download):
                recovered = creator_identity.run(manifest, "creator-main", "presenter")
            self.assertEqual(recovered["taskId"], "task-resume")
            self.assertEqual(recovered["status"], "ready_for_review")

    def test_unknown_submission_and_other_modes_never_generate(self):
        with tempfile.TemporaryDirectory() as td:
            manifest = self.manifest(Path(td))
            with patch.object(local_video_cli, "submit_lululab_image", side_effect=local_video_cli.LocalVideoCliError("connection lost")):
                result = creator_identity.run(manifest, "creator-main", "presenter")
            self.assertEqual(result["status"], "submit_outcome_unknown")
            with patch.object(local_video_cli, "submit_lululab_image", side_effect=AssertionError("duplicate submit")):
                with self.assertRaisesRegex(ValueError, "禁止自动重复"):
                    creator_identity.run(manifest, "creator-main", "presenter")
            generation_manifest.set_creator_mode(manifest, "keep_source")
            with self.assertRaisesRegex(ValueError, "未选择 AI"):
                creator_identity.run(manifest, "creator-main", "presenter")

    def test_missing_task_report_never_triggers_another_paid_submit(self):
        with tempfile.TemporaryDirectory() as td:
            manifest = self.manifest(Path(td))
            with patch.object(local_video_cli, "submit_lululab_image", side_effect=local_video_cli.LocalVideoCliError("connection lost")):
                creator_identity.run(manifest, "creator-main", "presenter")
            report = manifest.parent / "creators" / "creator-main-identity-task.json"
            report.unlink()
            with patch.object(local_video_cli, "submit_lululab_image", side_effect=AssertionError("duplicate submit")):
                with self.assertRaisesRegex(ValueError, "报告缺失"):
                    creator_identity.run(manifest, "creator-main", "presenter")
            generation_manifest.set_creator_mode(manifest, "user_provided")
            with self.assertRaisesRegex(ValueError, "未选择 AI"):
                creator_identity.run(manifest, "creator-main", "presenter")

    def test_failed_structure_and_changed_profile_do_not_resubmit(self):
        with tempfile.TemporaryDirectory() as td:
            manifest = self.manifest(Path(td))
            with patch.object(local_video_cli, "submit_lululab_image", return_value="task-1"), \
                 patch.object(local_video_cli, "poll_task", return_value={"output": {"image": {"url": "https://example.com/result.png"}}}), \
                 patch.object(local_video_cli, "download_media", side_effect=self.mock_download), \
                 patch.object(creator_identity, "inspect_sheet", side_effect=ValueError("bad grid")):
                result = creator_identity.run(manifest, "creator-main", "presenter")
            self.assertEqual(result["status"], "structural_failed")
            generation_manifest.set_creator_mode(manifest, "ai_generated", ["creator-main"], {"vibe": "professional"})
            with self.assertRaisesRegex(ValueError, "设定或模板已变化"):
                creator_identity.run(manifest, "creator-main", "presenter")


if __name__ == "__main__":
    unittest.main()
