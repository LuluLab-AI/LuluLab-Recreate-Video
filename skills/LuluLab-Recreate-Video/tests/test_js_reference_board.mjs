import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from '../scripts/reference_board.mjs';
import { findFfmpeg, requireFfmpeg } from '../utils/ffmpeg.mjs';

test('FFmpeg discovery respects PATH', async () => {
  assert.ok((await findFfmpeg())?.endsWith('/ffmpeg'));
  assert.equal(await findFfmpeg({ PATH: '' }), null);
  await assert.rejects(requireFfmpeg({ PATH: '' }), /not found on PATH/);
});

test('reference board preserves image order in a 2-column grid', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lululab-reference-board-'));
  try {
    const images = ['red', 'blue'].map(color => join(dir, `${color}.png`));
    for (const [index, color] of ['red', 'blue'].entries()) {
      const run = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
        '-i', `color=c=${color}:s=32x32:d=1`, '-frames:v', '1', images[index]]);
      assert.equal(run.status, 0);
    }
    const output = join(dir, 'board.png');
    assert.equal(await render(images, output), output);
    assert.ok((await stat(output)).size > 0);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'csv=p=0', output], { encoding: 'utf8' });
    assert.equal(probe.stdout.trim(), '1024,512');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
