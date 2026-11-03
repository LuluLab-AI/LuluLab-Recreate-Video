import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepare} from '../scripts/prepare_prompt_handoff.mjs';

test('prompt handoff registers two target boards without changing pixels', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lululab-handoff-node-'));
  try {
    const manifest = join(root, 'manifest.json'), boards = [];
    for (const [id, start, end] of [[1, 0, 10], [2, 10, 18]]) {
      const file = join(root, `target-${id}.png`);
      await writeFile(file, `target-bytes-${id}`);
      boards.push({storyboardId: id, segmentId: id, file, globalStart: start, globalEnd: end,
        anchors: Array.from({length: 9}, (_, index) => ({index: index + 1,
          timestamp: start + (end - start) * index / 9, personPresent: false,
          personCount: 0, creatorIds: [], productPresent: false}))});
    }
    await writeFile(manifest, JSON.stringify({version: 4, skillVersion: '1.3.7',
      userConfig: {duration: 18}, benchmarkVideo: {analysis: {recommendedSegments: [
        {segmentId: 1, globalStart: 0, globalEnd: 10}, {segmentId: 2, globalStart: 10, globalEnd: 18}]}},
      storyboards: {original: boards, edited: boards, generation: []}, creators: [], videos: []}));
    const first = await prepare(manifest, join(root, 'handoff'));
    assert.equal(first.directReuse, true);
    const saved = JSON.parse(await readFile(manifest, 'utf8')).storyboards.generation;
    assert.deepEqual(saved.map(item => item.file), await Promise.all(boards.map(item => realpath(item.file))));
    assert.equal(saved[1].anchors[0].localTimestamp, 0);
    assert.equal((await readFile(boards[0].file, 'utf8')), 'target-bytes-1');
    const second = await prepare(manifest, join(root, 'handoff'));
    assert.equal(second.reused, true);
  } finally {await rm(root, {recursive: true, force: true});}
});
