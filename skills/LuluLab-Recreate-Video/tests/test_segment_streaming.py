from __future__ import annotations

import json
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from scripts import creator_identity, generation_manifest, storyboard, task_status


class SegmentStreamingTests(unittest.TestCase):
    def test_out_of_order_board_is_available_while_others_render(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            video = root / "source.mp4"
            video.write_bytes(b"source")
            plan = root / "plan.json"
            plan.write_text("{}")
            output = root / "storyboards" / "original"
            segments = [dict(segmentId=i, globalStart=(i - 1) * 10,
                             globalEnd=i * 10, duration=10,
                             anchors=[{"timestamp": (i - 1) * 10 + n} for n in range(9)])
                        for i in (1, 2, 3)]
            finished = {}
            events = []
            gate = threading.Event()

            def render(_ffmpeg, _video, _digest, segment, board, *_args, **_kwargs):
                identifier = segment["segmentId"]
                if identifier != 3:
                    gate.wait(2)
                board.parent.mkdir(parents=True, exist_ok=True)
                board.write_bytes(f"board-{identifier}".encode())
                finished[identifier] = time.monotonic()
                return False

            def capture(value, **_kwargs):
                event = json.loads(value)
                if event.get("event") == "storyboard_ready":
                    events.append((event, time.monotonic()))
                    if event["segmentId"] == 3:
                        gate.set()

            args = ["storyboard.py", "--video", str(video), "--timestamps-file", str(plan),
                    "--output-dir", str(output), "--stream-ready"]
            with patch.object(storyboard, "parse_segment_plan", return_value=segments), \
                 patch.object(storyboard, "validate_model_windows"), \
                 patch.object(storyboard, "resolve_ffmpeg", return_value="ffmpeg"), \
                 patch.object(storyboard, "file_sha256", return_value="digest"), \
                 patch.object(storyboard, "render_or_reuse", side_effect=render), \
                 patch("sys.argv", args), patch("builtins.print", side_effect=capture):
                self.assertEqual(storyboard.main(), 0)
            self.assertEqual(events[0][0]["segmentId"], 3)
            self.assertLess(events[0][1], finished[1])
            self.assertLess(events[0][1], finished[2])
            metadata = Path(events[0][0]["metadata"])
            self.assertEqual(json.loads(metadata.read_text())["boards"][0]["segmentId"], 3)

    def test_creator_and_frames_overlap_and_manifest_updates_survive(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            manifest = generation_manifest.command_init(type("Args", (), {
                "output_root": str(root), "task_id": "task", "reuse": False})())
            generation_manifest.set_creator_mode(manifest, "ai_generated", ["presenter"])
            timestamps = {}

            def image_execute(args):
                timestamps["creator_started"] = time.monotonic()
                time.sleep(.08)
                Path(args.output).write_bytes(b"identity")
                Path(args.report).write_text(json.dumps({"status": "success", "taskId": "one"}))
                timestamps["creator_done"] = time.monotonic()
                return 0, {"status": "success", "taskId": "one"}

            def frame(_id):
                timestamps["frame_started"] = time.monotonic()
                time.sleep(.04)
                timestamps["frame_done"] = time.monotonic()
                return True

            with patch.object(creator_identity, "role_from_blueprint", return_value="presenter"), \
                 patch.object(creator_identity.lululab_image_generate, "execute", side_effect=image_execute), \
                 patch.object(creator_identity, "inspect_sheet", return_value={"width": 1024, "height": 1024}):
                with ThreadPoolExecutor(max_workers=2) as pool:
                    creator = pool.submit(creator_identity.run, manifest, "presenter")
                    frames = pool.submit(frame, 1)
                    self.assertTrue(frames.result())
                    self.assertEqual(creator.result()["taskId"], "one")
            self.assertLess(timestamps["frame_started"], timestamps["creator_done"])
            self.assertLess(timestamps["creator_started"], timestamps["frame_done"])
            with ThreadPoolExecutor(max_workers=3) as pool:
                list(pool.map(lambda i: generation_manifest.set_video(manifest, i, "submitted", taskId=f"video-{i}"), (1, 2, 3)))
            videos = generation_manifest.load_manifest(manifest)["videos"]
            self.assertEqual({item["taskId"] for item in videos}, {"video-1", "video-2", "video-3"})
            self.assertEqual(len(generation_manifest.load_manifest(manifest)["creatorGeneration"]), 1)

    def test_raw_ready_and_creator_wait_are_independent(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            manifest_path = generation_manifest.command_init(type("Args", (), {
                "output_root": str(root), "task_id": "task", "reuse": False})())
            generation_manifest.set_creator_mode(manifest_path, "ai_generated", ["presenter"])
            data = generation_manifest.load_manifest(manifest_path)
            data["benchmarkVideo"]["analysis"] = {"recommendedSegments": [
                {"segmentId": 1}, {"segmentId": 2}]}
            data["storyboards"]["original"] = [
                {"storyboardId": 1, "anchors": [{"creatorIds": ["presenter"]}]},
                {"storyboardId": 2, "anchors": [{"creatorIds": []}]}]
            generation_manifest.save_manifest(manifest_path, data)
            summary = task_status.summarize(data, manifest_path)
            self.assertEqual(summary["waitingDependencies"], [{"segmentId": 1, "creatorIds": ["presenter"]}])
            self.assertEqual(summary["readySegmentActions"], [
                {"segmentId": 2, "action": "register_raw_and_prepare_image_edit"}])

    def test_prompt_registration_keeps_other_segments_and_submitted_prompt(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            manifest = generation_manifest.command_init(type("Args", (), {
                "output_root": str(root), "task_id": "task", "reuse": False})())
            first = root / "first.json"
            second = root / "second.json"
            first.write_text(json.dumps({"videoPrompts": {"segments": [
                {"segmentId": 1, "prompt": "one"}]}}))
            second.write_text(json.dumps({"videoPrompts": {"segments": [
                {"segmentId": 2, "prompt": "two"}]}}))
            with patch.object(generation_manifest, "validate_prompt_record"):
                generation_manifest.set_prompts(manifest, str(first))
                generation_manifest.set_video(manifest, 1, "submitted", taskId="video-1")
                generation_manifest.set_prompts(manifest, str(second))
                saved = generation_manifest.load_manifest(manifest)
                self.assertEqual([item["segmentId"] for item in saved["videoPrompts"]["segments"]], [1, 2])
                self.assertEqual(json.loads(Path(saved["videoPrompts"]["file"]).read_text())
                                 ["videoPrompts"]["segments"][0]["prompt"], "one")
                first.write_text(json.dumps({"videoPrompts": {"segments": [
                    {"segmentId": 1, "prompt": "changed"}]}}))
                with self.assertRaisesRegex(ValueError, "禁止覆盖"):
                    generation_manifest.set_prompts(manifest, str(first))

    def test_image_and_prompt_ready_out_of_order_while_video_is_pending(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            manifest_path = generation_manifest.command_init(type("Args", (), {
                "output_root": str(root), "task_id": "task", "reuse": False})())
            data = generation_manifest.load_manifest(manifest_path)
            data["benchmarkVideo"]["analysis"] = {"recommendedSegments": [
                {"segmentId": i} for i in (1, 2, 3)]}
            data["videos"] = [{"segmentId": 1, "status": "submitted", "taskId": "slow-video"}]
            data["storyboards"]["edited"] = [{"storyboardId": 2}]
            data["videoPrompts"]["segments"] = [{"segmentId": 3}]
            result = task_status.summarize(data, manifest_path)
            self.assertEqual(result["readySegmentActions"], [
                {"segmentId": 2, "action": "prepare_prompt_and_dispatch"},
                {"segmentId": 3, "action": "dispatch_video"}])


if __name__ == "__main__":
    unittest.main()
