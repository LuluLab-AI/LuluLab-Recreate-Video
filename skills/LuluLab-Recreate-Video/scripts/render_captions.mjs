#!/usr/bin/env node
/** Render an ASS subtitle layer onto a clean MP4 without regenerating it. */
import { copyFile, mkdtemp, mkdir, rename, rm, stat, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const expand = path => path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
async function nonemptyFile(path) { return (await stat(path).catch(() => null))?.size > 0; }

export async function render(inputVideo, assFile, outputVideo, ffmpeg = 'ffmpeg') {
  inputVideo = resolve(expand(inputVideo));
  assFile = resolve(expand(assFile));
  outputVideo = resolve(expand(outputVideo));
  if (!await nonemptyFile(inputVideo)) throw new Error(`Clean video is missing or empty: ${inputVideo}`);
  if (!await nonemptyFile(assFile)) throw new Error(`ASS file is missing or empty: ${assFile}`);
  if (extname(assFile).toLowerCase() !== '.ass') throw new Error('Subtitle source must be an .ass file');
  if (outputVideo === inputVideo) throw new Error('Captioned output must not overwrite the clean video');
  if (extname(outputVideo).toLowerCase() !== '.mp4') throw new Error('Captioned output must use .mp4');
  await mkdir(dirname(outputVideo), { recursive: true });
  const assets = await mkdtemp(join(tmpdir(), 'caption-assets-'));
  const temporary = join(dirname(outputVideo), `.${basename(outputVideo, '.mp4')}-${process.pid}-${Date.now()}.mp4`);
  try {
    await symlink(inputVideo, join(assets, 'input.mp4'));
    await copyFile(assFile, join(assets, 'captions.ass'));
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', 'input.mp4',
      '-map', '0:v:0', '-map', '0:a?', '-vf', 'ass=filename=captions.ass', '-c:v', 'libx264',
      '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'copy',
      '-movflags', '+faststart', temporary];
    const run = spawnSync(ffmpeg, args, { cwd: assets, encoding: 'utf8' });
    if (run.error?.code === 'ENOENT') throw new Error(`FFmpeg is unavailable: ${ffmpeg}`);
    if (run.status !== 0) throw new Error(`Subtitle rendering failed: ${(run.stderr || '').slice(-1200)}`);
    if (!await nonemptyFile(temporary)) throw new Error('FFmpeg produced no captioned video');
    await rename(temporary, outputVideo);
    return { ok: true, output: outputVideo };
  } finally {
    await rm(temporary, { force: true });
    await rm(assets, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const value = flag => {
    const index = process.argv.indexOf(flag);
    return index < 0 ? null : process.argv[index + 1];
  };
  const input = value('--input'), ass = value('--ass'), output = value('--output');
  if (!input || !ass || !output) {
    console.error('usage: node scripts/render_captions.mjs --input <video> --ass <subtitles.ass> --output <video.mp4> [--ffmpeg <path>]');
    process.exitCode = 2;
  } else {
    try { console.log(JSON.stringify(await render(input, ass, output, value('--ffmpeg') || 'ffmpeg'))); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
