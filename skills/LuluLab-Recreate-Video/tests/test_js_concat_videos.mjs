import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFilter, concatenate, orderedSegments } from '../scripts/concat_videos.mjs';

test('concat filter preserves ordered video and audio streams', () => {
  assert.match(buildFilter(2), /\[v0\]\[a0\]\[v1\]\[a1\]concat=n=2:v=1:a=1\[outv\]\[outa\]/);
  assert.throws(() => buildFilter(0), /At least one Segment/);
});

test('concatenation sorts successful segments and registers final video', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lululab-concat-'));
  try {
    const videos = ['red', 'blue'].map((color, index) => join(dir, `segment-${index + 1}.mp4`));
    for (const [index, color] of ['red', 'blue'].entries()) {
      const run = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
        '-i', `color=c=${color}:s=160x240:d=0.4`, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.4',
        '-shortest', '-c:v', 'libx264', '-c:a', 'aac', videos[index]], { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
    }
    const manifest = join(dir, 'manifest.json'), output = join(dir, 'final.mp4');
    await writeFile(manifest, JSON.stringify({ version: '4', videos: [
      { segmentId: 2, status: 'success', output_file: videos[1] },
      { segmentId: 1, status: 'success', output_file: videos[0] },
    ] }));
    assert.deepEqual((await orderedSegments(JSON.parse(await readFile(manifest, 'utf8')))).map(([id]) => id), [1, 2]);
    const result = await concatenate(manifest, output);
    assert.deepEqual(result.segment_order, [1, 2]);
    assert.ok((await stat(output)).size > 0);
    const updated = JSON.parse(await readFile(manifest, 'utf8'));
    assert.equal(updated.workflowStatus, 'complete');
    assert.deepEqual(updated.finalVideo.segmentIds, [1, 2]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
