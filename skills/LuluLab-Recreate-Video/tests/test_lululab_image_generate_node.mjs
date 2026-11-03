import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execute} from '../scripts/lululab_image_generate.mjs';
import {IMAGE_MODEL, IMAGE_RESOLUTION, imageWorkflowId, media, pollTask} from '../scripts/local_video_cli_lululab.mjs';

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'lululab-image-node-'));
  try {
    const args = {prompt: 'make an image', aspectRatio: '9:16', referenceImages: [],
      output: join(root, 'image.png'), report: join(root, 'report.json')};
    await run(root, args);
  } finally { await rm(root, {recursive: true, force: true}); }
}
function dependencies(overrides = {}) {
  return {imageWorkflowId, submitImage: async () => 'task-1',
    client: async () => ({task: async () => ({status: 'success', output: {image: {url: 'https://example.com/image.png'}}})}),
    pollTask, media, downloadMedia: async (_m, output) => output, ...overrides};
}
test('image task persists receipt and success', async () => fixture(async (root, args) => {
  const {code, report} = await execute(args, dependencies());
  assert.equal(code, 0); assert.equal(report.taskId, 'task-1');
  assert.equal(report.model, IMAGE_MODEL); assert.equal(report.resolution, IMAGE_RESOLUTION);
  assert.equal(JSON.parse(await readFile(args.report, 'utf8')).status, 'success');
}));
test('resume uses saved task without submitting again', async () => fixture(async (root, args) => {
  await writeFile(args.report, JSON.stringify({status: 'submitted', taskId: 'task-1'}));
  const result = await execute({...args, resumeTaskId: 'task-1'}, dependencies({submitImage: () => {throw Error('duplicate');}}));
  assert.equal(result.code, 0);
}));
test('ambiguous submit preserves no-retry receipt', async () => fixture(async (root, args) => {
  const result = await execute(args, dependencies({submitImage: () => {throw Error('unknown');}}));
  assert.equal(result.code, 3); assert.equal(result.report.status, 'submit_outcome_unknown');
  await assert.rejects(() => execute(args, dependencies()), /禁止重复提交/);
}));
test('changed reference blocks resume', async () => fixture(async (root, args) => {
  const reference = join(root, 'creator.png');
  await writeFile(reference, 'creator-one');
  const initial = await execute({...args, referenceImages: [reference]}, dependencies({
    pollTask: async () => {throw Error('timeout');},
  }));
  assert.equal(initial.code, 3);
  await writeFile(reference, 'changed');
  await assert.rejects(() => execute({...args, referenceImages: [reference], resumeTaskId: 'task-1'}, dependencies()), /参考图与原提交不一致/);
}));
