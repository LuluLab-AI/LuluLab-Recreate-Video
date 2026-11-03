import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('prompt module uploads missing local media once and reuses its cached URL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lululab-prompt-upload-'));
  try {
    const cli = join(dir, 'mock-cli.mjs'), calls = join(dir, 'calls.txt');
    await writeFile(cli, `import fs from 'node:fs';
fs.appendFileSync(process.env.TEST_CALLS, process.argv.slice(2).join(' ') + '\\n');
if (process.argv[2] === 'user') console.log(JSON.stringify({balance:0}));
else if (process.argv[2] === 'upload') console.log(JSON.stringify({output:{media:{url:'https://example.com/board.png',expiredAt:'tomorrow'}}}));
else process.exit(1);
`);
    const image = join(dir, 'board.png'), manifest = join(dir, 'manifest.json');
    await writeFile(image, 'image-bytes');
    await writeFile(manifest, JSON.stringify({ version: '4', taskId: 'task-1',
      benchmarkVideo: { analysis: { recommendedSegments: [{ segmentId: 1, duration: 10 }] } },
      storyboards: { generation: [{ segmentId: 1, file: image }] },
      videoPrompts: { segments: [{ segmentId: 1, duration: 10, prompt: '完整提示词' }] } }));
    const script = resolve('scripts/recreate_prompt_module.mjs');
    const env = { ...process.env, LULULAB_CLI: cli, LULULAB_API_KEY: 'test', TEST_CALLS: calls };
    for (let i = 0; i < 2; i++) {
      const run = spawnSync(process.execPath, [script, 'export', '--manifest', manifest, '--upload-missing'],
        { env, encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      const result = JSON.parse(run.stdout);
      assert.equal(result.output.segments[0].targetStoryboard.url, 'https://example.com/board.png');
      assert.equal(result.output.segments[0].targetStoryboard.mimeType, 'image/png');
      assert.equal(result.status, 'completed');
    }
    const log = await readFile(calls, 'utf8');
    assert.equal(log.split('\n').filter(line => line.startsWith('upload ')).length, 1);
    assert.equal(log.split('\n').filter(line => line.startsWith('user ')).length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
