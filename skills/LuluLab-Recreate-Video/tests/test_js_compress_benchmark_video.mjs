import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareBenchmarkVideo, prepareUploadImage, probeDuration } from '../scripts/compress_benchmark_video.mjs';

test('small MP4 passes through while a small MOV is remuxed without overwriting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lululab-compress-'));
  try {
    const video = join(dir, 'source.mp4');
    const made = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
      '-i', 'color=c=red:s=160x240:d=0.5', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5',
      '-shortest', '-c:v', 'libx264', '-c:a', 'aac', video], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    const small = await prepareBenchmarkVideo(video);
    assert.equal(small.compressed, false);
    assert.equal(small.normalized, false);
    const mov = join(dir, 'source.mov');
    const remux = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', video,
      '-c', 'copy', mov], { encoding: 'utf8' });
    assert.equal(remux.status, 0, remux.stderr);
    const result = await prepareBenchmarkVideo(mov, { outputDir: dir });
    assert.equal(result.normalized, true);
    assert.equal(result.compressed, false);
    assert.ok((await stat(result.filePath)).size > 0);
    assert.ok((await stat(mov)).size > 0);
    assert.ok(probeDuration(video, 'ffmpeg') > 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('small upload image passes through and unsupported extensions fail', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lululab-image-compress-'));
  try {
    const image = join(dir, 'reference.png'), bad = join(dir, 'reference.txt');
    await writeFile(image, 'image-bytes'); await writeFile(bad, 'image-bytes');
    const result = await prepareUploadImage(image);
    assert.equal(result.compressed, false);
    await assert.rejects(prepareUploadImage(bad), /不支持压缩此图片格式/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('oversized benchmark is reduced below the requested byte limit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lululab-two-pass-'));
  try {
    const video = join(dir, 'noise.mp4');
    const made = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
      '-i', 'testsrc2=size=320x480:rate=30:duration=2', '-f', 'lavfi',
      '-i', 'sine=frequency=440:duration=2', '-shortest', '-c:v', 'libx264',
      '-crf', '10', '-c:a', 'aac', video], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    const originalBytes = (await stat(video)).size;
    assert.ok(originalBytes > 120_000);
    const result = await prepareBenchmarkVideo(video, { outputDir: dir, maxBytes: 120_000 });
    assert.equal(result.compressed, true);
    assert.ok(result.uploadBytes > 0 && result.uploadBytes <= 120_000);
    assert.equal((await stat(video)).size, originalBytes);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
