#!/usr/bin/env node
/** Compose product identity images into one deterministic reference board. */
import { mkdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { findFfmpeg } from '../utils/ffmpeg.mjs';

export async function render(images, output, ffmpeg) {
  if (!images.length) throw new Error('产品身份板至少需要一张图片。');
  const local = join(homedir(), '.local', 'bin', 'ffmpeg');
  const discovered = await findFfmpeg();
  const executable = ffmpeg || discovered || ((await stat(local).catch(() => null))?.isFile() ? local : null);
  if (!executable) throw new Error('当前环境缺少 ffmpeg。');
  const columns = Math.min(3, Math.ceil(Math.sqrt(images.length)));
  const command = ['-y'];
  for (const image of images) command.push('-i', String(image));
  const filters = [], labels = [];
  for (let index = 0; index < images.length; index++) {
    const label = `i${index}`;
    filters.push(`[${index}:v]scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:white[${label}]`);
    labels.push(`[${label}]`);
  }
  const layout = images.map((_, index) => `${(index % columns) * 512}_${Math.floor(index / columns) * 512}`).join('|');
  filters.push(`${labels.join('')}xstack=inputs=${images.length}:layout=${layout}[out]`);
  output = resolve(output);
  await mkdir(dirname(output), { recursive: true });
  command.push('-filter_complex', filters.join(';'), '-map', '[out]', '-frames:v', '1', output);
  const result = spawnSync(executable, command, { encoding: 'utf8' });
  if (result.status !== 0 || !(await stat(output).catch(() => null))?.size)
    throw new Error((result.stderr || '').slice(-2000) || '产品身份板生成失败。');
  return output;
}
