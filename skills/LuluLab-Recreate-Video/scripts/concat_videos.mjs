#!/usr/bin/env node
/** Normalize successful Segment videos and concatenate in timeline order. */
import { mkdir, realpath, rm, stat, rename } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandSetFinal, loadManifest } from './generation_manifest.mjs';
import { findOnPath } from '../utils/ffmpeg.mjs';

const expand = value => String(value).startsWith('~/') ? resolve(homedir(), String(value).slice(2)) : resolve(String(value));

export async function orderedSegments(manifest) {
  const rawSegments = manifest.videos ?? manifest.segments ?? {};
  if (!rawSegments || (Array.isArray(rawSegments) ? !rawSegments.length : !Object.keys(rawSegments).length))
    throw new Error('Manifest has no video segments');
  const entries = Array.isArray(rawSegments) ? rawSegments.map(entry => [entry.segmentId, entry]) : Object.entries(rawSegments);
  const ordered = [];
  for (const [rawId, entry] of entries) {
    const segmentId = Number(rawId);
    if (!Number.isInteger(segmentId)) throw new Error(`Invalid Segment id: ${rawId}`);
    if (entry.status !== 'success') throw new Error(`Segment ${segmentId} is not successful`);
    if (!entry.output_file) throw new Error(`Segment ${segmentId} has no output_file`);
    const path = expand(entry.output_file), info = await stat(path).catch(() => null);
    if (!info?.isFile() || !info.size) throw new Error(`Segment ${segmentId} output is missing or empty: ${path}`);
    ordered.push([segmentId, await realpath(path)]);
  }
  ordered.sort((a, b) => a[0] - b[0]);
  return ordered;
}

export function buildFilter(inputCount) {
  if (inputCount < 1) throw new Error('At least one Segment is required');
  const filters = [], concatInputs = [];
  for (let index = 0; index < inputCount; index++) {
    filters.push(`[${index}:v]scale=720:1280:force_original_aspect_ratio=decrease,` +
      `pad=720:1280:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p,setpts=PTS-STARTPTS[v${index}]`);
    filters.push(`[${index}:a]aresample=48000,` +
      `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${index}]`);
    concatInputs.push(`[v${index}][a${index}]`);
  }
  filters.push(`${concatInputs.join('')}concat=n=${inputCount}:v=1:a=1[outv][outa]`);
  return filters.join(';');
}

export async function render(inputs, output, ffmpeg) {
  output = expand(output);
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.tmp.mp4`;
  if (inputs.includes(output) || inputs.includes(temporary))
    throw new Error('Final output must not overwrite a Segment input');
  const args = ['-y'];
  for (const path of inputs) args.push('-i', String(path));
  args.push('-filter_complex', buildFilter(inputs.length), '-map', '[outv]', '-map', '[outa]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', temporary);
  try {
    const run = spawnSync(ffmpeg, args, { encoding: 'utf8' });
    if (run.status !== 0) throw new Error(`ffmpeg concatenation failed: ${(run.stderr || '').slice(-1000)}`);
    if (!(await stat(temporary).catch(() => null))?.size) throw new Error('ffmpeg produced an empty final video');
    await rename(temporary, output);
  } finally { await rm(temporary, { force: true }); }
}

export async function concatenate(manifestPath, output, ffmpeg = 'ffmpeg') {
  const executable = ffmpeg.includes('/') || ffmpeg.includes('\\') ? ffmpeg :
    await findOnPath(ffmpeg) || ((await stat(join(homedir(), '.local', 'bin', ffmpeg)).catch(() => null))?.isFile()
      ? join(homedir(), '.local', 'bin', ffmpeg) : null);
  if (!executable) throw new Error('FFmpeg is required for final concatenation');
  const manifest = await loadManifest(manifestPath);
  const ordered = await orderedSegments(manifest), target = expand(output);
  await render(ordered.map(([, path]) => path), target, executable);
  await commandSetFinal({ manifest: manifestPath, outputFile: target,
    segmentIds: ordered.map(([id]) => id) });
  return { ok: true, output: target, segment_order: ordered.map(([id]) => id) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const value = flag => { const index = process.argv.indexOf(flag); return index < 0 ? null : process.argv[index + 1]; };
  const manifest = value('--manifest'), output = value('--output');
  if (!manifest || !output) { console.error('usage: node scripts/concat_videos.mjs --manifest <file> --output <file> [--ffmpeg <path>]'); process.exitCode = 2; }
  else {
    try { console.log(JSON.stringify(await concatenate(manifest, output, value('--ffmpeg') || 'ffmpeg'))); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
