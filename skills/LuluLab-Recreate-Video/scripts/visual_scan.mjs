/** Single-pass low-resolution visual scan for action and cut anchors. */
import { spawn } from 'node:child_process';

export const SCAN_WIDTH = 48;
export const SCAN_HEIGHT = 27;
export const DEFAULT_CHANGE_THRESHOLD = 0.07;
export const DEFAULT_CUT_THRESHOLD = 0.14;
export const VISUAL_SCAN_VERSION = 'single-pass-gray-v1';
const round = (value, places) => Math.round(value * 10 ** places) / 10 ** places;

export function adaptiveScanFps(duration) {
  duration = Number(duration);
  if (duration <= 30) return 4;
  if (duration <= 60) return 3;
  return 2;
}

export function frameDistance(first, second) {
  if (first.length !== second.length || !first.length) throw new Error('视觉扫描帧尺寸不一致。');
  let total = 0;
  for (let index = 0; index < first.length; index++) total += Math.abs(first[index] - second[index]);
  return total / (first.length * 255);
}

export function frameQuality(frame, width = SCAN_WIDTH, height = SCAN_HEIGHT) {
  if (frame.length !== width * height) throw new Error('视觉扫描帧长度与尺寸不匹配。');
  const count = frame.length;
  let total = 0, squares = 0;
  for (const value of frame) { total += value; squares += value * value; }
  const mean = total / count;
  const variance = Math.max(0, squares / count - mean * mean);
  const stddev = Math.sqrt(variance);
  let horizontal = 0, vertical = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width - 1; x++) horizontal += Math.abs(frame[row + x + 1] - frame[row + x]);
  }
  for (let y = 0; y < height - 1; y++) {
    const row = y * width, below = row + width;
    for (let x = 0; x < width; x++) vertical += Math.abs(frame[below + x] - frame[row + x]);
  }
  const edgeMean = (horizontal + vertical) /
    Math.max(1, height * Math.max(0, width - 1) + Math.max(0, height - 1) * width);
  const contrastScore = Math.min(1, stddev / 64);
  const edgeScore = Math.min(1, edgeMean / 32);
  const exposureScore = Math.max(0, 1 - Math.abs(mean - 128) / 128);
  return round(0.4 * contrastScore + 0.4 * edgeScore + 0.2 * exposureScore, 4);
}

function suppressNearby(candidates, minGap) {
  const kept = [];
  for (const candidate of [...candidates].sort((a, b) => b.changeScore - a.changeScore || a.timestamp - b.timestamp)) {
    if (kept.some(item => Math.abs(candidate.timestamp - item.timestamp) < minGap)) continue;
    kept.push(candidate);
  }
  return kept.sort((a, b) => a.timestamp - b.timestamp);
}

export function analyzeFrames(frames, { fps, duration, width = SCAN_WIDTH, height = SCAN_HEIGHT,
  changeThreshold = DEFAULT_CHANGE_THRESHOLD, cutThreshold = DEFAULT_CUT_THRESHOLD } = {}) {
  if (fps <= 0) throw new Error('visual scan fps 必须大于0。');
  const samples = [], history = [], lookback = Math.max(1, Math.round(fps));
  for (const [index, frame] of [...frames].entries()) {
    if (frame.length !== width * height) throw new Error('视觉扫描读取到不完整帧。');
    const timestamp = Math.min(Number(duration), index / fps);
    const previousChange = history.length ? frameDistance(history.at(-1), frame) : 0;
    const stateChange = history.length >= lookback ? frameDistance(history.at(-lookback), frame) : previousChange;
    const changeScore = Math.max(previousChange, stateChange * 0.72);
    samples.push({ timestamp: round(timestamp, 3), changeScore: round(changeScore, 4),
      adjacentChange: round(previousChange, 4), stateChange: round(stateChange, 4),
      qualityScore: frameQuality(frame, width, height) });
    history.push(frame);
    if (history.length > lookback + 1) history.shift();
  }
  const actions = suppressNearby(samples.slice(1).filter(sample => sample.changeScore >= changeThreshold)
    .map(sample => ({ ...sample, eventType: 'visual_change' })), Math.max(0.45, 1.5 / fps));
  const cuts = suppressNearby(samples.slice(1).filter(sample => sample.adjacentChange >= cutThreshold)
    .map(sample => ({ ...sample, eventType: 'cut' })), Math.max(0.45, 1.5 / fps));
  const cutTimes = new Set(cuts.map(item => round(item.timestamp, 3))), merged = [];
  for (const item of actions) {
    const timestamp = round(item.timestamp, 3);
    if ([...cutTimes].some(cut => Math.abs(timestamp - cut) < Math.max(0.26, 0.8 / fps))) continue;
    if ([...cutTimes].some(cut => 0 < timestamp - cut && timestamp - cut <= 1.05 &&
        item.adjacentChange < changeThreshold * 0.7)) continue;
    merged.push(item);
  }
  merged.push(...cuts);
  merged.sort((a, b) => a.timestamp - b.timestamp);
  return { version: VISUAL_SCAN_VERSION, fps, width, height, sampleCount: samples.length,
    changeThreshold, cutThreshold, samples, visualCandidates: merged,
    candidateCuts: cuts.map(item => round(item.timestamp, 3)) };
}

export async function scanVideo(ffmpeg, video, { duration, fps = null, width = SCAN_WIDTH,
  height = SCAN_HEIGHT, changeThreshold = DEFAULT_CHANGE_THRESHOLD,
  cutThreshold = DEFAULT_CUT_THRESHOLD } = {}) {
  fps = Number(fps || adaptiveScanFps(duration));
  if (fps <= 0 || !Number.isFinite(fps)) throw new Error('visual scan fps 无效。');
  const frameSize = width * height;
  const args = ['-hide_banner', '-loglevel', 'error', '-i', String(video), '-t', Number(duration).toFixed(3),
    '-an', '-vf', `fps=${fps},scale=${width}:${height}:flags=area,format=gray`,
    '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'];
  const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const frames = [];
  let pending = Buffer.alloc(0), stderr = '', failure = null;
  child.stdout.on('data', chunk => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= frameSize) {
      frames.push(Buffer.from(pending.subarray(0, frameSize)));
      pending = pending.subarray(frameSize);
    }
  });
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); if (stderr.length > 2000) stderr = stderr.slice(-2000); });
  child.on('error', error => { failure = error; });
  const code = await new Promise(resolveExit => child.on('close', resolveExit));
  if (failure) throw failure;
  if (pending.length) throw new Error('FFmpeg视觉扫描返回了不完整帧。');
  if (code) throw new Error(stderr.slice(-2000) || 'FFmpeg视觉扫描失败。');
  if (!frames.length) throw new Error('视觉扫描没有返回任何帧。');
  return analyzeFrames(frames, { fps, duration, width, height, changeThreshold, cutThreshold });
}
