/** Convert local Whisper output into the existing audioReview manifest contract. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const DEFAULT_MLX_MODEL = 'onnx-community/whisper-large-v3-turbo';
export const DEFAULT_OPENAI_MODEL = 'onnx-community/whisper-small';
const round3 = value => Math.round(value * 1000) / 1000;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => {
  if (value == null || typeof value === 'boolean' || value === '') throw new Error('invalid timestamp');
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error('invalid timestamp');
  return number;
};

export function cleanSegments(result) {
  const cleaned = [];
  for (const raw of result.segments ?? []) {
    if (!isObject(raw)) continue;
    const text = String(raw.text ?? '').trim();
    if (!text) continue;
    let start, end;
    try { start = finite(raw.start); end = finite(raw.end); }
    catch { continue; }
    if (start < 0 || end <= start) continue;
    const segment = { id: cleaned.length + 1, start: round3(start), end: round3(end), text };
    const words = [];
    for (const word of Array.isArray(raw.words) ? raw.words : []) {
      if (!isObject(word) || !String(word.word ?? '').trim()) continue;
      let wordStart, wordEnd;
      try { wordStart = finite(word.start); wordEnd = finite(word.end); }
      catch { continue; }
      words.push({ start: round3(wordStart), end: round3(wordEnd), text: String(word.word).trim() });
    }
    if (words.length) segment.words = words;
    cleaned.push(segment);
  }
  return cleaned;
}

export function buildAudioReview(result, { video, backend, model }) {
  const segments = cleanSegments(result), speechDetected = segments.length > 0;
  return { audioReview: {
    status: speechDetected ? 'transcript_ready' : 'verified_no_speech',
    hasAudio: true, speechDetected, reviewMethod: `local_${backend}_whisper`,
    backend, model, language: String(result.language || 'unknown'), sourceVideo: String(video),
    text: segments.map(item => item.text).join(' '), segments, audioUploaded: false,
  } };
}

const expand = value => path.resolve(String(value).replace(/^~(?=\/|$)/, os.homedir()));
export function mediaHasAudio(video, ffprobe = 'ffprobe') {
  const result = spawnSync(ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-show_entries',
    'stream=index', '-of', 'json', String(video)], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status) throw new Error(result.stderr || 'ffprobe failed');
  return Boolean(JSON.parse(result.stdout || '{}').streams?.length);
}

export function decodeAudio(video, ffmpeg = 'ffmpeg') {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', String(video),
    '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1'], { maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status) throw new Error(result.stderr?.toString() || 'ffmpeg 音频解码失败。');
  if (result.stdout.length % 4) throw new Error('ffmpeg 返回不完整的 32 位音频样本。');
  const audio = new Float32Array(result.stdout.length / 4);
  for (let i = 0; i < audio.length; i++) audio[i] = result.stdout.readFloatLE(i * 4);
  return audio;
}

export function whisperChunksToSegments(segmentsResult, wordsResult) {
  if (String(segmentsResult.text || '').trim() && !(segmentsResult.chunks || []).length)
    throw new Error('Whisper 返回了文本但没有分段时间戳。');
  const segments = [];
  for (const chunk of segmentsResult.chunks || []) {
    const [start, end] = chunk.timestamp || [];
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !String(chunk.text || '').trim()) continue;
    const words = (wordsResult.chunks || []).filter(word => {
      const [wordStart, wordEnd] = word.timestamp || [];
      return Number.isFinite(wordStart) && Number.isFinite(wordEnd) &&
        wordStart >= start - 0.02 && wordStart < end + 0.02;
    }).map(word => ({ start: word.timestamp[0], end: word.timestamp[1], word: word.text }));
    segments.push({ start, end, text: chunk.text, words });
  }
  return { language: segmentsResult.language || wordsResult.language || '', segments };
}

export async function transcribeNode(video, model, language, { pipelineFactory = null, ffmpeg = 'ffmpeg' } = {}) {
  const pipeline = pipelineFactory || (await import('@huggingface/transformers')).pipeline;
  const transcriber = await pipeline('automatic-speech-recognition', model);
  const audio = decodeAudio(video, ffmpeg);
  const options = { chunk_length_s: 30, stride_length_s: 5, task: 'transcribe',
    ...(language ? { language } : {}) };
  const segments = await transcriber(audio, { ...options, return_timestamps: true });
  const words = await transcriber(audio, { ...options, return_timestamps: 'word' });
  return whisperChunksToSegments(segments, words);
}

export async function availableBackends() {
  try { await import('@huggingface/transformers'); return { node: true }; }
  catch { return { node: false }; }
}

export async function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error(`未知参数：${argv[i]}`);
    const key = argv[i].slice(2);
    if (!['video', 'output', 'backend', 'model', 'language', 'detect'].includes(key)) throw new Error(`未知参数：${argv[i]}`);
    options[key] = key === 'detect' ? true : argv[++i];
  }
  if (options.detect) { console.log(JSON.stringify({ ok: true, backends: await availableBackends() })); return 0; }
  if (!options.video || !options.output) throw new Error('转写必须同时提供 --video 和 --output。');
  if (options.backend && !['auto', 'node', 'mlx', 'openai'].includes(options.backend)) throw new Error(`无效后端：${options.backend}`);
  const video = expand(options.video), output = expand(options.output);
  if (!fs.existsSync(video) || !fs.statSync(video).isFile() || fs.statSync(video).size <= 0) throw new Error(`视频不存在或为空：${video}`);
  let payload;
  if (!mediaHasAudio(video)) payload = { audioReview: { status: 'no_audio', hasAudio: false,
    speechDetected: false, reviewMethod: 'ffprobe', sourceVideo: video, segments: [], audioUploaded: false } };
  else {
    if (!(await availableBackends()).node) throw new Error('本地 Whisper 后端不可用；请先运行 npm install。');
    const preferTurbo = options.backend === 'mlx' ||
      ((!options.backend || options.backend === 'auto') && process.platform === 'darwin' && process.arch === 'arm64');
    const model = options.model || (preferTurbo ? DEFAULT_MLX_MODEL : DEFAULT_OPENAI_MODEL);
    const result = await transcribeNode(video, model, options.language);
    payload = buildAudioReview(result, { video, backend: 'node', model });
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, output, status: payload.audioReview.status,
    language: payload.audioReview.language ?? null, segments: payload.audioReview.segments.length, audioUploaded: false }));
  return 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
