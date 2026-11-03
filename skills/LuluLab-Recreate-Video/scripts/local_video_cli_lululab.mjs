#!/usr/bin/env node
/** LuluLab media task helpers shared by the Node.js image pipeline. */
import { createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, stat, rename, unlink, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { LuluLabClient, resolveApiKey } from './lululab_cli.mjs';
import { publicError, raiseIfAuthorizationUnavailable, sanitizePayload } from './service_privacy.mjs';

export const IMAGE_MODEL = 'gpt-image-2-5-sunburst';
export const IMAGE_RESOLUTION = '1K';
export const IMAGE_WORKFLOW = 'ImageGenV2';
export class TaskFailedError extends Error {
  constructor(taskId, state, message, response) {
    super(message); this.taskId = taskId; this.state = state; this.response = response;
  }
}
const pending = new Set(['created', 'pending', 'processing', 'running', 'queued', 'submitted', 'generating', 'querying']);
const success = new Set(['succeeded', 'success', 'completed', 'complete']);
const failed = new Set(['failed', 'failure', 'fail', 'error', 'cancelled', 'canceled', 'timeout', 'timed_out']);
const expand = value => resolve(String(value).replace(/^~(?=\/|$)/, homedir()));
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const validUrl = value => { try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !!u.hostname; } catch { return false; } };

export async function client() {
  return new LuluLabClient({apiKey: await resolveApiKey(), baseUrl: process.env.LULULAB_API_BASE_URL || 'https://customer.lululab.ai'});
}
export function imageWorkflowId() {
  const id = (process.env.LULULAB_IMAGE_WORKFLOW_ID || IMAGE_WORKFLOW).trim();
  if (!id) throw Error('图片 workflow ID 不能为空。');
  return id;
}
export async function submitImage(prompt, referenceFiles = [], aspectRatio = '9:16', api = null) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw Error('图片 Prompt 不能为空。');
  if (referenceFiles.length > 9) throw Error('参考图不能超过 9 张。');
  const c = api || await client();
  const referenceImages = [];
  for (const file of referenceFiles) referenceImages.push(await c.upload(expand(file)));
  const response = await c.submit(imageWorkflowId(), {
    model: IMAGE_MODEL, prompt: prompt.trim(), resolution: IMAGE_RESOLUTION,
    aspectRatio, referenceImages,
  });
  const id = response?.id ?? response?.taskId;
  if (typeof id !== 'string' || !id.trim()) throw Error('submit 响应缺少 id。');
  return id.trim();
}
export async function uploadReferenceImages(files, {api = null, cachePath = null, maxConcurrency = 1,
  fetchImpl = globalThis.fetch} = {}) {
  if (!files.length) return [];
  const c = api || await client();
  let cache = {};
  if (cachePath) try {cache = JSON.parse(await readFile(cachePath, 'utf8'));} catch {}
  const unique = new Map(), ordered = [];
  for (const file of files) {
    const path = expand(file), digest = createHash('sha256').update(await readFile(path)).digest('hex');
    if (!unique.has(digest)) unique.set(digest, path);
    ordered.push(digest);
  }
  const resolved = new Map(), entries = [...unique.entries()];
  let cursor = 0;
  async function worker() {
    while (cursor < entries.length) {
      const [digest, path] = entries[cursor++];
      let entry = cache[digest], valid = false;
      if (entry && typeof entry.url === 'string' && entry.url.startsWith('https://')) {
        const expires = Date.parse(entry.expiredAt || '');
        if (Number.isFinite(expires) && expires - Date.now() > 300000) valid = true;
        else if (!entry.expiredAt) {
          try {const head = await fetchImpl(entry.url, {method: 'HEAD', signal: AbortSignal.timeout(10000)});
            valid = head.status >= 200 && head.status < 400;} catch {}
        }
      }
      if (!valid) entry = await c.upload(path);
      resolved.set(digest, entry);
    }
  }
  await Promise.all(Array.from({length: Math.max(1, Math.min(8, maxConcurrency, entries.length))}, worker));
  if (cachePath) {
    await mkdir(dirname(cachePath), {recursive: true});
    await writeFile(`${cachePath}.tmp`, JSON.stringify({...cache, ...Object.fromEntries(resolved)}));
    await rename(`${cachePath}.tmp`, cachePath);
  }
  return ordered.map(digest => resolved.get(digest));
}
export async function submitVideo(model, prompt, duration, {referenceFiles = [], referenceMedia = null,
  aspectRatio = '9:16', resolution = '720p', api = null} = {}) {
  const {validateGeneration} = await import('./model_capabilities.mjs');
  if (typeof prompt !== 'string' || !prompt.trim()) throw Error('视频 Prompt 不能为空。');
  const checked = validateGeneration(model, duration, resolution);
  if (referenceFiles.length > checked.maxImages) throw Error(`参考图超过模型上限 ${checked.maxImages}。`);
  if (referenceMedia && referenceMedia.length !== referenceFiles.length)
    throw Error('预上传媒体数量与参考图数量不一致。');
  const c = api || await client();
  const media = referenceMedia ?? await uploadReferenceImages(referenceFiles, {api: c});
  const workflow = (process.env.LULULAB_VIDEO_WORKFLOW_ID || 'VideoGenV2').trim();
  const response = await c.submit(workflow, {model: checked.model, prompt: prompt.trim(),
    duration: checked.duration, aspectRatio, resolution, referenceImages: media});
  const id = response?.id ?? response?.taskId;
  if (typeof id !== 'string' || !id.trim()) throw Error('submit 响应缺少 id。');
  return id.trim();
}
export function taskState(value) {
  const queue = [value];
  while (queue.length) {
    const item = queue.shift();
    if (object(item)) {
      const state = item.status || item.state || item.gen_status || item.task_status;
      if (typeof state === 'string' && state.trim()) return state.trim().toLowerCase();
      queue.push(...Object.values(item).filter(x => object(x) || Array.isArray(x)));
    } else if (Array.isArray(item)) queue.push(...item);
  }
  return '';
}
export function media(value, defaultMime = 'video/mp4') {
  const queue = [value];
  while (queue.length) {
    const item = queue.shift();
    if (typeof item === 'string' && validUrl(item)) return {url: item, mimeType: defaultMime, expiredAt: ''};
    if (object(item)) {
      const url = ['url', 'downloadUrl', 'outputUrl', 'video_url', 'media_url', 'result_url']
        .map(key => item[key]).find(validUrl) || (item.urls || item.resultUrls || []).find?.(validUrl);
      if (url) return {url, mimeType: item.mimeType || defaultMime, expiredAt: item.expiredAt || item.expiresAt || ''};
      queue.push(...Object.values(item).filter(x => object(x) || Array.isArray(x)));
    } else if (Array.isArray(item)) queue.push(...item);
  }
  throw Error('fetch 响应缺少有效媒体 URL。');
}
export async function pollTask(fetchTask, taskId, {intervalMs = 5000, timeoutMs = 3600000} = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fetchTask(taskId), state = taskState(value);
    if (success.has(state)) return value;
    if (failed.has(state)) {
      raiseIfAuthorizationUnavailable(value);
      const detail = [value, value?.data, value?.result, value?.output].filter(object)
        .flatMap(x => ['message', 'error', 'errorMessage', 'detail', 'failMsg', 'fail_reason'].map(k => x[k]))
        .find(x => typeof x === 'string' && x.trim()) || '任务失败。';
      throw new TaskFailedError(taskId, state, publicError(detail.slice(0, 1000), '任务失败。'), sanitizePayload(value));
    }
    if (!state) { media(value); return value; }
    if (!pending.has(state)) throw Error(`未知任务状态：${state}`);
    const left = deadline - Date.now();
    if (left <= 0) throw Error(`任务 ${taskId} 轮询超时。`);
    await new Promise(done => setTimeout(done, Math.min(intervalMs, left)));
  }
}
export async function downloadMedia(mediaValue, outputPath, {fetchImpl = globalThis.fetch} = {}) {
  const url = typeof mediaValue === 'string' ? mediaValue : mediaValue?.url;
  if (!validUrl(url)) throw Error('下载结果缺少有效媒体 URL。');
  const requested = expand(outputPath);
  await mkdir(dirname(requested), {recursive: true});
  let destination = requested, version = 2;
  while (await stat(destination).then(() => true, () => false)) {
    destination = join(dirname(requested), `${basename(requested, extname(requested))}-v${version++}${extname(requested)}`);
  }
  const temporary = `${destination}.part`;
  try {
    const response = await fetchImpl(url, {headers: {'User-Agent': 'LuluLab-Recreate-Video/local'}, redirect: 'error'});
    if (!response.ok || !response.body) throw Error(`媒体下载 HTTP ${response.status}。`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
    if (!(await stat(temporary)).size) throw Error('下载的媒体文件为空。');
    await rename(temporary, destination);
    return destination;
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw Error(`无法下载媒体结果：${error.message}`);
  }
}
