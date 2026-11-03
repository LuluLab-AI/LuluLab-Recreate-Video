import test from 'node:test';
import assert from 'node:assert/strict';
import { estimate, buildTask } from '../scripts/dispatcher_recreate.mjs';
const media = { url: 'https://assets.example/product.png', mimeType: 'image/png' };
const configs = ['storyboard', 'deep', 'element_replace'].map(mode => ({ mode, source: { id: '11111111-1111-4111-8111-111111111111', url: 'https://assets.example/source.mp4', mimeType: 'video/mp4' }, sourceDuration: 12.4 }));

test('estimate returns server pricing without quotes or task submission', async () => {
  for (const config of configs) {
    const calls = [];
    const response = { credits: 123, version: 'test-rates', breakdown: [{ credits: 123 }] };
    const client = { async request(path, options) { calls.push({ path, ...options }); return response; } };
    assert.deepEqual(await estimate(config, client), response);
    assert.deepEqual(calls, [{ path: '/billing/estimates', method: 'POST', body: { items: [buildTask(config)] } }]);
  }
});

test('unavailable or invalid pricing never falls through to task submission', async () => {
  for (const credits of [undefined, null, '123', -1, NaN, Infinity, 1.5]) {
    const calls = [];
    await assert.rejects(estimate(configs[0], { async request(path) { calls.push(path); return { credits }; } }), /valid credit total/);
    assert.deepEqual(calls, ['/billing/estimates']);
  }
  await assert.rejects(estimate(configs[0], { async request() { throw Error('pricing unavailable'); } }), /pricing unavailable/);
  assert.equal((await estimate(configs[0], { async request() { return { credits: 0 }; } })).credits, 0);
});
