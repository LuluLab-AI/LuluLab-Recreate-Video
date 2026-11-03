#!/usr/bin/env node
/** Build a deterministic 9-anchor plan from single-pass visual scan metrics. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const PANELS = 9;
export const HOOK_POINTS = [0.5, 1.5, 2.8];
const expand = path => path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : resolve(path);
const round3 = value => Math.round(value * 1000) / 1000;
const finite = value => {
  if (value === undefined || value === null || value === '' || typeof value === 'boolean')
    throw new Error(`非有限时间值：${String(value)}`);
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`非有限时间值：${String(value)}`);
  return number;
};
const near = (values, target, tolerance) => values.some(value => Math.abs(value - target) < tolerance);

function scanSamples(analysis) {
  const raw = analysis.visualScan?.samples;
  if (!Array.isArray(raw)) return [];
  const result = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    try { result.push({ timestamp: finite(item.timestamp), qualityScore: finite(item.qualityScore ?? 0),
      changeScore: finite(item.changeScore ?? 0) }); }
    catch { /* malformed samples are ignored by the original planner */ }
  }
  return result;
}

function bestNearTarget(target, samples, { start, end, radius, selected, minGap }) {
  const nearby = samples.filter(sample => start < sample.timestamp && sample.timestamp < end &&
    Math.abs(sample.timestamp - target) <= radius && !near(selected, sample.timestamp, minGap));
  if (!nearby.length) return round3(target);
  nearby.sort((a, b) => (b.qualityScore + b.changeScore * 0.08) - (a.qualityScore + a.changeScore * 0.08) ||
    Math.abs(a.timestamp - target) - Math.abs(b.timestamp - target));
  return round3(nearby[0].timestamp);
}

function visualSelect(candidates, selected, count, { start, endAnchor, minGap }) {
  const remaining = [];
  for (const item of candidates) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    try {
      const timestamp = round3(finite(item.timestamp));
      const changeScore = Math.max(0, Math.min(1, finite(item.changeScore ?? 0)));
      const qualityScore = Math.max(0, Math.min(1, finite(item.qualityScore ?? 0)));
      if (start + minGap < timestamp && timestamp < endAnchor - minGap)
        remaining.push({ timestamp, changeScore, qualityScore,
          eventType: String(item.eventType) === 'cut' ? 'cut' : 'visual_change' });
    } catch { /* malformed candidates are ignored by the original planner */ }
  }
  const chosen = [], span = Math.max(0.001, endAnchor - start);
  while (remaining.length && chosen.length < count) {
    const available = remaining.filter(item => !near([...selected, ...chosen.map(value => value.timestamp)], item.timestamp, minGap));
    if (!available.length) break;
    const score = item => {
      const coverage = Math.min(...[...selected, ...chosen.map(value => value.timestamp)]
        .map(point => Math.abs(item.timestamp - point))) / span;
      return item.changeScore * 0.58 + coverage * 0.24 + item.qualityScore * 0.18 +
        (item.eventType === 'cut' ? 0.14 : 0);
    };
    available.sort((a, b) => score(b) - score(a) || b.changeScore - a.changeScore || a.timestamp - b.timestamp);
    const winner = available[0];
    chosen.push(winner);
    remaining.splice(remaining.indexOf(winner), 1);
  }
  return chosen;
}

function largestGapFill(selected, start, endAnchor, count, minGap, samples) {
  const values = [...new Set(selected)].sort((a, b) => a - b);
  const scanRadius = Math.max(0.3, Math.min(0.55, (endAnchor - start) / 20));
  while (values.length < count) {
    const gaps = values.slice(1).map((right, index) => ({ gap: right - values[index], left: values[index], right }));
    gaps.sort((a, b) => b.gap - a.gap || b.left - a.left || b.right - a.right);
    let added = false;
    for (const { left, right } of gaps) {
      const candidate = bestNearTarget((left + right) / 2, samples, {
        start: left + minGap / 2, end: right - minGap / 2,
        radius: scanRadius, selected: values, minGap,
      });
      if (start < candidate && candidate < endAnchor && !near(values, candidate, minGap)) {
        values.push(candidate); values.sort((a, b) => a - b); added = true; break;
      }
    }
    if (added) continue;
    for (let index = 1; index < 200; index++) {
      const candidate = round3(start + (endAnchor - start) * index / 200);
      if (start < candidate && candidate < endAnchor && !near(values, candidate, minGap / 2)) {
        values.push(candidate); values.sort((a, b) => a - b); added = true; break;
      }
    }
    if (!added) throw new Error('Segment过短，无法生成9个严格递增的真实时间锚点。');
  }
  return values;
}

export function chooseTimes(segment, analysis, firstSegment) {
  const start = finite(segment.globalStart), end = finite(segment.globalEnd), duration = end - start;
  if (duration <= 0) throw new Error('Segment globalEnd 必须大于 globalStart。');
  const tailOffset = Math.min(0.08, Math.max(0.04, duration / 100));
  const endAnchor = round3(end - tailOffset);
  const minGap = Math.min(0.12, Math.max(0.04, duration / 100));
  const selected = [round3(start), endAnchor], source = new Map([[round3(start), 'start'], [endAnchor, 'tail']]);
  const samples = scanSamples(analysis);
  if (firstSegment) {
    const scanFps = Number(analysis.visualScan?.fps || 4);
    const snapRadius = Math.max(0.22, 1.1 / Math.max(1, scanFps));
    for (const point of HOOK_POINTS) {
      if (!(start + minGap < point && point < endAnchor - minGap)) continue;
      const value = bestNearTarget(point, samples, {
        start: start + minGap, end: endAnchor - minGap,
        radius: snapRadius, selected, minGap,
      });
      if (!near(selected, value, minGap)) { selected.push(value); source.set(value, 'hook'); }
    }
  }
  const reserveContext = duration < 6 ? 1 : 2;
  const visualCapacity = Math.max(0, PANELS - selected.length - reserveContext);
  let visualCandidates = Array.isArray(analysis.visualCandidates) ? analysis.visualCandidates : [];
  if (!visualCandidates.length) visualCandidates = (analysis.candidateCuts ?? []).map(timestamp =>
    ({ timestamp, eventType: 'cut', changeScore: 1, qualityScore: 0.5 }));
  for (const item of visualSelect(visualCandidates, selected, visualCapacity, { start, endAnchor, minGap })) {
    selected.push(item.timestamp);
    source.set(item.timestamp, item.eventType === 'cut' ? 'cut' : 'visual_change');
  }
  const times = largestGapFill(selected, start, endAnchor, PANELS, minGap, samples);
  for (const value of times) if (!source.has(value)) source.set(value, 'context');
  if (times.length !== PANELS || times.some((value, index) => index && times[index - 1] >= value))
    throw new Error('自动锚点必须正好9个并严格递增。');
  return [times, source];
}

export function buildPlan(analysis) {
  const segments = analysis.recommendedSegments;
  if (!Array.isArray(segments) || !segments.length)
    throw new Error('benchmark-analysis.json 缺少 recommendedSegments。');
  const cuts = (analysis.candidateCuts ?? []).map(finite);
  const result = [];
  for (const [offset, segment] of segments.entries()) {
    const index = offset + 1;
    const [times, sources] = chooseTimes(segment, analysis, index === 1);
    const start = finite(segment.globalStart);
    const nearStartCut = cuts.some(cut => Math.abs(cut - start) <= 0.35);
    const anchors = times.map((timestamp, position) => {
      const source = sources.get(timestamp);
      let event, role;
      if (position === 0) { event = index === 1 ? 'first_frame' : nearStartCut ? 'cut' : 'continuity_start'; role = 'hard'; }
      else if (source === 'cut') { event = 'cut'; role = 'hard'; }
      else if (source === 'visual_change') { event = 'action_process'; role = 'soft'; }
      else if (source === 'hook') { event = 'hook'; role = 'hard'; }
      else { event = 'context'; role = 'context'; }
      return { timestamp, anchorRole: role, eventType: event, semanticSource: 'unobserved' };
    });
    result.push({ segmentId: Number.parseInt(String(segment.segmentId ?? index), 10),
      globalStart: start, globalEnd: finite(segment.globalEnd), anchors });
  }
  return { selectionMethod: 'single-pass-visual-hook-coverage-v1', segments: result };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const value = flag => { const index = process.argv.indexOf(flag); return index < 0 ? null : process.argv[index + 1]; };
  const analysisFile = value('--analysis-file'), output = value('--output');
  if (!analysisFile || !output) { console.error('usage: node scripts/auto_anchor_plan.mjs --analysis-file <file> --output <file>'); process.exitCode = 2; }
  else {
    try {
      const plan = buildPlan(JSON.parse(await readFile(expand(analysisFile), 'utf8')));
      const target = expand(output);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, JSON.stringify(plan, null, 2) + '\n', 'utf8');
      console.log(JSON.stringify({ ok: true, output: target, ...plan }));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
