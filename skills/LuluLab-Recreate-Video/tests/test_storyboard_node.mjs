import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm, stat} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseSegmentPlan, build} from '../scripts/storyboard.mjs';

test('storyboard validates nine strictly ordered anchors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lululab-storyboard-node-'));
  try {
    const input = join(root, 'anchors.json');
    const anchors = Array.from({length: 9}, (_, index) => ({timestamp: index * .44,
      anchorRole: index === 0 ? 'hard' : 'context', eventType: index === 0 ? 'first_frame' : 'context',
      personPresent: false, productPresent: false}));
    await writeFile(input, JSON.stringify({segments: [{segmentId: 1, globalStart: 0,
      globalEnd: 4, anchors}]}));
    const parsed = await parseSegmentPlan(input);
    assert.equal(parsed[0].anchors.length, 9);
    anchors[4].timestamp = anchors[3].timestamp;
    await writeFile(input, JSON.stringify({segments: [{segmentId: 1, globalStart: 0,
      globalEnd: 4, anchors}]}));
    await assert.rejects(() => parseSegmentPlan(input), /严格升序/);
  } finally {await rm(root, {recursive: true, force: true});}
});
test('storyboard renders real frames and reuses unchanged board', async t => {
  if (spawnSync('ffmpeg', ['-version']).status) return t.skip('requires FFmpeg');
  const root = await mkdtemp(join(tmpdir(), 'lululab-storyboard-node-'));
  try {
    const video = join(root, 'source.mp4'), input = join(root, 'anchors.json'), output = join(root, 'boards');
    const made = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i',
      'testsrc2=size=160x240:rate=10', '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', video]);
    assert.equal(made.status, 0);
    await writeFile(input, JSON.stringify({segments: [{segmentId: 1, globalStart: 0,
      globalEnd: 4, anchors: Array.from({length: 9}, (_, index) => ({timestamp: index * .44,
        anchorRole: index === 0 ? 'hard' : 'context', eventType: index === 0 ? 'first_frame' : 'context',
        personPresent: false, productPresent: false}))}]}));
    let first;
    try {first = await build({video, timestampsFile: input, outputDir: output, model: 'seedance-2-mini',
      cellWidth: 96, cellHeight: 128});}
    catch (error) {if (/drawtext/.test(error.message)) return t.skip('FFmpeg lacks drawtext'); throw error;}
    assert.ok((await stat(first.outputs[0])).size > 0);
    const bytes = await readFile(first.outputs[0]);
    const second = await build({video, timestampsFile: input, outputDir: output, model: 'seedance-2-mini',
      cellWidth: 96, cellHeight: 128});
    assert.equal(second.boards[0].reused, true);
    assert.deepEqual(await readFile(first.outputs[0]), bytes);
    await writeFile(input, JSON.stringify({segments: [{segmentId: 1, globalStart: 0,
      globalEnd: 4, anchors: Array.from({length: 16}, (_, index) => ({timestamp: index * .25,
        anchorRole: index === 0 ? 'hard' : 'context', eventType: index === 0 ? 'first_frame' : 'context',
        personPresent: false, productPresent: false}))}]}));
    const sixteen = await build({video, timestampsFile: input, outputDir: join(root, 'boards-4x4'),
      model: 'seedance-2-mini', cellWidth: 96, cellHeight: 128});
    assert.equal(sixteen.boards[0].layout, '4x4');
    assert.ok((await stat(sixteen.outputs[0])).size > 0);
  } finally {await rm(root, {recursive: true, force: true});}
});
