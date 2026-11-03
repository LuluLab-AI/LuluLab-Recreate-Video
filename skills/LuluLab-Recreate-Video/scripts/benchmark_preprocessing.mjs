#!/usr/bin/env node
/** Fail-closed preprocessing of the exact benchmark analysis window. */
import {spawnSync} from 'node:child_process';
import {lookup} from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import {isIP} from 'node:net';
import {createWriteStream} from 'node:fs';
import {mkdtemp, mkdir, readFile, rm, stat} from 'node:fs/promises';
import {dirname, join, resolve, basename} from 'node:path';
import {homedir} from 'node:os';
import {promisify} from 'node:util';
import {pipeline} from 'node:stream/promises';
import {CompressionError, DEFAULT_MAX_BYTES, prepareBenchmarkVideo, resolveFfmpeg} from './compress_benchmark_video.mjs';

export const DOWNLOAD_MAX_BYTES = 512_000_000;
export const DOWNLOAD_TIMEOUT_MS = 120_000;
export const MAX_REDIRECTS = 3;
const expand = p => resolve(String(p).replace(/^~(?=\/|$)/, homedir()));

export function analysisWindow(config, sourceDuration) {
  if (!Number.isFinite(sourceDuration) || sourceDuration <= 0 || sourceDuration > 360)
    throw new CompressionError('原视频真实时长必须为 0～360 秒。');
  const mode = config.durationMode ?? 'source', target = config.duration;
  if (mode === 'source') {
    if (target != null && (typeof target !== 'number' || !Number.isFinite(target) ||
      Math.abs(target - sourceDuration) > 0.5))
      throw new CompressionError('source 模式目标时长与原始媒体差异超过0.5秒，请重新执行技术分析。');
    return sourceDuration;
  }
  if (mode !== 'custom') throw new CompressionError('durationMode 必须是 source 或 custom。');
  const requested = config.requestedDuration ?? target;
  if (!Number.isInteger(requested) || requested <= 0)
    throw new CompressionError('custom 模式必须提供正整数分析时长。');
  if (target != null && target !== requested)
    throw new CompressionError('custom 模式的 duration 与 requestedDuration 不一致。');
  if (requested > sourceDuration)
    throw new CompressionError('自定义复刻时长超过原视频真实时长；不得静默延长。');
  return requested;
}
function command(binary, args, timeoutMs, message) {
  const result = spawnSync(binary, args, {encoding: 'utf8', timeout: timeoutMs, maxBuffer: 20_000_000});
  if (result.error || result.status !== 0) throw new CompressionError(message);
  return result.stdout;
}
export async function probeVideo(path) {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || !info.size) throw new CompressionError('视频不存在或为空。');
  try {
    const data = JSON.parse(command('ffprobe', ['-v', 'error', '-show_streams', '-show_format',
      '-of', 'json', path], 60_000, 'ffprobe failed'));
    const video = data.streams.find(s => s.codec_type === 'video');
    const audio = data.streams.find(s => s.codec_type === 'audio');
    const duration = Number(video.duration || data.format.duration);
    const [n, d] = String(video.avg_frame_rate || '0/1').split('/').map(Number);
    const fps = d ? n / d : 0;
    const audioDuration = audio ? Number(audio.duration || data.format.duration) : null;
    if (!Number.isFinite(duration) || duration <= 0 || Number(video.width) <= 0 ||
      Number(video.height) <= 0 || (audio && (!Number.isFinite(audioDuration) || audioDuration <= 0)))
      throw Error('invalid media');
    let rotation = Number(video.tags?.rotate || 0);
    for (const side of video.side_data_list ?? []) rotation = Number(side.rotation ?? rotation);
    const [sarN, sarD] = String(video.sample_aspect_ratio || '1:1').split(':').map(Number);
    let aspect = Number(video.width) / Number(video.height);
    if (sarN > 0 && sarD > 0) aspect *= sarN / sarD;
    if (Math.floor(Math.abs(rotation)) % 180 === 90) aspect = 1 / aspect;
    return {duration, fps, audioDuration, aspect, container: data.format.format_name || '',
      videoCodec: video.codec_name || null, audioCodec: audio?.codec_name || null};
  } catch {throw new CompressionError(`ffprobe 无法解析有效视频/音频流：${basename(path)}`);}
}
function publicIPv4(ip) {
  const parts = ip.split('.').map(Number);
  const n = ((parts[0] * 2 ** 24) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
  const blocked = [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
    ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
    ['224.0.0.0', 4], ['240.0.0.0', 4],
  ];
  return !blocked.some(([start, prefix]) => {
    const x = start.split('.').map(Number), base = ((x[0] * 2 ** 24) + (x[1] << 16) + (x[2] << 8) + x[3]) >>> 0;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (n & mask) === (base & mask);
  });
}
export async function publicEndpoint(rawUrl) {
  let url;
  try {url = new URL(rawUrl);} catch {throw new CompressionError('视频直链必须为无凭据的 HTTP/HTTPS URL。');}
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password)
    throw new CompressionError('视频直链必须为无凭据的 HTTP/HTTPS URL。');
  if (isIP(url.hostname) && (isIP(url.hostname) !== 4 || !publicIPv4(url.hostname)))
    throw new CompressionError('视频直链禁止本地、内网、云元数据地址或无法解析的主机。');
  let timer;
  try {
    const addresses = await Promise.race([lookup(url.hostname, {all: true}),
      new Promise((_, reject) => {timer = setTimeout(() => reject(Error('DNS timeout')), 15000);})]);
    // IPv6 is deliberately rejected until a full global-range validator is available.
    if (!addresses.length || addresses.some(({address}) => isIP(address) !== 4 || !publicIPv4(address)))
      throw Error('non-public address');
    return {url, address: addresses[0].address, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80))};
  } catch {throw new CompressionError('视频直链禁止本地、内网、云元数据地址或无法解析的主机。');}
  finally {clearTimeout(timer);}
}
async function requestPinned(rawUrl, timeoutMs) {
  const {url, address, port} = await publicEndpoint(rawUrl);
  return new Promise((resolveResponse, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(url, {method: 'GET', headers: {'Accept-Encoding': 'identity'},
      agent: false, timeout: timeoutMs, lookup: (_host, _options, callback) => callback(null, address, 4),
      port, servername: url.hostname}, response => resolveResponse(response));
    request.on('timeout', () => request.destroy(new CompressionError('视频直链连接超时。')));
    request.on('error', reject);
    request.end();
  });
}
export async function downloadVideo(rawUrl, destination) {
  const deadline = Date.now() + DOWNLOAD_TIMEOUT_MS;
  let url = rawUrl;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new CompressionError('视频直链下载超时。');
      const response = await requestPinned(url, Math.min(15000, remaining));
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const location = response.headers.location;
        response.destroy();
        if (!location || hop === MAX_REDIRECTS) throw new CompressionError('视频直链重定向超过限制或缺少目标。');
        url = new URL(location, url).href;
        continue;
      }
      if (response.statusCode !== 200) {response.destroy(); throw new CompressionError(`视频直链下载失败：HTTP ${response.statusCode}。`);}
      const length = response.headers['content-length'] == null ? null : Number(response.headers['content-length']);
      if (length != null && (!Number.isSafeInteger(length) || length < 0 || length > DOWNLOAD_MAX_BYTES)) {
        response.destroy(); throw new CompressionError('视频直链文件超过 512 MB 下载限制。');
      }
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > DOWNLOAD_MAX_BYTES || Date.now() > deadline) response.destroy(new CompressionError(
          size > DOWNLOAD_MAX_BYTES ? '视频直链文件超过 512 MB 下载限制。' : '视频直链下载超时。'));
      });
      await pipeline(response, createWriteStream(destination));
      if (!size || (length != null && size !== length)) throw new CompressionError('视频直链下载为空或不完整。');
      return;
    }
  } catch (error) {
    await rm(destination, {force: true});
    if (error instanceof CompressionError) throw error;
    throw new CompressionError('视频直链下载失败。');
  }
}
export async function transcodePrefix(source, output, duration) {
  const ffmpeg = await resolveFfmpeg();
  command(ffmpeg, ['-v', 'error', '-nostdin', '-y', '-i', source, '-t', String(duration),
    '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart', output], 3_600_000, 'FFmpeg 精确裁剪失败；禁止提交原视频。');
}
export async function validateVideo(path, source, expected, {maxBytes = null, decode = false,
  transcoded = false} = {}) {
  const info = await probeVideo(path);
  const tolerance = source.fps > 0 ? Math.max(0.1, 2 / source.fps) : 0.1;
  if (Math.abs(info.duration - expected) > tolerance) throw new CompressionError('预处理视频真实时长不符合分析区间。');
  if (Math.abs(info.aspect / source.aspect - 1) > 0.02) throw new CompressionError('预处理视频方向或画面比例发生变化。');
  if (source.audioDuration != null && (info.audioDuration == null ||
    Math.abs(info.audioDuration - Math.min(source.audioDuration, expected)) > Math.max(tolerance, 0.25)))
    throw new CompressionError('预处理视频音轨丢失或音频时长异常。');
  if (transcoded && (info.videoCodec !== 'h264' || (info.audioDuration != null && info.audioCodec !== 'aac')))
    throw new CompressionError('预处理视频必须采用 H.264/AAC。');
  if (maxBytes != null && (await stat(path)).size > maxBytes) throw new CompressionError('预处理视频超过上传大小限制。');
  if (decode) command(await resolveFfmpeg(), ['-v', 'error', '-xerror', '-nostdin', '-i', path,
    '-map', '0:v:0', '-map', '0:a:0?', '-f', 'null', '-'], 3_600_000, '预处理视频画面或音频无法完整解码。');
  return info;
}
export async function withPreparedAnalysisVideo(config, directory, {benchmark = null, url = null} = {}, use) {
  await mkdir(directory, {recursive: true});
  const work = await mkdtemp(join(directory, 'benchmark-'));
  try {
    let source = benchmark ? expand(benchmark) : join(work, 'download.mp4');
    if (url) {source = join(work, 'download.mp4'); await downloadVideo(url, source);}
    const original = await probeVideo(source), expected = analysisWindow(config, original.duration);
    const trimmed = expected < original.duration;
    let candidate = source;
    if (trimmed) {
      candidate = join(work, 'prefix.mp4'); await transcodePrefix(source, candidate, expected);
      await validateVideo(candidate, original, expected, {transcoded: true});
    }
    if (!trimmed && !original.container.includes('mp4')) {
      candidate = join(work, 'normalized.mp4'); await transcodePrefix(source, candidate, expected);
    }
    const prepared = await prepareBenchmarkVideo(candidate, {outputDir: work});
    const output = prepared.filePath;
    const info = await validateVideo(output, original, expected, {maxBytes: DEFAULT_MAX_BYTES,
      decode: true, transcoded: candidate !== source || prepared.compressed});
    const direct = Boolean(url && !trimmed && !prepared.compressed && !prepared.normalized && candidate === source);
    const result = {...prepared, sourceDuration: original.duration, analysisDuration: info.duration,
      trimmed, directUrl: direct ? url : null};
    return await use(result);
  } finally {await rm(work, {recursive: true, force: true});}
}
