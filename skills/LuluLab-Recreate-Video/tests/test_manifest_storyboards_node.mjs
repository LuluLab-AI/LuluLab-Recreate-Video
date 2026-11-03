import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {addOriginalStoryboardsFromMetadata, addStoryboard, loadManifest} from '../scripts/generation_manifest.mjs';

test('manifest registers original boards separately from generation boards', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lululab-manifest-boards-node-'));
  try {
    const manifest = join(root, 'manifest.json'), board = join(root, 'board.png'), metadata = join(root, 'boards.json');
    await writeFile(board, 'image');
    await writeFile(manifest, JSON.stringify({version: 4, storyboards: {original: [], edited: [], generation: []}}));
    await writeFile(metadata, JSON.stringify({layout: '3x3', boards: [{storyboardId: 1, file: board,
      anchors: Array.from({length: 9}, (_, i) => ({timestamp: i}))}]}));
    await addOriginalStoryboardsFromMetadata(manifest, metadata);
    let data = await loadManifest(manifest);
    assert.equal(data.storyboards.original.length, 1);
    assert.equal(data.storyboards.generation.length, 0);
    await addStoryboard(manifest, 'edited', board, 1, {anchors: Array.from({length: 9}, (_, i) => ({timestamp: i}))});
    data = await loadManifest(manifest);
    assert.equal(data.storyboards.edited.length, 1);
    assert.equal(data.workflowStatus, 'step2_complete');
    await assert.rejects(() => addStoryboard(manifest, 'original', board, 2, {replacement: {applied: true}}), /edited/);
    assert.equal(JSON.parse(await readFile(manifest, 'utf8')).storyboards.original.length, 1);
  } finally {await rm(root, {recursive: true, force: true});}
});
