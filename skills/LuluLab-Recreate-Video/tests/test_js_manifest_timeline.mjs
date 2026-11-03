import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandInit, loadManifest, registerProductUploads, saveManifest,
  setInteractionLocale, setProductReferences } from '../scripts/generation_manifest.mjs';
import { normalizeServerPlan, persistPlan } from '../scripts/blueprint_timeline.mjs';

test('manifest loading preserves Python schema migrations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lululab-manifest-'));
  try {
    const file = join(dir, 'manifest.json');
    await writeFile(file, JSON.stringify({ version: '4', schemaRevision: '5.0',
      workflowStatus: 'step4_complete', shotContracts: { shotContracts: [1] },
      storyboards: { original: [{ id: 1 }], edited: [], generation: [] },
      userConfig: { interactionLocale: 'zh-CN', videoModel: null } }));
    const data = await loadManifest(file);
    assert.equal(data.schemaRevision, '5.3');
    assert.equal(data.workflowStatus, 'step1_complete');
    assert.equal(data.userConfig.videoModel, null);
    assert.equal(data.userConfig.interactionLanguage, 'zh');
    assert.deepEqual(data.migrationArchive.shotContracts, { shotContracts: [1] });
    await saveManifest(file, data);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).migrationArchive, data.migrationArchive);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('timeline adapter persists server layout and segment windows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lululab-timeline-'));
  try {
    const planFile = join(dir, 'plan.json'), manifestFile = join(dir, 'manifest.json'), output = join(dir, 'anchors.json');
    const plan = { schemaVersion: '1.0', plannerVersion: '1', policyVersion: '1.0.0',
      sourceDuration: 11.841, segments: [{ segmentId: 1, globalStart: 0, globalEnd: 12,
        duration: 12, anchors: Array.from({ length: 16 }, (_, i) => ({ timestamp: i * 0.7 })) }] };
    await writeFile(planFile, JSON.stringify(plan));
    await writeFile(manifestFile, JSON.stringify({ version: '4', replicationPlan: { file: planFile } }));
    const result = await persistPlan(manifestFile, output);
    assert.deepEqual(result.layouts, ['4x4']);
    assert.equal(JSON.parse(await readFile(output, 'utf8')).segments[0].anchorCount, 16);
    const manifest = await loadManifest(manifestFile);
    assert.deepEqual(manifest.benchmarkVideo.analysis.recommendedSegments,
      [{ segmentId: 1, globalStart: 0, globalEnd: 12, duration: 12 }]);
    assert.equal(manifest.timelinePlan.serverFile, planFile);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('V2 timeline rejects invalid anchor references', () => {
  const plan = { schemaVersion: '1.0', plannerVersion: '2', sourceDuration: 10,
    segments: [{ segmentId: 1, globalStart: 0, globalEnd: 9, duration: 9,
      shotIds: ['s1'], sourceCharacterIds: [], sourceProductIds: [],
      anchors: Array.from({ length: 9 }, (_, i) => ({ timestamp: i, shotId: i ? 's1' : 'missing' })) }] };
  assert.throws(() => normalizeServerPlan(plan), /真实shotId/);
});

test('manifest init and product registration preserve the Python workflow state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lululab-init-'));
  try {
    const manifest = await commandInit({ taskId: 'task', outputRoot: dir });
    const image = join(dir, 'product.png');
    await writeFile(image, 'product');
    await registerProductUploads(manifest, [image]);
    await setProductReferences(manifest, [image]);
    await setInteractionLocale(manifest, 'zh-CN');
    const data = await loadManifest(manifest);
    assert.equal(data.userConfig.videoModel, 'seedance-2-mini');
    assert.equal(data.userConfig.imageProvider, 'lululab_cli');
    assert.equal(data.userConfig.interactionLanguage, 'zh');
    assert.equal(data.product.mode, 'replacement');
    assert.equal(data.product.useBenchmarkProduct, false);
    assert.deepEqual(data.product.productImages,
      [{ file: await realpath(image), sourceType: 'user_provided' }]);
    await assert.rejects(commandInit({ taskId: 'task', outputRoot: dir }), /manifest 已存在/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
