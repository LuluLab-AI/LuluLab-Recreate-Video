#!/usr/bin/env node
/** Extract real frames and compose one 3×3 or 4×4 board per Segment. */
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readFile, writeFile, mkdir, rename, stat} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {minimumSegmentCount, validateGeneration} from './model_capabilities.mjs';
import {findFfmpeg} from '../utils/ffmpeg.mjs';

const expand = p => resolve(String(p).replace(/^~(?=\/|$)/, homedir()));
const exists = async p => {const s = await stat(p).catch(() => null); return Boolean(s?.isFile() && s.size);};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const stable = x => Array.isArray(x) ? x.map(stable) : x && typeof x === 'object' ?
  Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)])) : x;
const roles = new Set(['hard', 'soft', 'context']);
const events = new Set(['first_frame', 'continuity_start', 'cut', 'hook', 'product_first',
  'action_start', 'action_process', 'action_end', 'product_state', 'before', 'after', 'proof', 'cta', 'context']);
const states = new Set(['none', 'partial', 'full']);
function presence(item, presentKey, stateKey, countKey, inferred = false) {
  const present = item[presentKey] ?? inferred;
  if (typeof present !== 'boolean') throw Error(`anchor.${presentKey} 必须是布尔值。`);
  const state = String(item[stateKey] ?? (present ? 'full' : 'none'));
  if (!states.has(state)) throw Error(`anchor.${stateKey} 必须是 none、partial 或 full。`);
  const count = item[countKey] ?? (present ? 1 : 0);
  if (!Number.isInteger(count) || count < 0) throw Error(`anchor.${countKey} 必须是非负整数。`);
  if (!present && (state !== 'none' || count !== 0)) throw Error(`anchor.${presentKey}=false 时 ${stateKey}=none 且 ${countKey}=0。`);
  if (present && (state === 'none' || count < 1)) throw Error(`anchor.${presentKey}=true 时必须有可见状态且 ${countKey}≥1。`);
  return [present, state, count];
}
export function normalizeAnchor(value, index) {
  const item = value && typeof value === 'object' && !Array.isArray(value) ? value : {timestamp: value};
  const timestamp = item.timestamp ?? item.time;
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp < 0)
    throw Error(`无效时间戳：${timestamp}`);
  const role = String(item.anchorRole ?? (index === 0 ? 'hard' : 'soft'));
  const event = String(item.eventType ?? (index === 0 ? 'first_frame' : 'context'));
  if (!roles.has(role)) throw Error(`无效 anchorRole：${role}`);
  if (!events.has(event)) throw Error(`无效 eventType：${event}`);
  const semanticSource = String(item.semanticSource ?? 'observed');
  if (!['observed', 'unobserved'].includes(semanticSource)) throw Error('anchor.semanticSource 必须是 observed 或 unobserved。');
  if (!Array.isArray(item.creatorIds ?? [])) throw Error('anchor.creatorIds 必须是数组。');
  const creators = item.creatorIds ?? [];
  const [productPresent, productVisibility, productCount] = presence(item, 'productPresent', 'productVisibility', 'productCount');
  const [personPresent, personExtent, personCount] = presence(item, 'personPresent', 'personExtent', 'personCount', creators.length > 0);
  return {timestamp, shotId: item.shotId ?? '', anchorRole: role, eventType: event,
    productPresent, productVisibility, productCount, personPresent, personExtent, personCount,
    creatorIds: creators.map(String), interactionState: String(item.interactionState ?? ''), semanticSource};
}
export function normalizeSegment(raw, expectedId) {
  const id = Number(raw.segmentId ?? expectedId);
  if (id !== expectedId) throw Error('Segment ID 必须从1开始连续递增。');
  const start = Number(raw.globalStart), end = Number(raw.globalEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    throw Error(`Segment ${id} globalEnd 必须大于 globalStart。`);
  if (!Array.isArray(raw.anchors) || ![9, 16].includes(raw.anchors.length))
    throw Error(`Segment ${id} 必须包含9或16个anchors。`);
  const anchors = raw.anchors.map(normalizeAnchor), timestamps = anchors.map(x => x.timestamp);
  if (timestamps.some((x, i) => i > 0 && timestamps[i - 1] >= x))
    throw Error(`Segment ${id} anchors必须按时间严格升序排列，不得重复。`);
  if (timestamps.some(x => x < start - .01 || x >= end)) throw Error(`Segment ${id} anchor超出自身时间窗。`);
  if (Math.abs(timestamps[0] - start) > .05) throw Error(`Segment ${id} 第一格必须是分段起点。`);
  if (anchors[0].anchorRole !== 'hard') throw Error(`Segment ${id} 第一格必须标记为hard。`);
  if (id === 1 ? anchors[0].eventType !== 'first_frame' :
    !['cut', 'continuity_start'].includes(anchors[0].eventType))
    throw Error(`Segment ${id} 第一格事件类型无效。`);
  return {segmentId: id, globalStart: start, globalEnd: end, duration: end - start, anchors};
}
export async function loadAnchorPayload(path) {
  const text = await readFile(expand(path), 'utf8');
  try {return JSON.parse(text);} catch {}
  const values = [];
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim(); if (!value) continue;
    const number = Number(value);
    if (!Number.isFinite(number)) throw Error(`时间戳文件必须是JSON，或每行一个数字；无法解析：${value}`);
    values.push({timestamp: number, productPresent: true, personPresent: true});
  }
  if (!values.length) throw Error('时间戳文件为空。');
  return values;
}
export async function parseSegmentPlan(path, {mediaDuration = null} = {}) {
  const raw = await loadAnchorPayload(path);
  let segments;
  if (raw && typeof raw === 'object' && Array.isArray(raw.segments))
    segments = raw.segments.map((item, index) => normalizeSegment(item, index + 1));
  else {
    const values = raw && !Array.isArray(raw) ? raw.anchors ?? raw.timestamps : raw;
    if (!Array.isArray(values) || !values.length || values.length % 9)
      throw Error('输入必须含segments，或提供9的整数倍数量的anchors/timestamps。');
    const normalized = values.map(normalizeAnchor); segments = [];
    for (let offset = 0; offset < normalized.length; offset += 9) {
      const anchors = normalized.slice(offset, offset + 9), id = offset / 9 + 1;
      const start = anchors[0].timestamp, end = normalized[offset + 9]?.timestamp ?? Number(mediaDuration || anchors.at(-1).timestamp);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
        throw Error('旧版anchors无法推导有效Segment时间窗；请改用segments格式。');
      if (id > 1 && anchors[0].eventType === 'first_frame') anchors[0].eventType = 'continuity_start';
      segments.push(normalizeSegment({segmentId: id, globalStart: start, globalEnd: end, anchors}, id));
    }
  }
  if (!segments.length) throw Error('segments不能为空。');
  let cursor = 0;
  for (const segment of segments) {
    if (Math.abs(segment.globalStart - cursor) > .01) throw Error('Segment时间窗必须从0开始并连续、无重叠、无空档。');
    cursor = segment.globalEnd;
  }
  return segments;
}
export async function parseAnchorPlan(path) {return (await parseSegmentPlan(path)).flatMap(x => x.anchors);}
export async function parseTimestamps(path) {return (await parseAnchorPlan(path)).map(x => x.timestamp);}
export function validateAgainstAnalysis(segmentsOrAnchors, analysis) {
  const anchors = segmentsOrAnchors[0]?.anchors ? segmentsOrAnchors.flatMap(x => x.anchors) : segmentsOrAnchors;
  const cuts = (analysis.candidateCuts ?? []).map(Number);
  for (const anchor of anchors) if (anchor.eventType === 'cut' && cuts.length &&
    Math.min(...cuts.map(cut => Math.abs(anchor.timestamp - cut))) > .25)
    throw Error(`切镜锚点 ${anchor.timestamp.toFixed(2)}s 距候选切镜超过0.25秒。`);
  const duration = Number(analysis.targetDuration || analysis.media?.duration || 0);
  if (duration && anchors.at(-1).timestamp < duration * .9)
    throw Error('最后一个锚点早于复刻区间90%位置，可能遗漏末段Proof/CTA。');
}
export function validateModelWindows(segments, model) {
  const total = segments.at(-1).globalEnd;
  if (!Number.isInteger(total)) throw Error('目标总时长必须是模型支持的整数秒；不得静默取整。');
  for (const segment of segments) validateGeneration(model, segment.duration);
  const expected = minimumSegmentCount(model, total);
  if (segments.length !== expected) throw Error(`当前模型与目标时长必须使用最少${expected}个Segment，实际为${segments.length}。`);
}
function ffmpegRun(command) {
  const result = spawnSync(command[0], command.slice(1), {encoding: 'utf8', maxBuffer: 10_000_000});
  if (result.error || result.status !== 0) throw Error((result.stderr || result.error?.message || '视频帧处理失败。').slice(-2000));
}
export async function resolveFfmpeg(candidate = 'ffmpeg') {
  const paths = [candidate, join(homedir(), '.local', 'bin', 'ffmpeg'), await findFfmpeg()].filter(Boolean);
  for (const value of new Set(paths)) {
    const result = spawnSync(value, ['-hide_banner', '-filters'], {encoding: 'utf8'});
    if (result.status === 0 && result.stdout.split('\n').some(line => /\sdrawtext\s/.test(line))) return value;
  }
  throw Error('当前环境没有带 drawtext 滤镜的 ffmpeg，无法渲染Storyboard时间标签。');
}
export function boardFingerprint(videoSha256, segment, cellWidth, cellHeight) {
  return sha(JSON.stringify(stable({videoSha256, segmentId: segment.segmentId,
    globalStart: segment.globalStart, globalEnd: segment.globalEnd, anchors: segment.anchors,
    cellWidth, cellHeight, renderer: 'storyboard-3x3-v2'})));
}
export async function renderBoard(ffmpeg, video, anchors, output, cellWidth, cellHeight) {
  const command = [ffmpeg, '-y'];
  for (const anchor of anchors) command.push('-ss', anchor.timestamp.toFixed(3), '-i', video);
  const frameHeight = Math.max(1, cellHeight - 38), filters = [], labels = [];
  anchors.forEach((anchor, index) => {
    const label = `v${index}`; labels.push(`[${label}]`);
    const caption = `${String(index + 1).padStart(2, '0')} · ${anchor.timestamp.toFixed(2)}s`
      .replaceAll(':', '\\:').replaceAll("'", "\\'");
    filters.push(`[${index}:v]scale=${cellWidth}:${frameHeight}:force_original_aspect_ratio=decrease,` +
      `pad=${cellWidth}:${frameHeight}:(ow-iw)/2:(oh-ih)/2:black,` +
      `pad=${cellWidth}:${cellHeight}:0:0:black,` +
      `drawtext=text='${caption}':x=8:y=${frameHeight + 7}:fontsize=20:fontcolor=white,` +
      `drawbox=x=0:y=0:w=iw:h=ih:color=white@0.55:t=1[${label}]`);
  });
  const side = Math.sqrt(anchors.length), layout = anchors.map((_, index) =>
    `${(index % side) * cellWidth}_${Math.floor(index / side) * cellHeight}`).join('|');
  filters.push(`${labels.join('')}xstack=inputs=${anchors.length}:layout=${layout}[board]`);
  await mkdir(dirname(output), {recursive: true});
  command.push('-filter_complex', filters.join(';'), '-map', '[board]', '-frames:v', '1',
    '-compression_level', '3', output);
  ffmpegRun(command);
  if (!await exists(output)) throw Error(`未生成Storyboard：${output}`);
}
export async function renderOrReuse(ffmpeg, video, videoSha256, segment, output, cellWidth, cellHeight,
  {force = false} = {}) {
  const cache = output.replace(/\.[^.]+$/, '.cache.json');
  const fingerprint = boardFingerprint(videoSha256, segment, cellWidth, cellHeight);
  if (!force && await exists(output) && await exists(cache)) try {
    const record = JSON.parse(await readFile(cache, 'utf8'));
    if (record.inputSha256 === fingerprint && record.outputSha256 === sha(await readFile(output))) return true;
  } catch {}
  await renderBoard(ffmpeg, video, segment.anchors, output, cellWidth, cellHeight);
  await writeFile(`${cache}.tmp`, JSON.stringify({inputSha256: fingerprint,
    outputSha256: sha(await readFile(output))}, null, 2) + '\n');
  await rename(`${cache}.tmp`, cache);
  return false;
}
async function runLimited(items, limit, fn) {
  let cursor = 0; const result = [];
  await Promise.all(Array.from({length: Math.min(items.length, limit)}, async () => {
    while (cursor < items.length) {const index = cursor++; result.push(await fn(items[index]));}
  }));
  return result;
}
export async function build({video, timestampsFile, outputDir, cellWidth = 240, cellHeight = 464,
  ffmpeg = 'ffmpeg', analysisFile = null, model = 'seedance-2-fast', maxWorkers = 0,
  segmentIds = [], streamReady = false, forceRender = false, onReady = null} = {}) {
  const source = expand(video), output = expand(outputDir);
  if (!await exists(source)) throw Error(`对标视频不存在或为空：${source}`);
  const executable = await resolveFfmpeg(ffmpeg);
  const analysis = analysisFile ? JSON.parse(await readFile(expand(analysisFile), 'utf8')) : {};
  const mediaDuration = Number(analysis.targetDuration || analysis.media?.duration || 0) || null;
  const segments = await parseSegmentPlan(timestampsFile, {mediaDuration});
  validateModelWindows(segments, model);
  if (Object.keys(analysis).length) validateAgainstAnalysis(segments, analysis);
  const wanted = new Set(segmentIds.map(Number));
  if (wanted.size !== segmentIds.length || [...wanted].some(x => !segments.some(s => s.segmentId === x)))
    throw Error('--segment-id 包含重复或不存在的 Segment ID。');
  const selected = wanted.size ? segments.filter(x => wanted.has(x.segmentId)) : segments;
  const workers = maxWorkers || Math.min(5, segments.length);
  if (workers < 1 || workers > 5) throw Error('--max-workers 必须介于1和5之间，或使用0采用默认并行度。');
  const videoDigest = sha(await readFile(source));
  const boards = await runLimited(selected, workers, async segment => {
    const id = segment.segmentId, side = Math.sqrt(segment.anchors.length);
    const boardPath = join(output, `segment-${String(id).padStart(2, '0')}-storyboard-${side}x${side}.png`);
    const reused = await renderOrReuse(executable, source, videoDigest, segment, boardPath,
      cellWidth, cellHeight, {force: forceRender});
    const board = {storyboardId: id, segmentId: id, file: boardPath, layout: `${side}x${side}`,
      reused, globalStart: segment.globalStart, globalEnd: segment.globalEnd,
      duration: segment.duration, anchors: segment.anchors};
    if (streamReady) {
      const metadata = join(output, `segment-${String(id).padStart(2, '0')}-storyboard-metadata.json`);
      await writeFile(metadata, JSON.stringify({schemaRevision: '5.1', layout: '3x3', boards: [board],
        totalDuration: board.globalEnd}, null, 2) + '\n');
      const event = {event: 'storyboard_ready', segmentId: id, metadata, board};
      if (onReady) onReady(event); else console.log(JSON.stringify(event));
    }
    return board;
  });
  boards.sort((a, b) => a.segmentId - b.segmentId);
  const metadata = join(output, 'storyboard-metadata.json');
  await writeFile(metadata, JSON.stringify({schemaRevision: '5.1', layout: '3x3', boards,
    totalDuration: selected.at(-1).globalEnd}, null, 2) + '\n');
  return {ok: true, layout: '3x3', outputs: boards.map(x => x.file), metadata, boards};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), option = name => args[args.indexOf(name) + 1], ids = [];
    for (let i = 0; i < args.length; i++) if (args[i] === '--segment-id') ids.push(Number(args[i + 1]));
    console.log(JSON.stringify(await build({video: option('--video'), timestampsFile: option('--timestamps-file'),
      outputDir: option('--output-dir'), cellWidth: Number(option('--cell-width') || 240),
      cellHeight: Number(option('--cell-height') || 464), ffmpeg: option('--ffmpeg') || 'ffmpeg',
      analysisFile: option('--analysis-file'), model: option('--model') || 'seedance-2-fast',
      maxWorkers: Number(option('--max-workers') || 0), segmentIds: ids,
      streamReady: args.includes('--stream-ready'), forceRender: args.includes('--force-render')})));
  } catch (error) {console.error(error.message); process.exitCode = 1;}
}
