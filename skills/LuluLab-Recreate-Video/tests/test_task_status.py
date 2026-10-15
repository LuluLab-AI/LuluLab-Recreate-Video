from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
import sys
import subprocess

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts import task_status


class SavedTaskStatusTests(unittest.TestCase):
    def test_finished_file_wins_over_stale_pending_message(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            video = root / "final.mp4"
            video.write_bytes(b"video")
            report = root / "quality.json"
            report.write_text(json.dumps({
                "technicalPassed": True,
                "semanticStatus": "not_reviewed",
                "deliveryBlocked": False,
            }))
            state = task_status.summarize({
                "workflowStatus": "querying",
                "finalVideo": {"file": str(video), "qualityReport": str(report)},
                "videos": [{"segmentId": 1, "status": "querying", "taskId": "saved-id"}],
            })
            self.assertEqual(state["status"], "video_ready")
            self.assertTrue(state["deliverableReady"])
            self.assertEqual(state["quality"]["technicalPassed"], True)
            self.assertEqual(state["quality"]["semanticStatus"], "not_reviewed")

    def test_saved_task_id_is_reported_without_reupload(self):
        state = task_status.summarize({
            "videos": [{"segmentId": 1, "status": "querying", "taskId": "existing-id"}],
        })
        self.assertEqual(state["status"], "video_task_pending")
        self.assertEqual(state["segments"][0]["taskId"], "existing-id")
        self.assertFalse(state["deliverableReady"])

    def test_terminal_failure_is_not_reported_as_pending(self):
        state = task_status.summarize({
            "videos": [
                {"segmentId": 1, "status": "success", "output_file": "/missing.mp4"},
                {"segmentId": 2, "status": "terminal_failed", "taskId": "failed-id"},
            ],
        })
        self.assertEqual(state["status"], "segment_terminal_failed")
        self.assertEqual(state["segments"][1]["taskId"], "failed-id")

    def test_wait_guard_stops_on_failed_video(self):
        with tempfile.TemporaryDirectory() as td:
            manifest_path = Path(td) / "manifest.json"
            manifest_path.write_text(json.dumps({
                "videos": [{"segmentId": 2, "status": "terminal_failed", "taskId": "failed-id"}],
            }))
            result = subprocess.run(
                [sys.executable, str(ROOT / "scripts" / "task_status.py"),
                 "--manifest", str(manifest_path), "--assert-can-wait"],
                capture_output=True, text=True, check=False,
            )
            self.assertEqual(result.returncode, 3)

    def test_wait_guard_stops_when_storyboard_is_ready_for_handoff(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            edited = root / "storyboards" / "edited"
            edited.mkdir(parents=True)
            (edited / "segment-01-final.png").write_bytes(b"image")
            manifest_path = root / "manifest.json"
            manifest_path.write_text(json.dumps({
                "benchmarkVideo": {"analysis": {"recommendedSegments": [{"segmentId": 1}]}},
            }))
            result = subprocess.run(
                [sys.executable, str(ROOT / "scripts" / "task_status.py"),
                 "--manifest", str(manifest_path), "--assert-can-wait"],
                capture_output=True, text=True, check=False,
            )
            self.assertEqual(result.returncode, 2)
            self.assertIn("register_storyboard_and_dispatch", result.stdout)

    def test_missing_final_file_is_not_reported_as_deliverable(self):
        state = task_status.summarize({
            "workflowStatus": "complete",
            "finalVideo": {"file": "/not/a/real/final.mp4"},
        })
        self.assertEqual(state["status"], "final_file_missing")
        self.assertFalse(state["deliverableReady"])

    def test_completed_analysis_is_reused(self):
        with tempfile.TemporaryDirectory() as td:
            result = Path(td) / "blueprint.json"
            result.write_text("{}")
            state = task_status.summarize({
                "videoBlueprint": {"status": "succeeded", "taskId": "analysis-id", "file": str(result)},
            })
            self.assertEqual(state["status"], "analysis_ready")
            self.assertEqual(state["analysis"]["taskId"], "analysis-id")

    def test_completed_segment_is_flagged_until_video_task_is_saved(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            manifest_path = root / "manifest.json"
            edited_dir = root / "storyboards" / "edited"
            edited_dir.mkdir(parents=True)
            (edited_dir / "segment-01-final.png").write_bytes(b"image")
            manifest = {
                "benchmarkVideo": {"analysis": {"recommendedSegments": [{"segmentId": 1}]}},
                "storyboards": {"edited": []},
                "videoPrompts": {"segments": []},
                "videos": [],
            }
            state = task_status.summarize(manifest, manifest_path)
            self.assertEqual(state["readySegmentActions"], [
                {"segmentId": 1, "action": "register_storyboard_and_dispatch"}
            ])
            manifest["storyboards"]["edited"] = [{"storyboardId": 1}]
            self.assertEqual(task_status.summarize(manifest, manifest_path)["readySegmentActions"][0]["action"],
                             "prepare_prompt_and_dispatch")
            manifest["videoPrompts"]["segments"] = [{"segmentId": 1}]
            self.assertEqual(task_status.summarize(manifest, manifest_path)["readySegmentActions"][0]["action"],
                             "dispatch_video")
            manifest["videos"] = [{"segmentId": 1, "taskId": "saved-task"}]
            self.assertEqual(task_status.summarize(manifest, manifest_path)["readySegmentActions"], [])


if __name__ == "__main__":
    unittest.main()
