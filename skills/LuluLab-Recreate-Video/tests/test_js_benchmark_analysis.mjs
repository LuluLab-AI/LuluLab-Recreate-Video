import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { analysisCacheInput, analysisFingerprint, loadCachedAnalysis, probe,
  resolveReplicationDuration, validateBenchmarkDuration } from '../scripts/benchmark_analysis.mjs';

test('benchmark duration and replication rules preserve Python boundaries', () => {
  assert.equal(validateBenchmarkDuration(360), 360);
  assert.throws(() => validateBenchmarkDuration(360.001), /超过6分钟/);
  assert.deepEqual(resolveReplicationDuration(15.4, 'seedance-2-fast'), {
    durationMode: 'source', requestedDuration: null, targetDuration: 15,
    targetDurationSource: 'source_nearest_integer', replicationWindow: { start: 0, end: 15 },
    durationAdjustmentSeconds: -0.4,
  });
  assert.throws(() => resolveReplicationDuration(10, 'seedance-2-fast', 'custom', 11), /超过原视频时长/);
});

test('technical analysis and cache reuse match original Python output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lululab-benchmark-js-'));
  try {
    const video = join(dir, 'source.mp4'), output = join(dir, 'analysis.json');
    const made = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
      '-i', 'testsrc2=size=320x240:rate=30:duration=5', '-c:v', 'libx264', video], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    const media = probe('ffprobe', video);
    assert.equal(media.duration, 5);
    const node = spawnSync(process.execPath, ['scripts/benchmark_analysis.mjs', '--video', video,
      '--output', output], { encoding: 'utf8' });
    assert.equal(node.status, 0, node.stderr);
    const saved = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(saved.visualScan.sampleCount, 20);
    assert.equal(saved.analysisFingerprint, analysisFingerprint(analysisCacheInput(video,
      'seedance-2-fast', 'source', null, 0.14)));
    assert.ok(loadCachedAnalysis(output, analysisCacheInput(video, 'seedance-2-fast', 'source', null, 0.14)));
    const again = spawnSync(process.execPath, ['scripts/benchmark_analysis.mjs', '--video', video,
      '--output', output], { encoding: 'utf8' });
    assert.equal(again.status, 0, again.stderr);
    assert.equal(JSON.parse(again.stdout).reused, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
