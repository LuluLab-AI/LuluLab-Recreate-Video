import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildReview, finalize, WEIGHTS } from '../scripts/quality_review.mjs';

test('quality scoring keeps weighted thresholds and hard failures', () => {
  const report = { technical: { failures: ['missing_audio'] } };
  const scored = finalize(report, { scores: WEIGHTS, hardFailures: ['missing_audio'] });
  assert.equal(scored.totalScore, 100);
  assert.equal(scored.passed, false);
  assert.deepEqual(scored.hardFailures, ['missing_audio']);
  assert.equal(scored.recommendedRepairLayer, 'step4');
  assert.throws(() => finalize({}, { scores: { ...WEIGHTS, firstFrameHook: 16 } }), /评分 firstFrameHook/);
});

test('fast quality profile probes real videos and reports technical failures', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lululab-quality-js-'));
  try {
    const benchmark = join(dir, 'benchmark.mp4'), candidate = join(dir, 'candidate.mp4');
    for (const [file, duration] of [[benchmark, 2], [candidate, 1]]) {
      const made = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
        '-i', `testsrc2=size=320x240:rate=30:duration=${duration}`, '-c:v', 'libx264', file], { encoding: 'utf8' });
      assert.equal(made.status, 0, made.stderr);
    }
    const report = await buildReview('ffmpeg', 'ffprobe', benchmark, candidate, dir);
    assert.equal(report.qualityProfile, 'fast');
    assert.deepEqual(report.technical.failures, ['duration_out_of_tolerance']);
    assert.equal(report.comparisonSheet, null);
    assert.equal(report.pacing.status, 'not_scanned_fast_profile');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
