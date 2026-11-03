import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setPrompts, setVideo} from '../scripts/generation_manifest.mjs';

test('prompt registration merges segments and preserves submitted prompts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lululab-prompts-'));
  try {
    const manifest = join(root, 'manifest.json'), input = join(root, 'prompts.json');
    const segment = id => ({segmentId: id, duration: 10, storyboardIds: [id], prompt: `Prompt ${id}`});
    await writeFile(manifest, JSON.stringify({version: 4, workflowStatus: 'step3_complete',
      storyboards: {original: [], edited: [], generation: [{segmentId: 1}, {segmentId: 2}]},
      benchmarkVideo: {analysis: {recommendedSegments: []}}, videos: [], product: {}, creator: {}}));
    await writeFile(input, JSON.stringify({videoPrompts: {segments: [segment(1)]}}));
    await setPrompts(manifest, input);
    await setVideo(manifest, 1, 'submitted', {taskId: 'paid-task-1'});
    await writeFile(input, JSON.stringify({videoPrompts: {segments: [segment(2)]}}));
    await setPrompts(manifest, input);
    const saved = JSON.parse(await readFile(manifest, 'utf8'));
    assert.deepEqual(saved.videoPrompts.segments.map(item => item.segmentId), [1, 2]);
    assert.equal(saved.videos[0].taskId, 'paid-task-1');
    await writeFile(input, JSON.stringify({videoPrompts: {segments: [{...segment(1), prompt: 'changed'}]}}));
    await assert.rejects(() => setPrompts(manifest, input), /禁止覆盖对应 Prompt/);
  } finally {await rm(root, {recursive: true, force: true});}
});
