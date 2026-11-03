import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, stat} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build, normalizeSegment} from '../scripts/segment_storyboards.mjs';

test('legacy segment board maps global to local time and renders nine panels', async t => {
  if (spawnSync('ffmpeg', ['-version']).status) return t.skip('requires FFmpeg');
  const root = await mkdtemp(join(tmpdir(), 'lululab-segment-board-node-'));
  try {
    const image = join(root, 'cell.png'), output = join(root, 'boards');
    const made = spawnSync('ffmpeg', ['-v','error','-y','-f','lavfi','-i','color=c=gray:s=96x128:d=1','-frames:v','1',image]);
    assert.equal(made.status, 0);
    const cells = Array.from({length: 9}, (_, i) => ({file: image, globalTimestamp: i / 9}));
    const segment = await normalizeSegment({segmentId: 1, globalStart: 0, globalEnd: 1, cells});
    assert.equal(segment.cells[3].localTimestamp, .333);
    let result;
    try {result = await build({segments: [{segmentId: 1, globalStart: 0, globalEnd: 1, cells}]}, output, 'ffmpeg', 'ffprobe');}
    catch (error) {if (/drawtext/.test(error.message)) return t.skip('FFmpeg lacks drawtext'); throw error;}
    assert.equal(result.boards[0].anchors.length, 9);
    assert.ok((await stat(result.boards[0].file)).size > 0);
    await assert.rejects(() => normalizeSegment({segmentId: 1, globalStart: 0, globalEnd: 1,
      cells: cells.map((x, i) => ({...x, globalTimestamp: i === 0 ? .2 : x.globalTimestamp}))}), /升序|段起点/);
  } finally {await rm(root, {recursive: true, force: true});}
});
