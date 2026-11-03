import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {analyze, parseAnalysis} from '../scripts/product_image_analysis.mjs';

test('product analysis parses fenced JSON and rejects malformed features', () => {
  assert.equal(parseAnalysis('```json\n{"productName":"Brush","lockedFeatures":[]}\n```').productName, 'Brush');
  assert.throws(() => parseAnalysis('{"lockedFeatures":"fake"}'), /lockedFeatures/);
});
test('product analysis saves brief, image receipt, and avoids duplicate submission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lululab-product-node-'));
  try {
    const image = join(root, 'product.png'), manifest = join(root, 'manifest.json');
    await writeFile(image, 'product-image');
    await writeFile(manifest, JSON.stringify({version: 4, product: {productImages: [{file: image}],
      userSellingPoints: ['User confirmed claim']}, videos: []}));
    let submits = 0;
    const api = {upload: async () => ({url: 'https://example.com/p.png', mimeType: 'image/png'}),
      submit: async () => {submits++; return {id: 'product-task-1'};},
      task: async () => ({status: 'success', output: {text: JSON.stringify({productName: 'Brush',
        productType: 'Hair tool', usageMethod: '', lockedFeatures: ['blue handle'], isSameProduct: true})}})};
    const first = await analyze(manifest, {api});
    assert.equal(first.taskId, 'product-task-1');
    assert.equal(first.productBrief.产品卡.用户卖点锁定[0], 'User confirmed claim');
    const second = await analyze(manifest, {api});
    assert.equal(second.skipped, true); assert.equal(submits, 1);
    const saved = JSON.parse(await readFile(manifest, 'utf8'));
    assert.equal(saved.product.analysisTaskId, 'product-task-1');
  } finally {await rm(root, {recursive: true, force: true});}
});
