import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from '../scripts/host_preflight.mjs';
import { exportPrompts, registeredSegments } from '../scripts/export_prompt_texts.mjs';
import { inspect as inspectVideoCli } from '../scripts/video_cli_preflight.mjs';
import { verifyKey } from '../scripts/lululab_key_preflight.mjs';
import { render } from '../scripts/render_captions.mjs';
import { spawnSync } from 'node:child_process';

test('host preflight checks installed CLI and media tools', async () => {
  const result = await inspect();
  assert.equal(result.checks.node, true);
  assert.equal(result.checks.cliExecution, true);
  assert.equal(result.checks.fileReadWrite, true);
  assert.equal(result.checks.ffmpeg, true);
  assert.equal(result.checks.ffprobe, true);
});

test('prompt export writes exact registered text', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lululab-prompts-'));
  try {
    const manifest = join(dir, 'manifest.json');
    await writeFile(manifest, JSON.stringify({ videoPrompts: { segments: [
      { segmentId: 3, title: '三', duration: 10, prompt: '镜头一\n测试' },
    ] } }));
    const result = await exportPrompts(manifest);
    assert.equal(result.segments[0].characters, 6);
    assert.equal(await readFile(join(dir, 'prompts', 'segment-03-prompt.txt'), 'utf8'), '镜头一\n测试');
    await assert.rejects(registeredSegments({ videoPrompts: { segments: [{}] } }, manifest), /prompt/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('video preflight reads a v4 manifest and verifies bundled CLI capabilities', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lululab-video-preflight-'));
  try {
    const manifest = join(dir, 'manifest.json');
    await writeFile(manifest, JSON.stringify({ version: 4, userConfig: { videoModel: 'seedance-2-mini' } }));
    const result = await inspectVideoCli(manifest);
    assert.equal(result.model, 'seedance-2-mini');
    assert.equal(result.selected, 'lululab_cli');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('key preflight uses credits endpoint without submitting a task', async () => {
  const paths = [];
  const result = await verifyKey({ apiKey: 'test', baseUrl: 'http://localhost',
    fetchImpl: async url => { paths.push(new URL(url).pathname); return new Response(JSON.stringify({ total: 0, items: [] }),
      { status: 200, headers: { 'content-type': 'application/json' } }); } });
  assert.equal(result.authenticated, true);
  assert.deepEqual(paths, ['/credits']);
});

test('caption renderer keeps clean source and writes a separate MP4', async t => {
  const filters = spawnSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' });
  if (!/^\s*[.A-Z|]{3}\s+ass\s/m.test(filters.stdout || '')) {
    t.skip('installed FFmpeg lacks the libass filter');
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), 'lululab-captions-'));
  try {
    const input = join(dir, 'clean.mp4'), ass = join(dir, 'captions.ass'), output = join(dir, 'captioned.mp4');
    const source = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
      '-i', 'color=c=black:s=320x240:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', input]);
    assert.equal(source.status, 0);
    await writeFile(ass, '[Script Info]\nScriptType: v4.00+\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,24,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,Hello\n');
    const result = await render(input, ass, output);
    assert.equal(result.ok, true);
    assert.ok((await readFile(output)).length > 0);
    assert.ok((await readFile(input)).length > 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
