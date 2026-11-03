import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTask, submit, poll } from '../scripts/dispatcher_recreate.mjs';
const id = '11111111-1111-4111-8111-111111111111';
const source = { id, url: 'https://assets.example/source.mp4', mimeType: 'video/mp4' };
const image = { id, url: 'https://assets.example/image.png', mimeType: 'image/png' };
const config = { source, sourceDuration: 12.4 };
test('website defaults and explicit creator selection reach the server and history', () => {
  const task = buildTask(config);
  assert.equal(task.workflowId, 'DeepRecreationV1');
  assert.equal(task.input.model, 'seedance-2-fast');
  assert.equal(task.input.resolution, '720p');
  assert.equal(task.input.deepPresentationVersion, 1);
  assert.equal(task.input.creator.mode, 'ai_generated');
  for (const mode of ['storyboard', 'deep']) {
    for (const creatorMode of ['ai_generated', 'keep_source', 'user_provided']) {
      const personImages = creatorMode === 'user_provided' ? [image] : [];
      const t = buildTask({ ...config, mode, creatorMode, personImages });
      assert.equal(t.input.creator.mode, creatorMode);
      assert.equal(t.editorSnapshot.personSource, { ai_generated: 'generate', keep_source: 'original', user_provided: 'upload' }[creatorMode]);
      assert.deepEqual(t.editorSnapshot.referenceVideo, source);
      assert.deepEqual(t.editorSnapshot.selected.person, personImages);
    }
  }
  assert.throws(() => buildTask({ ...config, creatorMode: 'user_provided' }));
  assert.throws(() => buildTask({ ...config, creatorMode: 'keep_source', personImages: [image] }));
});
test('new storyboard pipeline and text modes match website orchestration', () => {
  const t = buildTask({ ...config, mode: 'storyboard', requirement: ' keep packaging ' });
  assert.equal(t.input.storyboardPipelineVersion, 2);
  assert.equal(t.input.reviewBeforeGeneration, false);
  assert.deepEqual(t.input.postproduction, { marketingText: 'keep packaging', marketingTextMode: 'creative_brief' });
  assert.deepEqual(buildTask({ ...config, mode: 'storyboard', marketingText: '' }).input.postproduction,
    { marketingText: '', marketingTextMode: 'literal' });
});
test('mode-specific image limits and references match website', () => {
  assert.throws(() => buildTask({ ...config, productImages: Array(7).fill(image) }));
  assert.throws(() => buildTask({ ...config, mode: 'storyboard', productImages: Array(7).fill(image) }));
  assert.equal(buildTask({ ...config, mode: 'storyboard', creatorMode: 'keep_source', productImages: Array(7).fill(image) }).input.product.images.length, 7);
  const t = buildTask({ ...config, mode: 'element_replace', productImages: Array(10).fill(image) });
  assert.equal(t.input.referenceImages.length, 10);
  assert.throws(() => buildTask({ ...config, mode: 'element_replace', productImages: Array(11).fill(image) }));
  assert.throws(() => buildTask({ ...config, model: 'wan-3', resolution: '1080p' }));
});
test('new request persists before POST and resumes without another parent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'recreation-parity-')), file = join(dir, 'state.json');
  let posts = 0;
  const client = { async quote() { return { id, credits: 10 }; }, async request() {
    posts++; const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(saved.status, 'submission_unknown');
    assert.equal(saved.request.input.creator.mode, 'ai_generated');
    return { id, status: 'Running' };
  }, async task() { return { id, status: 'Succeeded', output: { video: { url: 'https://assets.example/final.mp4' } } }; } };
  try {
    await submit(config, file, client); await submit(config, file, client);
    assert.equal((await poll(file, client, { maxPolls: 1 })).status, 'Succeeded');
    assert.equal(posts, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
