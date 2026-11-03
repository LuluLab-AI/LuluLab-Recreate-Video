/** No-cost local technical analysis of a benchmark video. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { capability, normalizeModel, minimumSegmentCount } from './model_capabilities.mjs';
import { scanVideo, DEFAULT_CHANGE_THRESHOLD, DEFAULT_CUT_THRESHOLD, VISUAL_SCAN_VERSION } from './visual_scan.mjs';

export const MAX_BENCHMARK_DURATION_SECONDS = 360;
const PYTHON_BIGINT = '__PYTHON_BIGINT_';
const jsonText = (value, indent) => JSON.stringify(value, (_key, item) =>
  typeof item === 'bigint' ? `${PYTHON_BIGINT}${item}` : item, indent)
  .replace(new RegExp(`"${PYTHON_BIGINT}([0-9]+)"`, 'g'), '$1');
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' && typeof value !== 'bigint'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const expand = value => path.resolve(String(value).replace(/^~(?=\/|$)/, os.homedir()));

export function analysisCacheInput(video, model, durationMode, targetDuration, sceneThreshold,
  visualChangeThreshold = DEFAULT_CHANGE_THRESHOLD, visualScanFps = null) {
  const stat = fs.statSync(video, { bigint: true });
  return { video: String(video), size: Number(stat.size), mtimeNs: stat.mtimeNs,
    model: normalizeModel(model), durationMode, targetDuration, visualCutThreshold: sceneThreshold,
    visualChangeThreshold, visualScanFps, visualScanVersion: VISUAL_SCAN_VERSION };
}
export function analysisFingerprint(value) {
  return crypto.createHash('sha256').update(jsonText(sorted(value))).digest('hex');
}
export function loadCachedAnalysis(output, cacheInput) {
  if (!fs.existsSync(output) || !fs.statSync(output).isFile()) return null;
  let value;
  try { value = JSON.parse(fs.readFileSync(output, 'utf8')); } catch { return null; }
  if (!value || value.analysisFingerprint !== analysisFingerprint(cacheInput) ||
      jsonText(sorted(value.analysisInput)) !== jsonText(sorted({ ...cacheInput, mtimeNs: Number(cacheInput.mtimeNs) }))) return null;
  if (!value.media || Array.isArray(value.media) || !Array.isArray(value.recommendedSegments)) return null;
  return value;
}
export function validateBenchmarkDuration(duration) {
  const numeric = Number(duration);
  if (!Number.isFinite(numeric) || numeric <= 0) throw new Error('无法读取有效的对标视频时长。');
  if (numeric > MAX_BENCHMARK_DURATION_SECONDS) throw new Error(`对标视频时长${numeric.toFixed(3)}秒超过6分钟（360秒）上限，拒绝复刻；不能通过仅复刻开场或自定义较短时长绕过。`);
  return numeric;
}
export function run(command) {
  const result = spawnSync(command[0], command.slice(1), { encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}
export function probe(ffprobe, video, ffmpeg = null) {
  if (!ffprobe) {
    if (!ffmpeg) throw new Error('ffprobe不可用且未提供ffmpeg回退。');
    const result = run([ffmpeg, '-hide_banner', '-i', String(video)]), text = result.stderr || '';
    const duration = /Duration:\s*(\d+):(\d+):([0-9.]+)/.exec(text);
    const videoLine = /Video:\s*([^,]+).*?,\s*(\d{2,5})x(\d{2,5})/.exec(text);
    const audioLine = /Audio:\s*([^,]+).*?(\d{4,6}) Hz/.exec(text);
    if (!duration || !videoLine) throw new Error('无法从ffmpeg读取视频媒体信息。');
    const fps = /([0-9.]+)\s*fps/.exec(text);
    return { duration: Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]),
      width: Number(videoLine[2]), height: Number(videoLine[3]), frameRate: fps?.[1] || '',
      videoCodec: videoLine[1].trim(), hasAudio: Boolean(audioLine), audioCodec: audioLine?.[1].trim() || '',
      audioSampleRate: Number(audioLine?.[2] || 0) };
  }
  const result = run([ffprobe, '-v', 'error', '-show_format', '-show_streams', '-of', 'json', String(video)]);
  if (result.status) throw new Error(result.stderr?.slice(-2000) || 'ffprobe failed');
  const raw = JSON.parse(result.stdout), streams = raw.streams || [];
  const videoStream = streams.find(item => item.codec_type === 'video') || {};
  const audioStream = streams.find(item => item.codec_type === 'audio') || {};
  return { duration: Number(raw.format?.duration || videoStream.duration || 0),
    width: Number(videoStream.width || 0), height: Number(videoStream.height || 0),
    frameRate: videoStream.avg_frame_rate || '', videoCodec: videoStream.codec_name || '',
    hasAudio: Object.keys(audioStream).length > 0, audioCodec: audioStream.codec_name || '',
    audioSampleRate: Number(audioStream.sample_rate || 0) };
}
export async function analyze(ffmpeg, ffprobe, video, threshold = DEFAULT_CUT_THRESHOLD,
  { changeThreshold = DEFAULT_CHANGE_THRESHOLD, scanDuration = null, scanFps = null, media = null } = {}) {
  media = media || probe(ffprobe, video, ffmpeg);
  validateBenchmarkDuration(media.duration);
  const window = Math.min(Number(scanDuration || media.duration), Number(media.duration));
  const scan = await scanVideo(ffmpeg, video, { duration: window, fps: scanFps, changeThreshold, cutThreshold: threshold });
  return { media, candidateCuts: scan.candidateCuts, visualCandidates: scan.visualCandidates,
    visualScan: { version: scan.version, fps: scan.fps, width: scan.width, height: scan.height,
      sampleCount: scan.sampleCount, changeThreshold: scan.changeThreshold,
      cutThreshold: scan.cutThreshold, samples: scan.samples },
    audio: { present: media.hasAudio },
    note: '单次低清视觉扫描同时提供切镜候选、连续动作变化和清晰帧评分；不使用大模型选帧。' };
}
export function resolve(name, explicit, { required = true } = {}) {
  if (explicit) return explicit;
  const local = path.join(os.homedir(), '.local', 'bin', name);
  const found = (process.env.PATH || '').split(path.delimiter).map(dir => path.resolve(dir || '.', name))
    .find(candidate => { try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; } });
  const value = found || (fs.existsSync(local) && fs.statSync(local).isFile() ? local : null);
  if (!value && required) throw new Error(`当前环境缺少 ${name}。`);
  return value;
}
export function normalizedSourceDuration(duration, minimumDuration = 4) {
  const numeric = Number(duration);
  if (numeric < minimumDuration) throw new Error(`源视频总时长短于模型最短时长${minimumDuration}秒；不得静默延长。`);
  return Math.floor(numeric + 0.5);
}
export function resolveReplicationDuration(sourceDuration, model, durationMode = 'source', requestedDuration = null) {
  const limits = capability(model);
  if (!limits) throw new Error(`不支持的视频模型：${normalizeModel(model)}。`);
  const source = validateBenchmarkDuration(sourceDuration), minimum = Number(limits.minDuration);
  const mode = String(durationMode || 'source').trim().toLowerCase();
  if (!['source', 'custom'].includes(mode)) throw new Error('durationMode 必须是 source 或 custom。');
  let target, requested, sourceLabel;
  if (mode === 'source') {
    if (requestedDuration !== null) throw new Error('source 模式不得提供自定义时长。');
    target = normalizedSourceDuration(source, minimum); requested = null; sourceLabel = 'source_nearest_integer';
  } else {
    if (!Number.isInteger(requestedDuration) || requestedDuration <= 0) throw new Error('custom 模式必须提供正整数秒 requestedDuration。');
    if (requestedDuration > source) throw new Error(`自定义复刻时长${requestedDuration}秒超过原视频时长${source.toFixed(3)}秒。`);
    target = requestedDuration; requested = requestedDuration; sourceLabel = 'custom';
  }
  const count = minimumSegmentCount(model, target);
  if (target < minimum * count) throw new Error(`${normalizeModel(model)}无法用最少${count}个合法Segment覆盖${target}秒。`);
  return { durationMode: mode, requestedDuration: requested, targetDuration: target,
    targetDurationSource: sourceLabel, replicationWindow: { start: 0, end: target },
    durationAdjustmentSeconds: Math.round((target - source) * 1000) / 1000 };
}
export async function main(argv = process.argv.slice(2)) {
  const options = {};
  const flags = new Set(['duration-check-only']);
  const names = new Set(['video', 'output', 'duration-check-only', 'visual-cut-threshold',
    'visual-change-threshold', 'visual-scan-fps', 'scene-threshold', 'model', 'duration-mode',
    'target-duration', 'ffmpeg', 'ffprobe']);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || !names.has(key)) throw new Error(`未知参数：${argv[i]}`);
    options[key] = flags.has(key) ? true : argv[++i];
  }
  if (!options.video) throw new Error('必须提供 --video。');
  const video = expand(options.video);
  if (!fs.existsSync(video) || !fs.statSync(video).isFile() || fs.statSync(video).size <= 0) throw new Error(`对标视频不存在或为空：${video}`);
  const ffmpeg = resolve('ffmpeg', options.ffmpeg), ffprobe = resolve('ffprobe', options.ffprobe, { required: false });
  if (options['duration-check-only']) {
    const duration = validateBenchmarkDuration(probe(ffprobe, video, ffmpeg).duration);
    console.log(jsonText({ ok: true, video, duration, maximumDuration: MAX_BENCHMARK_DURATION_SECONDS }));
    return 0;
  }
  if (!options.output) throw new Error('完整分析必须提供 --output。');
  const output = expand(options.output), model = options.model || 'seedance-2-fast';
  const targetDuration = options['target-duration'] === undefined ? null : Number(options['target-duration']);
  const durationMode = options['duration-mode'] || (targetDuration !== null ? 'custom' : 'source');
  const cutThreshold = Number(options['scene-threshold'] ?? options['visual-cut-threshold'] ?? DEFAULT_CUT_THRESHOLD);
  const changeThreshold = Number(options['visual-change-threshold'] ?? DEFAULT_CHANGE_THRESHOLD);
  const scanFps = options['visual-scan-fps'] === undefined ? null : Number(options['visual-scan-fps']);
  const cacheInput = analysisCacheInput(video, model, durationMode, targetDuration, cutThreshold, changeThreshold, scanFps);
  const cached = loadCachedAnalysis(output, cacheInput);
  if (cached) { console.log(jsonText({ ok: true, output, reused: true, ...cached })); return 0; }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const started = performance.now(), media = probe(ffprobe, video, ffmpeg);
  const duration = resolveReplicationDuration(media.duration, model, durationMode, targetDuration);
  const value = await analyze(ffmpeg, ffprobe, video, cutThreshold,
    { changeThreshold, scanDuration: duration.targetDuration, scanFps, media });
  Object.assign(value, duration);
  value.sourceFile = video; value.recommendedSegments = []; value.analysisInput = cacheInput;
  value.analysisFingerprint = analysisFingerprint(cacheInput);
  value.stageTimings = { technicalAnalysisSeconds: Math.round((performance.now() - started)) / 1000 };
  fs.writeFileSync(output, `${jsonText(value, 2)}\n`);
  console.log(jsonText({ ok: true, output, reused: false, ...value }));
  return 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
