import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildChatgenInput, buildPrompt, extractText, invoke} from '../scripts/chatgen_prompt.mjs';

test('ChatGen input is flat and unverified dialogue has an adaptation rule', () => {
  assert.deepEqual(buildChatgenInput('text', []), {prompt: 'text', images: [], videos: []});
  const prompt = buildPrompt({userConfig: {interactionLocale: 'zh-CN'}}, {segmentId: 1},
    {'逐镜头拆解': [{'声音': {utterances: [{utteranceId: 'u1', text: '无法确认'}]}}]}, {});
  assert.deepEqual(JSON.parse(prompt.split('\n')[1]).unverifiedDialogueAdaptation.utteranceIds, ['u1']);
});
test('ChatGen registers prompt and resume never submits again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lululab-chatgen-'));
  try {
    const manifestPath = join(root, 'manifest.json'), board = join(root, 'board.png'),
      blueprintPath = join(root, 'blueprint.json');
    await writeFile(board, 'image');
    await writeFile(blueprintPath, JSON.stringify({videoBlueprint: {schemaVersion: '6.0',
      '逐镜头拆解': [{shotId: 's1', start: 0, end: 10, '声音': {utterances: []}}],
      '节奏结构': {dramaticBeats: [{beatId: 'b1', start: 0, end: 10}]}}}));
    await writeFile(manifestPath, JSON.stringify({version: 4, workflowStatus: 'step3_complete',
      benchmarkVideo: {analysis: {recommendedSegments: [{segmentId: 1, duration: 10, globalStart: 0, globalEnd: 10}]}},
      storyboards: {original: [], edited: [], generation: [{storyboardId: 1, segmentId: 1, file: board}]},
      videoBlueprint: {file: blueprintPath}, userConfig: {interactionLocale: 'en'}, videos: []}));
    let submits = 0;
    const api = {upload: async () => ({url: 'https://example.com/board.png', mimeType: 'image/png'}),
      submit: async (_workflow, input) => {submits++; assert.equal(input.images.length, 1); return {id: 'task-1'};},
      task: async () => ({status: 'success', output: {text: 'Final prompt'}})};
    const result = await invoke(manifestPath, 1, {api, intervalMs: 1});
    assert.equal(result.prompt, 'Final prompt'); assert.equal(submits, 1);
    const saved = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.equal(saved.videoPrompts.segments[0].prompt, 'Final prompt');
    await assert.rejects(() => invoke(manifestPath, 1, {api, resume: true}), /已登记Prompt/);
    assert.equal(submits, 1);
  } finally {await rm(root, {recursive: true, force: true});}
});
test('ChatGen output requires output.text', () => assert.throws(() => extractText({status: 'success'}), /output.text/));
