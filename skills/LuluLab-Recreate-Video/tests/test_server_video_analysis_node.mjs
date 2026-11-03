import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {run, buildInput, loadSubmitAttempts} from '../scripts/server_video_analysis.mjs';

test('server input limits technical cut candidates to the exact analysis window', () => {
  const input = buildInput({skillVersion: '5.1', userConfig: {durationMode: 'custom', duration: 15,
    plannerVersion: '2'}, benchmarkVideo: {analysis: {media: {duration: 29}, analysisDuration: 15,
    candidateCuts: [-1, 0, 4, 14.9, 15, 20]}}}, {url: 'https://example.com/prefix.mp4'});
  assert.deepEqual(input.userConfig.technicalCutCandidates, [0, 4, 14.9]);
  assert.equal(input.userConfig.sourceDuration, 29);
  assert.equal(input.userConfig.targetDuration, 15);
  assert.equal(input.plannerVersion, '2');
});
test('server analysis retries only one terminal failure and records both task IDs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lululab-server-node-'));
  try {
    const manifest = join(root, 'manifest.json'), source = join(root, 'source.mp4');
    await writeFile(source, 'source-video');
    await writeFile(manifest, JSON.stringify({version: 4, userConfig: {durationMode: 'source',
      duration: 3, plannerVersion: '1'}, benchmarkVideo: {analysis: {candidateCuts: [0, 2]}}}));
    let submitted = 0, uploads = 0;
    const plan = {schemaVersion: '1.0', plannerVersion: '1', segments: [{segmentId: 1,
      globalStart: 0, globalEnd: 3, duration: 3, anchors: [{globalTimestamp: 0}]}]};
    const api = {credits: async () => ({balance: 1}), upload: async () => {
      uploads++; return {url: 'https://example.com/video.mp4', mimeType: 'video/mp4'};},
      submit: async () => ({id: `task-${++submitted}`}),
      task: async id => id === 'task-1' ? {status: 'failed', errorMessage: 'remote error'} :
        {status: 'succeeded', output: {videoBlueprint: {summary: 'okay'}, replicationPlan: plan}}};
    const prepare = async (_config, _dir, _input, use) => use({sourceDuration: 3,
      analysisDuration: 3, filePath: source, directUrl: null});
    const result = await run({manifest, benchmark: source, api, prepare});
    assert.equal(result.taskId, 'task-2'); assert.equal(submitted, 2); assert.equal(uploads, 1);
    assert.deepEqual((await loadSubmitAttempts(manifest)).map(x => x.taskId), ['task-1', 'task-2']);
    const saved = JSON.parse(await readFile(manifest, 'utf8'));
    assert.equal(saved.videoBlueprint.status, 'succeeded');
    await assert.rejects(() => run({manifest, benchmark: source, api, prepare}), /只能用--resume-task-id/);
    assert.equal(submitted, 2);
  } finally {await rm(root, {recursive: true, force: true});}
});
test('ambiguous first submit leaves reservation and blocks another submit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lululab-server-node-'));
  try {
    const manifest = join(root, 'manifest.json'), source = join(root, 'source.mp4');
    await writeFile(source, 'source-video');
    await writeFile(manifest, JSON.stringify({version: 4, userConfig: {durationMode: 'source', duration: 3},
      benchmarkVideo: {analysis: {}}}));
    let submitted = 0;
    const api = {credits: async () => ({balance: 1}), upload: async () => ({url: 'https://example.com/video.mp4'}),
      submit: async () => {submitted++; throw Error('unknown submit outcome');}};
    const prepare = async (_config, _dir, _input, use) => use({sourceDuration: 3,
      analysisDuration: 3, filePath: source, directUrl: null});
    await assert.rejects(() => run({manifest, benchmark: source, api, prepare}), /unknown submit outcome/);
    await assert.rejects(() => run({manifest, benchmark: source, api, prepare}), /preparing_submission/);
    assert.equal(submitted, 1);
  } finally {await rm(root, {recursive: true, force: true});}
});
