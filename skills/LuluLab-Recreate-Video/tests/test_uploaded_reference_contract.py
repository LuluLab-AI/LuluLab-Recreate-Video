from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from scripts import generation_manifest, host_preflight, local_video_cli, prepare_prompt_handoff, reference_audit, run_generation, task_status


class UploadedReferenceContractTests(unittest.TestCase):
    def fixture(self, root: Path, *, segments: int = 1):
        board = root / "board.png"; board.write_bytes(b"board")
        product = root / "product.png"; product.write_bytes(b"product")
        creator = root / "creator.png"; creator.write_bytes(b"creator")
        data = {"skillVersion": "1.2.0",
                "product": {"useBenchmarkProduct": True, "productImages": [{"file": str(product), "sourceType": "user_provided"}],
                            "referenceIntent": "preserve_original_identity"},
                "creators": [{"creatorId": "person-a", "file": str(creator), "sourceType": "user_provided"}],
                "storyboards": {"generation": [{"storyboardId": i, "file": str(board),
                                                "anchors": [{"productPresent": True}]} for i in range(1, segments + 1)]}}
        return data, product, creator

    def test_preserve_product_and_creator_uploads_reach_every_segment(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); data, product, creator = self.fixture(root, segments=2)
            for segment_id in (1, 2):
                segment = {"segmentId": segment_id, "storyboardIds": [segment_id], "creatorIds": []}
                files = run_generation.prepare_references(data, segment, root, "seedance-2-mini")
                self.assertEqual(files, [str(root / "board.png"), str(product), str(creator)])
                self.assertEqual(reference_audit.audit_submission_files(data, files, segment_id=segment_id)["creatorImages"], [str(creator)])

    def test_preserve_product_upload_without_creator(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); data, product, _ = self.fixture(root)
            data["creators"] = []
            files = run_generation.prepare_references(data, {"segmentId": 1, "storyboardIds": [1], "creatorIds": []}, root, "seedance-2-mini")
            self.assertEqual(files, [str(root / "board.png"), str(product)])

    def test_preserve_creator_upload_without_product(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); data, _, creator = self.fixture(root)
            data["product"]["productImages"] = []
            files = run_generation.prepare_references(data, {"segmentId": 1, "storyboardIds": [1], "creatorIds": []}, root, "seedance-2-mini")
            self.assertEqual(files, [str(root / "board.png"), str(creator)])

    def test_replacement_and_duplicate_content_keep_each_distinct_image(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); data, product, creator = self.fixture(root)
            data["product"].update(useBenchmarkProduct=False, mode="replacement")
            duplicate = root / "duplicate.png"; duplicate.write_bytes(product.read_bytes())
            data["product"]["productImages"].append({"file": str(duplicate)})
            files = run_generation.prepare_references(data, {"segmentId": 1, "storyboardIds": [1], "creatorIds": ["person-a"]}, root, "seedance-2-mini")
            self.assertEqual(files, [str(root / "board.png"), str(product), str(creator)])

    def test_missing_upload_and_semantic_conflict_block(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); data, product, creator = self.fixture(root)
            with self.assertRaisesRegex(ValueError, "缺少用户上传"):
                reference_audit.audit_submission_files(data, [str(root / "board.png")], segment_id=1)
            del data["product"]["referenceIntent"]
            with self.assertRaisesRegex(ValueError, "存在冲突"):
                reference_audit.audit_submission_files(data, [str(root / "board.png"), str(product), str(creator)], segment_id=1)
            data["product"]["referenceIntent"] = "preserve_original_identity"
            data["replacementBindings"] = [{"entityType": "character", "sourceId": "person-a",
                                             "targetId": "person-a", "mode": "preserve"}]
            with self.assertRaisesRegex(ValueError, "达人图.*存在冲突"):
                reference_audit.audit_submission_files(data, [str(root / "board.png"), str(product), str(creator)], segment_id=1)
            data["creators"][0]["referenceIntent"] = "preserve_original_identity"
            reference_audit.audit_submission_files(data, [str(root / "board.png"), str(product), str(creator)], segment_id=1)

    def test_model_limit_fails_without_silent_drop(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); data, _, _ = self.fixture(root)
            for index in range(9):
                image = root / f"person-{index}.png"; image.write_bytes(f"person-{index}".encode())
                data["creators"].append({"creatorId": f"p{index}", "file": str(image), "sourceType": "user_provided"})
            with self.assertRaisesRegex(ValueError, "超过模型上限"):
                run_generation.prepare_references(data, {"segmentId": 1, "storyboardIds": [1], "creatorIds": []}, root, "seedance-2-mini")

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg required")
    def test_product_merge_preserves_source_provenance(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); data, product, _ = self.fixture(root)
            Image.new("RGB", (8, 8), "red").save(product)
            other = root / "other-product.png"; Image.new("RGB", (8, 8), "blue").save(other)
            data["product"]["productImages"].append({"file": str(other), "sourceType": "user_provided"})
            for index in range(6):
                image = root / f"creator-{index}.png"; image.write_bytes(f"creator-{index}".encode())
                data["creators"].append({"creatorId": f"p{index}", "file": str(image), "sourceType": "user_provided"})
            segment = {"segmentId": 1, "storyboardIds": [1], "creatorIds": []}
            files = run_generation.prepare_references(data, segment, root, "seedance-2-mini")
            self.assertEqual(len(files), 9)
            self.assertEqual(len(reference_audit.audit_submission_files(data, files, segment_id=1)["productImages"]), 2)
            with patch("scripts.run_generation.reference_board.render", side_effect=AssertionError("rendered twice")):
                self.assertEqual(run_generation.prepare_references(data, segment, root, "seedance-2-mini"), files)

    def test_upload_cache_reuses_valid_media_and_expires_safely(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); image = root / "image.png"; image.write_bytes(b"image")
            duplicate = root / "duplicate.png"; duplicate.write_bytes(b"image")
            expiry = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
            calls = []
            def mock_cli(args):
                calls.append(args)
                return {"url": "https://example.com/image.png", "mimeType": "image/png", "expiredAt": expiry}
            with patch.object(local_video_cli, "run_lululab_cli", side_effect=mock_cli):
                first = local_video_cli.upload_reference_images([image], cache_path=root / "cache.json")
                second = local_video_cli.upload_reference_images([duplicate], cache_path=root / "cache.json")
                self.assertEqual(first, second)
                self.assertEqual(len(calls), 1)
                payloads = []
                def submit(args):
                    payloads.append(args)
                    return {"id": "mock-task"}
                with patch.object(local_video_cli, "run_lululab_cli", side_effect=submit):
                    task_id = local_video_cli.submit_video("lululab_cli", "seedance-2-mini", "prompt", 9,
                                                           reference_files=[image], reference_media=first)
                self.assertEqual(task_id, "mock-task")
                self.assertEqual(json.loads(payloads[0][-1])["referenceImages"], first)
            expired = json.loads((root / "cache.json").read_text())
            next(iter(expired.values()))["expiredAt"] = "2000-01-01T00:00:00+00:00"
            (root / "cache.json").write_text(json.dumps(expired))
            with patch.object(local_video_cli, "run_lululab_cli", side_effect=mock_cli):
                local_video_cli.upload_reference_images([image], cache_path=root / "cache.json")
            self.assertEqual(len(calls), 2)

    def test_upload_cache_reuses_cli_media_without_expiry_within_run(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); image = root / "image.png"; image.write_bytes(b"image without expiry")
            with patch.object(local_video_cli, "run_lululab_cli", return_value={"url": "https://example.com/image.png", "mimeType": "image/png"}) as mock:
                local_video_cli.upload_reference_images([image], cache_path=root / "cache.json")
                local_video_cli.upload_reference_images([image], cache_path=root / "cache.json")
            self.assertEqual(mock.call_count, 1)

    def test_registration_does_not_change_preserve_strategy(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); image = root / "product.png"; image.write_bytes(b"product")
            manifest = generation_manifest.command_init(type("Args", (), {"output_root": td, "task_id": "task", "reuse": False})())
            generation_manifest.register_product_uploads(manifest, [str(image)], preserve_original=True)
            data = generation_manifest.load_manifest(manifest)
            self.assertTrue(data["product"]["useBenchmarkProduct"])
            self.assertEqual(data["product"]["referenceIntent"], "preserve_original_identity")

    def test_multiple_uploaded_views_for_same_creator_are_retained(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            manifest = generation_manifest.command_init(type("Args", (), {"output_root": td, "task_id": "task", "reuse": False})())
            images = []
            for index in range(2):
                image = root / f"creator-{index}.png"; image.write_bytes(f"view-{index}".encode())
                images.append(str(image.resolve()))
                generation_manifest.add_creator(manifest, str(image), "person-a", "user_provided", preserve_original=True)
            data = generation_manifest.load_manifest(manifest)
            self.assertEqual(data["creators"][0]["referenceImages"], images)
            self.assertEqual(reference_audit.uploaded_creator_files(data), images)
            self.assertEqual(run_generation.creator_files(data, {"segmentId": 1, "creatorIds": []}), images)

    def test_host_preflight_reports_missing_capabilities(self):
        with patch("scripts.host_preflight.shutil.which", return_value=None):
            result = host_preflight.inspect()
        self.assertFalse(result["ok"])
        self.assertIn("node", result["missing"])
        self.assertIn("cliExecution", result["missing"])

    def test_single_skill_entry_is_discoverable_by_file_based_hosts(self):
        root = Path(__file__).resolve().parents[1]
        source = (root / "SKILL.md").read_text(encoding="utf-8")
        self.assertTrue(source.startswith("---\n"))
        self.assertIn("name: LuluLab-Recreate-Video", source.split("---", 2)[1])
        self.assertTrue((root / "scripts" / "host_preflight.py").is_file())
        self.assertTrue((root / "scripts" / "lululab_cli.mjs").is_file())

    def test_stage_and_submission_fingerprints_invalidate_changed_inputs(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); data, product, _ = self.fixture(root)
            boards = data["storyboards"]["generation"]
            first = prepare_prompt_handoff.input_fingerprint(data, boards)
            product.write_bytes(b"changed product")
            self.assertNotEqual(first, prepare_prompt_handoff.input_fingerprint(data, boards))
            segment = {"segmentId": 1, "prompt": "first", "duration": 9}
            files = [str(root / "board.png"), str(product)]
            previous = run_generation.submission_fingerprint(segment, files, "seedance-2-mini", "720p", "9:16")
            segment["prompt"] = "changed"
            self.assertNotEqual(previous, run_generation.submission_fingerprint(segment, files, "seedance-2-mini", "720p", "9:16"))

    def test_analysis_cache_reports_source_change(self):
        with tempfile.TemporaryDirectory() as td:
            source = Path(td) / "source.mp4"; source.write_bytes(b"first")
            record = {"benchmarkVideo": {"analysis": {"sourceFile": str(source),
                                                     "sourceSha256": generation_manifest.file_sha256(source)}},
                      "videoBlueprint": {}, "videos": []}
            self.assertTrue(task_status.summarize(record)["analysis"]["cacheValid"])
            source.write_bytes(b"second")
            self.assertFalse(task_status.summarize(record)["analysis"]["cacheValid"])


if __name__ == "__main__":
    unittest.main()
