import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {audit, auditSubmissionFiles, validateAiStoryboardInput} from '../scripts/reference_audit.mjs';

test('audit accepts complete no-person board and rejects missing reference', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lululab-audit-node-'));
  try {
    const board = join(root, 'board.png'), product = join(root, 'product.png');
    await writeFile(board, 'board'); await writeFile(product, 'product');
    const anchors = Array.from({length: 9}, (_, index) => ({globalTimestamp: index,
      personPresent: false, personCount: 0, creatorIds: [], productPresent: false}));
    const manifest = {skillVersion: '1.3.7', storyboards: {generation: [{storyboardId: 1,
      segmentId: 1, file: board, anchors}]}, benchmarkVideo: {analysis: {recommendedSegments: [{segmentId: 1}]}},
      videoPrompts: {segments: [{segmentId: 1, storyboardIds: [1], creatorIds: [], productPresent: false}]},
      product: {useBenchmarkProduct: true, productImages: [{file: product, sourceType: 'user_provided'}],
        referenceIntent: 'preserve_original_identity'}, creators: []};
    assert.equal(audit(manifest).passed, true);
    assert.throws(() => auditSubmissionFiles(manifest, [board], {segmentId: 1}), /缺少用户上传参考图/);
    assert.equal(auditSubmissionFiles(manifest, [board, product], {segmentId: 1}).productImages.length, 1);
  } finally {await rm(root, {recursive: true, force: true});}
});
test('AI storyboard report must include exact registered identity hash', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lululab-audit-node-'));
  try {
    const identity = join(root, 'identity.png'), edited = join(root, 'edited.png'), report = join(root, 'report.json');
    await writeFile(identity, 'identity'); await writeFile(edited, 'edited');
    await writeFile(report, JSON.stringify({status: 'success', provider: 'lululab_cli', output: edited,
      referenceSha256: []}));
    const manifest = {creator: {mode: 'ai_generated', targetCreatorIds: ['creator-main']},
      creators: [{creatorId: 'creator-main', sourceType: 'ai_generated', file: identity}]};
    const board = {replacementVerified: true, replacement: {imageTaskReport: report, editedImageFile: edited}};
    assert.throws(() => validateAiStoryboardInput(manifest, board, new Set(['creator-main'])), /未使用目标身份图/);
  } finally {await rm(root, {recursive: true, force: true});}
});
