#!/usr/bin/env node
/** Compress oversized upload videos and images below the byte limit. */
import { access, mkdir, mkdtemp, readdir, realpath, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findFfmpeg } from '../utils/ffmpeg.mjs';

export const DEFAULT_MAX_BYTES = 20_000_000;
export const IMAGE_SUFFIXES = new Set(['.avif', '.jpeg', '.jpg', '.png', '.webp']);
const budgetFactors = [0.90, 0.78, 0.66, 0.54];
const expand = value => String(value).startsWith('~/') ? resolve(homedir(), String(value).slice(2)) : resolve(String(value));
const info = async value => stat(value).catch(() => null);

export class CompressionError extends Error {}

export async function resolveFfmpeg(value) {
  const candidate = value != null ? expand(value) : await findFfmpeg() || join(homedir(), '.local', 'bin', 'ffmpeg');
  if (!(await info(candidate))?.isFile() || !(await access(candidate, constants.X_OK).then(() => true).catch(() => false)))
    throw new CompressionError('视频预处理未找到可执行的 FFmpeg。');
  return realpath(candidate);
}

function run(command, { runner, timeout = 3_600_000 } = {}) {
  try {
    const result = runner ? runner(command, { timeout }) : spawnSync(command[0], command.slice(1),
      { encoding: 'utf8', timeout });
    if (result.error?.code === 'ETIMEDOUT') throw new CompressionError('对标视频压缩超时。');
    if (result.error) throw new CompressionError(`无法运行 FFmpeg：${result.error.message}`);
    return result;
  } catch (error) {
    if (error instanceof CompressionError) throw error;
    throw new CompressionError(`无法运行 FFmpeg：${error.message}`);
  }
}

export function probeDuration(source, ffmpeg, { runner } = {}) {
  const result = run([ffmpeg, '-hide_banner', '-i', source], { runner, timeout: 60_000 });
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(`${result.stderr || ''}\n${result.stdout || ''}`);
  if (!match) throw new CompressionError('无法读取对标视频时长。');
  const duration = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  if (duration <= 0) throw new CompressionError('对标视频时长必须大于 0。');
  return duration;
}

async function availableOutput(source, outputDir, suffix = '.mp4') {
  await mkdir(outputDir, { recursive: true });
  const stem = basename(source, extname(source));
  const requested = join(outputDir, `${stem}-under-20mb${suffix}`);
  let candidate = requested, version = 2;
  while (await info(candidate)) {
    candidate = join(outputDir, `${basename(requested, suffix)}-v${version}${suffix}`);
    version++;
  }
  return candidate;
}

async function clearPasslog(prefix) {
  for (const name of await readdir(dirname(prefix)).catch(() => [])) {
    if (!name.startsWith(basename(prefix))) continue;
    const path = join(dirname(prefix), name);
    if ((await info(path))?.isFile()) await rm(path, { force: true });
  }
}

export async function prepareBenchmarkVideo(filePath, { outputDir, maxBytes = DEFAULT_MAX_BYTES,
  ffmpegPath, runner } = {}) {
  const source = expand(filePath), sourceInfo = await info(source);
  if (!sourceInfo?.isFile() || !sourceInfo.size) throw new CompressionError(`对标视频不存在或为空：${source}`);
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new CompressionError('max_bytes 必须是正整数。');
  const originalBytes = sourceInfo.size, normalizeContainer = extname(source).toLowerCase() !== '.mp4';
  if (originalBytes <= maxBytes && !normalizeContainer)
    return { filePath: await realpath(source), compressed: false, normalized: false,
      originalBytes, uploadBytes: originalBytes, maxBytes };
  const ffmpeg = await resolveFfmpeg(ffmpegPath);
  const directory = outputDir ? expand(outputDir) : join(tmpdir(), 'recreate-video-agent', 'benchmark-uploads');
  await mkdir(directory, { recursive: true });
  const workDir = await mkdtemp(join(directory, 'compress-'));
  if (normalizeContainer && originalBytes <= maxBytes) {
    const normalized = await availableOutput(source, workDir);
    const remux = run([ffmpeg, '-y', '-i', source, '-map', '0:v:0', '-map', '0:a?', '-c', 'copy',
      '-movflags', '+faststart', normalized], { runner });
    const uploadBytes = (await info(normalized))?.size || 0;
    if (remux.status === 0 && uploadBytes > 0 && uploadBytes <= maxBytes)
      return { filePath: normalized, compressed: false, normalized: true,
        originalBytes, uploadBytes, maxBytes };
    await rm(normalized, { force: true });
  }
  const duration = probeDuration(source, ffmpeg, { runner });
  const output = await availableOutput(source, workDir);
  const passlog = join(dirname(output), `${basename(output, '.mp4')}-passlog`);
  let lastError = 'FFmpeg 未生成有效文件。';
  try {
    for (const factor of budgetFactors) {
      const targetBits = Math.max(96_000, Math.trunc(maxBytes * factor * 8 / duration));
      const audioBits = Math.min(96_000, Math.max(32_000, Math.floor(targetBits / 8)));
      const videoBits = Math.max(48_000, targetBits - audioBits - 16_000);
      const common = [ffmpeg, '-y', '-i', source, '-map', '0:v:0', '-c:v', 'libx264',
        '-preset', 'medium', '-b:v', String(videoBits), '-pix_fmt', 'yuv420p', '-passlogfile', passlog];
      const first = run([...common, '-pass', '1', '-an', '-f', 'null', process.platform === 'win32' ? 'NUL' : '/dev/null'], { runner });
      if (first.status !== 0) { lastError = (first.stderr || 'FFmpeg 第一遍编码失败。').slice(-1000); continue; }
      const second = run([...common, '-pass', '2', '-map', '0:a?', '-c:a', 'aac',
        '-b:a', String(audioBits), '-movflags', '+faststart', output], { runner });
      if (second.status !== 0) {
        lastError = (second.stderr || 'FFmpeg 第二遍编码失败。').slice(-1000);
        await rm(output, { force: true }); continue;
      }
      const uploadBytes = (await info(output))?.size || 0;
      if (uploadBytes > 0 && uploadBytes <= maxBytes)
        return { filePath: output, compressed: true, normalized: normalizeContainer,
          originalBytes, uploadBytes, maxBytes };
      lastError = `压缩后仍为 ${uploadBytes} 字节，超过 ${maxBytes} 字节。`;
      await rm(output, { force: true });
    }
  } finally { await clearPasslog(passlog); }
  await rm(output, { force: true });
  throw new CompressionError(`无法将对标视频压缩到 ${maxBytes} 字节以内：${lastError}`);
}

export async function prepareUploadImage(filePath, { outputDir, maxBytes = DEFAULT_MAX_BYTES,
  ffmpegPath, runner } = {}) {
  const source = expand(filePath), sourceInfo = await info(source);
  if (!sourceInfo?.isFile() || !sourceInfo.size) throw new CompressionError(`上传图片不存在或为空：${source}`);
  if (!IMAGE_SUFFIXES.has(extname(source).toLowerCase()))
    throw new CompressionError(`不支持压缩此图片格式：${extname(source) || '无扩展名'}`);
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new CompressionError('max_bytes 必须是正整数。');
  const originalBytes = sourceInfo.size;
  if (originalBytes <= maxBytes)
    return { filePath: await realpath(source), compressed: false, originalBytes,
      uploadBytes: originalBytes, maxBytes };
  const ffmpeg = await resolveFfmpeg(ffmpegPath);
  const directory = outputDir ? expand(outputDir) : join(tmpdir(), 'recreate-video-agent', 'image-uploads');
  const output = await availableOutput(source, directory, '.jpg');
  let lastError = 'FFmpeg 未生成有效文件。';
  for (const [maxEdge, quality] of [[4096, 3], [3072, 5], [2560, 7], [2048, 9], [1536, 12], [1024, 16]]) {
    const result = run([ffmpeg, '-y', '-i', source, '-map', '0:v:0', '-frames:v', '1', '-vf',
      `scale=${maxEdge}:${maxEdge}:force_original_aspect_ratio=decrease`, '-q:v', String(quality), output],
    { runner, timeout: 600_000 });
    if (result.status !== 0) {
      lastError = (result.stderr || 'FFmpeg 图片压缩失败。').slice(-1000);
      await rm(output, { force: true }); continue;
    }
    const uploadBytes = (await info(output))?.size || 0;
    if (uploadBytes > 0 && uploadBytes <= maxBytes)
      return { filePath: output, compressed: true, originalBytes, uploadBytes, maxBytes };
    lastError = `压缩后仍为 ${uploadBytes} 字节，超过 ${maxBytes} 字节。`;
    await rm(output, { force: true });
  }
  throw new CompressionError(`无法将上传图片压缩到 ${maxBytes} 字节以内：${lastError}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), source = args.find(arg => !arg.startsWith('--'));
  const value = flag => { const index = args.indexOf(flag); return index < 0 ? null : args[index + 1]; };
  if (!source) { console.error('usage: node scripts/compress_benchmark_video.mjs <file> [--output-dir <dir>] [--max-bytes <bytes>] [--ffmpeg <path>]'); process.exitCode = 2; }
  else {
    try { console.log(JSON.stringify(await prepareBenchmarkVideo(source, {
      outputDir: value('--output-dir'), maxBytes: value('--max-bytes') ? Number(value('--max-bytes')) : DEFAULT_MAX_BYTES,
      ffmpegPath: value('--ffmpeg'),
    }))); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
