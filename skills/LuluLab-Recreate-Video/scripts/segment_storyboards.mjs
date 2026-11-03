#!/usr/bin/env node
/** Compose legacy generation-only 3×3 segment boards with local timestamps. */
import {spawnSync} from 'node:child_process';
import {readFile, mkdir, stat, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {findFfmpeg, findOnPath} from '../utils/ffmpeg.mjs';
import {dimensions} from './storyboard_cells.mjs';

const fields = ['productPresent', 'productVisibility', 'productCount', 'personPresent', 'personExtent', 'personCount', 'creatorIds', 'interactionState'];
const expand = p => resolve(String(p).replace(/^~(?=\/|$)/, homedir()));
function run(command) {
  const result = spawnSync(command[0], command.slice(1), {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
  if (result.error || result.status !== 0) throw Error(String(result.error?.message ?? result.stderr ?? '段内 Storyboard 处理失败。').slice(-2000));
  return result.stdout;
}
export async function normalizeSegment(raw) {
  const id = Number(raw.segmentId), start = Number(raw.globalStart), end = Number(raw.globalEnd);
  if (!Number.isInteger(id) || id < 1 || !Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    throw Error(`Segment ${id} globalEnd 必须大于 globalStart。`);
  if (!Array.isArray(raw.cells) || raw.cells.length !== 9) throw Error(`Segment ${id} 必须且只能提供9个编辑后画格。`);
  const cells = []; let previous = -1;
  for (const [offset, item] of raw.cells.entries()) {
    const file = expand(item.file), info = await stat(file).catch(() => null);
    if (!info?.isFile() || !info.size) throw Error(`Segment ${id} 画格不存在或为空：${file}`);
    const timestamp = Number(item.globalTimestamp);
    if (!Number.isFinite(timestamp) || timestamp < start - .01 || timestamp > end + .01)
      throw Error(`Segment ${id} 画格 ${offset + 1} 超出 ${start.toFixed(2)}-${end.toFixed(2)}s。`);
    if (timestamp < previous) throw Error(`Segment ${id} 画格必须按全局时间升序排列。`);
    previous = timestamp;
    const cell = {index: offset + 1, file, globalTimestamp: timestamp,
      localTimestamp: Math.round((timestamp - start) * 1000) / 1000,
      anchorRole: String(item.anchorRole ?? 'context'), eventType: String(item.eventType ?? 'context')};
    for (const field of fields) {
      if (field === 'creatorIds') cell.creatorIds = (item.creatorIds ?? []).map(String);
      else if (field in item) cell[field] = item[field];
    }
    cells.push(cell);
  }
  if (Math.abs(cells[0].globalTimestamp - start) > .05) throw Error(`Segment ${id} 第一格必须是段起点，误差不得超过0.05秒。`);
  const labelHeight = Number(raw.labelHeight ?? 38);
  if (!Number.isInteger(labelHeight)) throw Error('labelHeight必须是整数。');
  return {segmentId: id, globalStart: start, globalEnd: end, duration: end - start,
    replacementVerified: Boolean(raw.replacementVerified), replacement: raw.replacement && typeof raw.replacement === 'object' && !Array.isArray(raw.replacement) ? raw.replacement : null,
    labelHeight, cells};
}
export async function render(segment, output, ffmpeg, ffprobe) {
  const cells = segment.cells, [width, height] = dimensions(ffprobe, cells[0].file, ffmpeg), labelHeight = segment.labelHeight;
  if (labelHeight < 1 || labelHeight >= height) throw Error('labelHeight必须小于画格高度。');
  const frameHeight = height - labelHeight, command = [ffmpeg, '-v', 'error', '-y'];
  for (const cell of cells) command.push('-i', cell.file);
  const filters = [], labels = [];
  for (let i = 0; i < 9; i++) {
    const label = `c${i}`, text = `${String(i + 1).padStart(2, '0')} · ${cells[i].localTimestamp.toFixed(2)}s`;
    filters.push(`[${i}:v]crop=${width}:${frameHeight}:0:0,scale=${width}:${frameHeight}:force_original_aspect_ratio=decrease,pad=${width}:${frameHeight}:(ow-iw)/2:(oh-ih)/2:black,pad=${width}:${height}:0:0:black,drawtext=text='${text}':x=8:y=${frameHeight + 7}:fontsize=20:fontcolor=white,drawbox=x=0:y=0:w=iw:h=ih:color=white@0.55:t=1[${label}]`);
    labels.push(`[${label}]`);
  }
  const layout = Array.from({length: 9}, (_, i) => `${(i % 3) * width}_${Math.floor(i / 3) * height}`).join('|');
  filters.push(`${labels.join('')}xstack=inputs=9:layout=${layout}[out]`);
  await mkdir(dirname(output), {recursive: true});
  run([...command, '-filter_complex', filters.join(';'), '-map', '[out]', '-frames:v', '1', output]);
  const info = await stat(output).catch(() => null);
  if (!info?.isFile() || !info.size) throw Error(`未生成段内 Storyboard：${output}`);
  const anchors = cells.map(cell => Object.fromEntries(['index','globalTimestamp','localTimestamp','anchorRole','eventType',...fields]
    .filter(key => key in cell).map(key => [key, cell[key]])));
  const result = {storyboardId: segment.segmentId, segmentId: segment.segmentId, file: resolve(output), layout: '3x3',
    globalStart: segment.globalStart, globalEnd: segment.globalEnd, localStart: 0, localEnd: segment.duration,
    replacementVerified: segment.replacementVerified, labelHeight, anchors};
  if (segment.replacement) result.replacement = segment.replacement;
  return result;
}
export async function build(plan, outputDir, ffmpeg, ffprobe) {
  if (!Array.isArray(plan?.segments) || !plan.segments.length) throw Error('plan 缺少非空 segments。');
  const segments = await Promise.all(plan.segments.map(normalizeSegment));
  segments.sort((a, b) => a.segmentId - b.segmentId);
  let cursor = 0; const boards = [];
  for (const segment of segments) {
    if (Math.abs(segment.globalStart - cursor) > .01) throw Error('Segment 全局时间轴必须从0开始并连续、无重叠、无空档。');
    boards.push(await render(segment, join(outputDir, `segment-${String(segment.segmentId).padStart(2, '0')}-storyboard-3x3.png`), ffmpeg, ffprobe));
    cursor = segment.globalEnd;
  }
  return {schemaRevision: '5.1', layout: '3x3', boards, totalDuration: cursor};
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const opts = {}, args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) opts[args[i]?.replace(/^--/, '')] = args[i + 1];
  try {
    if (!opts.plan || !opts['output-dir']) throw Error('--plan 和 --output-dir 必填');
    const ffmpeg = opts.ffmpeg ?? await findFfmpeg(), ffprobe = opts.ffprobe ?? await findOnPath('ffprobe');
    if (!ffmpeg) throw Error('当前环境缺少 ffmpeg。');
    const outputDir = expand(opts['output-dir']);
    const result = await build(JSON.parse(await readFile(expand(opts.plan), 'utf8')), outputDir, ffmpeg, ffprobe);
    const metadata = join(outputDir, 'segment-storyboard-metadata.json');
    await writeFile(metadata, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ok: true, metadata, ...result}));
  } catch (error) {console.error(error.message); process.exitCode = 1;}
}
