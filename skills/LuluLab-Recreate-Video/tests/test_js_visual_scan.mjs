import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeFrames, scanVideo } from '../scripts/visual_scan.mjs';

test('visual scan identifies a hard cut from grayscale frames', () => {
  const frames = [Buffer.alloc(12, 20), Buffer.alloc(12, 20), Buffer.alloc(12, 230), Buffer.alloc(12, 230)];
  const scan = analyzeFrames(frames, { fps: 4, duration: 1, width: 4, height: 3 });
  assert.equal(scan.sampleCount, 4);
  assert.deepEqual(scan.candidateCuts, [0.5]);
  assert.equal(scan.visualCandidates[0].eventType, 'cut');
  assert.equal(scan.version, 'single-pass-gray-v1');
});

test('single FFmpeg pass returns expected frame count and timestamps', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lululab-visual-scan-'));
  try {
    const video = join(dir, 'source.mp4');
    const made = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
      '-i', 'testsrc2=size=320x240:rate=30:duration=2', '-c:v', 'libx264', video], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    const scan = await scanVideo('ffmpeg', video, { duration: 2 });
    assert.equal(scan.sampleCount, 8);
    assert.equal(scan.samples[0].timestamp, 0);
    assert.equal(scan.samples.at(-1).timestamp, 1.75);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
