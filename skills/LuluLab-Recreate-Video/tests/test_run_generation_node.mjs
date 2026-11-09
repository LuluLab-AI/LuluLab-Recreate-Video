import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {run} from '../scripts/run_generation.mjs';

test('video dispatch stores task ID and a later run resumes it without another submit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lululab-video-node-'));
  try {
    const manifest = join(root, 'manifest.json'), promptFile = join(root, 'prompts.json'),
      board = join(root, 'board.png');
    await writeFile(board, 'board-image');
    const segment = {segmentId: 1, duration: 4, storyboardIds: [1], creatorIds: [],
      productPresent: false, prompt: 'Generate four seconds'};
    await writeFile(promptFile, JSON.stringify({videoPrompts: {segments: [segment]}}));
    await writeFile(manifest, JSON.stringify({version: 4, skillVersion: '1.3.7',
      userConfig: {videoModel: 'seedance-2-mini', duration: 4, resolution: '720p'},
      product: {useBenchmarkProduct: true, productImages: []},
      benchmarkVideo: {analysis: {recommendedSegments: [{segmentId: 1, duration: 4,
        globalStart: 0, globalEnd: 4}]}},
      storyboards: {original: [], edited: [], generation: [{storyboardId: 1, segmentId: 1,
        file: board, anchors: Array.from({length: 9}, (_, index) => ({globalTimestamp: index / 2,
          personPresent: false, personCount: 0, creatorIds: [], productPresent: false}))}]},
      videoPrompts: {file: promptFile, segments: [segment]}, creators: [], videos: []}));
    let submits = 0;
    const api = {upload: async () => ({url: 'https://example.com/board.png', mimeType: 'image/png'}),
      request: async (path, options) => {
        if (path === '/billing/quotes') return {id: 'quote-1', credits: 12};
        if (path.startsWith('/credits?')) return {total: 1, items: [{creditsAvailable: 12}]};
        assert.equal(path, '/tasks/batch'); submits++;
        assert.equal(options.body.length, 1); assert.equal(options.body[0].input.referenceImages.length, 1);
        return [{id: 'video-task-1'}];
      },
      task: async () => ({status: 'success', output: {video: {url: 'https://example.com/video.mp4'}}})};
    const dispatched = await run({manifest, skipConcat: true, dispatchOnly: true,
      generationApproved: true, segmentIds: [1], api});
    assert.equal(dispatched.status, 'dispatched'); assert.equal(submits, 1);
    const savedAfterDispatch = JSON.parse(await readFile(manifest, 'utf8'));
    assert.equal(savedAfterDispatch.videos[0].taskId, 'video-task-1');
    const completed = await run({manifest, skipConcat: true, api, dependencies: {
      downloadMedia: async (_media, path) => {await mkdir(join(root, 'candidates', 'candidate-01'), {recursive: true});
        await writeFile(path, 'video-bytes'); return path;}}});
    assert.equal(completed.generated, true); assert.equal(submits, 1);
    const final = JSON.parse(await readFile(manifest, 'utf8'));
    assert.equal(final.videos[0].status, 'success');
  } finally {await rm(root, {recursive: true, force: true});}
});
