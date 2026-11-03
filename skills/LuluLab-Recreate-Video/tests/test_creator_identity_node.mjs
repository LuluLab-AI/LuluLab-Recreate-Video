import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {run, buildPrompt, creatorProfile} from '../scripts/creator_identity.mjs';

test('creator identity creates once and registers after review', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lululab-creator-node-'));
  try {
    const manifest = join(root, 'manifest.json');
    await writeFile(manifest, JSON.stringify({version: 4, creator: {mode: 'ai_generated',
      targetCreatorIds: ['creator-main']}, userConfig: {targetCountry: 'Portugal'}, creators: [], videos: []}));
    let calls = 0;
    const generate = async args => {
      calls++;
      await mkdir(join(root, 'creators'), {recursive: true});
      await writeFile(args.output, 'mock-image');
      await writeFile(args.report, JSON.stringify({status: 'success', taskId: 'image-task-1'}));
      return {code: 0, report: {status: 'success', taskId: 'image-task-1'}};
    };
    const options = {generate, inspect: async () => ({width: 1024, height: 1024,
      panelWidth: 512, panelHeight: 512, semanticReviewRequired: true})};
    const first = await run(manifest, 'creator-main', 'presenter', options);
    assert.equal(first.status, 'ready_for_review'); assert.equal(calls, 1);
    const reviewed = await run(manifest, 'creator-main', 'presenter', {...options, registerReviewed: true});
    assert.equal(reviewed.status, 'ready'); assert.equal(calls, 1);
    const saved = JSON.parse(await readFile(manifest, 'utf8'));
    assert.equal(saved.creators[0].sourceType, 'ai_generated');
    assert.deepEqual(saved.creators[0].views, ['back', 'close_up', 'front', 'side_profile']);
    assert.match(buildPrompt(creatorProfile(saved), 'presenter'), /Portugal/);
  } finally {await rm(root, {recursive: true, force: true});}
});

test('creator identity blocks changed settings before another paid image', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lululab-creator-node-'));
  try {
    const manifest = join(root, 'manifest.json');
    await writeFile(manifest, JSON.stringify({version: 4, creator: {mode: 'ai_generated',
      targetCreatorIds: ['creator-main']}, videos: []}));
    const generate = async args => {
      await writeFile(args.report, JSON.stringify({status: 'poll_unknown', taskId: 'image-task-1'}));
      return {code: 3, report: {status: 'poll_unknown', taskId: 'image-task-1'}};
    };
    await run(manifest, 'creator-main', 'presenter', {generate});
    const saved = JSON.parse(await readFile(manifest, 'utf8'));
    saved.creator.vibe = 'professional'; await writeFile(manifest, JSON.stringify(saved));
    await assert.rejects(() => run(manifest, 'creator-main', 'presenter', {generate}), /设定或模板已变化/);
  } finally {await rm(root, {recursive: true, force: true});}
});
