import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeBatch } from '../scripts/image_batch_generate.mjs';
import * as cli from '../scripts/local_video_cli_lululab.mjs';

for (const available of [3, 4]) test(`storyboard image batch: ${available} available for two 2-credit images`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'image-batch-'));
  const calls = [];
  const config = { state: join(root, 'batch.json'), items: [1, 2].map(index => ({ prompt: `board ${index}`, aspectRatio: '9:16', output: join(root, `board-${index}.png`), report: join(root, `report-${index}.json`) })) };
  const api = { request: async (path, options) => {
    calls.push(path);
    if (path === '/billing/quotes') return { id: `quote-${calls.length}`, credits: 2 };
    if (path.startsWith('/credits?')) return { total: 1, items: [{ creditsAvailable: available }] };
    assert.equal(path, '/tasks/batch');
    assert.equal(options.body.length, 2);
    return [{ id: 'image-1' }, { id: 'image-2' }];
  }, task: async id => ({ id, status: 'Succeeded', output: { image: { url: `https://example.com/${id}.png` } } }) };
  const dependencies = { ...cli, client: async () => api, uploadReferenceImages: async () => [],
    pollTask: async (get, id) => get(id), downloadMedia: async (_media, path) => path };
  try {
    if (available === 3) {
      await assert.rejects(executeBatch(config, dependencies), error => error.code === 'LULULAB_CREDITS_INSUFFICIENT');
      assert.ok(!calls.includes('/tasks/batch'));
    } else {
      assert.equal((await executeBatch(config, dependencies)).code, 0);
      assert.equal(calls.filter(path => path === '/tasks/batch').length, 1);
      assert.equal(JSON.parse(await readFile(config.items[1].report, 'utf8')).taskId, 'image-2');
      await executeBatch(config, dependencies);
      assert.equal(calls.filter(path => path === '/tasks/batch').length, 1);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
