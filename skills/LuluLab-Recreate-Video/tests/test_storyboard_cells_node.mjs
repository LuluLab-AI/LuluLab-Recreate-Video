import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {detectGridBoundaries, fastPrepare, splitBoard, lockMerge, normalizeReplacementMap} from '../scripts/storyboard_cells.mjs';
import {boardMask, geometry, validateCanvasAspectRatio} from '../scripts/storyboard_regions.mjs';
import {normalizeReplacementRecord} from '../scripts/generation_manifest.mjs';

test('storyboard geometry rejects canvas drift and invalid region masks', () => {
  assert.deepEqual(geometry(300, 300), {width: 300, height: 300, x: 0, y: 0, aspectRatio: '1:1'});
  assert.throws(() => validateCanvasAspectRatio(300, 500, 300, 300), /15%/);
  const cells = Array.from({length: 9}, (_, i) => ({index: i + 1,
    product: {replace: i === 0}, creator: {replace: false},
    regions: {product: i === 0 ? [[[.2,.2],[.7,.2],[.7,.7],[.2,.7]]] : [], creator: [], protect: []}}));
  const mask = boardMask({mergeMode: 'object-regions-v1', coordinateSpace: 'original-cell-visual-normalized', labelHeight: 20, cells}, 300, 300);
  assert.equal(mask[40 * 300 + 40], 255);
  assert.equal(mask[100 * 300 + 40], 0);
  assert.equal(mask[95 * 300 + 40], 0);
});

test('legacy direct replacement map restores frozen cells and records hashes', async t => {
  if (spawnSync('ffmpeg', ['-version']).status || spawnSync('ffprobe', ['-version']).status) return t.skip('requires FFmpeg/FFprobe');
  const root = await mkdtemp(join(tmpdir(), 'lululab-lock-board-node-'));
  try {
    const board = join(root, 'board.png'), output = join(root, 'locked.png'), planPath = join(root, 'map.json');
    const made = spawnSync('ffmpeg', ['-v','error','-y','-f','lavfi','-i','color=c=gray:s=300x300:d=1',
      '-vf','drawgrid=w=100:h=100:t=2:c=white','-frames:v','1',board]);
    assert.equal(made.status, 0);
    const cells = Array.from({length: 9}, (_, i) => ({index: i + 1,
      product: {state: 'full', count: 1, replace: i === 0},
      creator: {state: 'none', count: 0, replace: false}}));
    const plan = {segmentId: 1, replaceProduct: true, replaceCreator: false,
      mergeMode: 'whole-board-direct-v1', editRule: 'Replace only cell 1 product', cells};
    assert.deepEqual(normalizeReplacementMap(plan).editableCells, [1]);
    await writeFile(planPath, JSON.stringify(plan));
    const result = await lockMerge('ffmpeg', 'ffprobe', board, board, planPath, output, 20);
    assert.equal(result.method, 'whole-board-visual-review');
    assert.equal(result.frozenCells.length, 8);
    assert.equal(JSON.parse(await readFile(result.metadata, 'utf8')).finalSha256, result.finalSha256);
  } finally {await rm(root, {recursive:true, force:true});}
});

test('legacy region lock merge protects pixels outside its mask', async t => {
  if (spawnSync('ffmpeg', ['-version']).status || spawnSync('ffprobe', ['-version']).status) return t.skip('requires FFmpeg/FFprobe');
  const root = await mkdtemp(join(tmpdir(), 'lululab-region-board-node-'));
  try {
    const board = join(root, 'board.png'), output = join(root, 'region.png'), planPath = join(root, 'map.json');
    const made = spawnSync('ffmpeg', ['-v','error','-y','-f','lavfi','-i','color=c=gray:s=300x300:d=1',
      '-vf','drawgrid=w=100:h=100:t=2:c=white','-frames:v','1',board]);
    assert.equal(made.status, 0);
    const cells = Array.from({length: 9}, (_, i) => ({index: i + 1, interactionState: '',
      product: {state: 'full', count: 1, replace: i === 0}, creator: {state: 'none', count: 0, replace: false},
      regions: {product: i === 0 ? [[[.2,.2],[.7,.2],[.7,.7],[.2,.7]]] : [], creator: [], protect: []}}));
    await writeFile(planPath, JSON.stringify({segmentId: 1, replaceProduct: true, replaceCreator: false,
      mergeMode: 'object-regions-v1', compositionMode: 'region-lock-v1',
      coordinateSpace: 'original-cell-visual-normalized', editRule: 'Replace product only', labelHeight: 20, cells}));
    const result = await lockMerge('ffmpeg', 'ffprobe', board, board, planPath, output, 20);
    assert.equal(result.outsideMaskChangedPixels, 0);
    assert.equal(result.protectedPixelsRestored, true);
    assert.ok((await stat(result.maskFile)).size > 0);
    const verified = normalizeReplacementRecord({method: 'whole-board-lock-merge', applied: true,
      generationAttempts: 1, maxImageEditAttempts: 1, imageEditSucceeded: true,
      mapValid: true, lockMergeSucceeded: true, frozenCellsRestored: true,
      editedImageFile: board, finalImageFile: output, mapFile: planPath,
      lockMergeFile: output.replace(/\.png$/, '.lock.json'), editableCells: [1],
      frozenCells: [2,3,4,5,6,7,8,9], replacementVerified: true});
    assert.equal(verified.replacementVerified, true);
  } finally {await rm(root, {recursive:true, force:true});}
});

test('fast-prepare restores a real 3×3 board and records hashes', async t => {
  if (spawnSync('ffmpeg', ['-version']).status || spawnSync('ffprobe', ['-version']).status) return t.skip('requires FFmpeg/FFprobe');
  const root = await mkdtemp(join(tmpdir(), 'lululab-board-cell-node-'));
  try {
    const board = join(root, 'board.png'), output = join(root, 'final.png'), cells = join(root, 'cells');
    const made = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=300x300:d=1',
      '-vf', 'drawgrid=w=100:h=100:t=2:c=white', '-frames:v', '1', board]);
    assert.equal(made.status, 0);
    assert.equal(detectGridBoundaries('ffmpeg', 'ffprobe', board).valid, true);
    const split = await splitBoard('ffmpeg', 'ffprobe', board, cells);
    assert.equal(split.cells.length, 9);
    const result = await fastPrepare('ffmpeg', 'ffprobe', board, board, output, 20);
    assert.equal(result.method, 'whole-board-fast-v1');
    assert.equal(result.layoutRestore.alignmentMode, 'detected-grid-per-cell');
    assert.equal(result.width, 300);
    assert.ok((await stat(output)).size > 0);
    const metadata = JSON.parse(await readFile(result.metadata, 'utf8'));
    assert.equal(metadata.finalSha256, result.finalSha256);
    await assert.rejects(() => fastPrepare('ffmpeg', 'ffprobe', board, board, output, 20), /输出已存在/);
  } finally {await rm(root, {recursive: true, force: true});}
});
