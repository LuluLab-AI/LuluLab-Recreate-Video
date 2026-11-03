#!/usr/bin/env node
/** Adapt the stable server replicationPlan to local storyboard metadata. */
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadManifest, update } from './generation_manifest.mjs';

const expand = path => String(path).startsWith('~/') ? resolve(homedir(), String(path).slice(2)) : resolve(String(path));
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const layoutForAnchorCount = count => {
  if (count === 9) return '3x3';
  if (count === 16) return '4x4';
  throw new Error(`当前客户端不支持${count}个anchors；需要升级Storyboard渲染器。`);
};

export function normalizeServerPlan(plan) {
  const schema = String(plan.schemaVersion ?? '').trim();
  if (!schema || schema.split('.', 1)[0] !== '1')
    throw new Error(`replicationPlan协议版本不兼容：${schema || '缺失'}。`);
  const planner = String(plan.plannerVersion ?? '').trim();
  if (!['1', '2'].includes(planner)) throw new Error(`当前Skill不支持plannerVersion=${planner || '缺失'}。`);
  const segments = plan.segments;
  if (!Array.isArray(segments) || !segments.length)
    throw new Error('服务端replicationPlan缺少有效segments。');
  const local = structuredClone(plan), normalized = [];
  let cursor = 0;
  for (const [index, segment] of segments.entries()) {
    const expectedId = index + 1;
    if (!isObject(segment)) throw new Error(`Segment ${expectedId} 不是对象。`);
    const identifier = Number(segment.segmentId ?? expectedId);
    if (identifier !== expectedId) throw new Error('Segment ID必须从1开始连续递增。');
    const start = Number(segment.globalStart), end = Number(segment.globalEnd);
    if (Math.abs(start - cursor) > 0.01 || end <= start)
      throw new Error('Segment时间窗必须从0开始连续、无重叠、无空档。');
    const anchors = segment.anchors;
    if (!Array.isArray(anchors) || !anchors.length) throw new Error(`Segment ${identifier} 缺少anchors。`);
    if (planner === '2') {
      const duration = segment.duration;
      if (![start, end].every(Number.isFinite) || typeof duration === 'boolean' || duration !== end - start)
        throw new Error('V2 Segment时间或duration无效');
      if (anchors.length !== 9) throw new Error('V2保持9个anchors');
      const shotIds = segment.shotIds ?? [];
      for (const field of ['shotIds', 'sourceCharacterIds', 'sourceProductIds']) {
        const values = segment[field];
        if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || !value) ||
            new Set(values).size !== values.length) throw new Error(`V2缺少有效${field}`);
      }
      let previous = -1;
      for (const anchor of anchors) {
        const time = anchor.timestamp;
        if (typeof time !== 'number' || !Number.isFinite(time) || time < start || time >= end || time <= previous)
          throw new Error('V2 anchor时间越界或无序');
        if (!shotIds.includes(anchor.shotId)) throw new Error('V2 anchor必须引用真实shotId');
        if (!Object.hasOwn(plan, 'sourceDuration')) throw new Error('V2 anchor越出原片');
        if (time >= Number(plan.sourceDuration)) throw new Error('V2 anchor越出原片');
        previous = time;
      }
    }
    normalized.push({ ...structuredClone(segment), layout: layoutForAnchorCount(anchors.length), anchorCount: anchors.length });
    cursor = end;
  }
  local.segments = normalized;
  return local;
}

export async function loadServerPlan(manifest) {
  const pathValue = String(manifest.replicationPlan?.file || manifest.timelinePlan?.file || '');
  if (!pathValue) throw new Error('manifest缺少服务端replicationPlan；请先完成StoryboardPlan。');
  const path = expand(pathValue), info = await stat(path).catch(() => null);
  if (!info?.isFile() || !info.size) throw new Error(`服务端replicationPlan文件不存在或为空：${path}`);
  const raw = JSON.parse(await readFile(path, 'utf8'));
  if (!isObject(raw)) throw new Error('服务端replicationPlan不是JSON对象。');
  return [normalizeServerPlan(raw), path];
}

export async function persistPlan(manifestPath, output) {
  const [plan, source] = await loadServerPlan(await loadManifest(manifestPath));
  const target = expand(output);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(plan, null, 2) + '\n', 'utf8');
  const recommended = plan.segments.map(segment => Object.fromEntries(
    ['segmentId', 'globalStart', 'globalEnd', 'duration'].map(key => {
      if (!Object.hasOwn(segment, key)) throw new Error(`missing Segment ${key}`);
      return [key, segment[key]];
    })));
  await update(manifestPath, current => {
    current.benchmarkVideo ??= {}; current.benchmarkVideo.analysis ??= {};
    current.benchmarkVideo.analysis.recommendedSegments = recommended;
    current.timelinePlan = { file: target, schemaVersion: String(plan.schemaVersion ?? '1.0'),
      plannerVersion: String(plan.plannerVersion ?? '1'), policyVersion: String(plan.policyVersion ?? ''),
      source: 'server-adapter', serverFile: source };
  });
  return { ok: true, source: 'server', schemaVersion: String(plan.schemaVersion ?? ''),
    plannerVersion: String(plan.plannerVersion ?? ''), policyVersion: String(plan.policyVersion ?? ''),
    segments: plan.segments.length, layouts: plan.segments.map(segment => segment.layout), output: target };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const value = flag => { const index = process.argv.indexOf(flag); return index < 0 ? null : process.argv[index + 1]; };
  const manifest = value('--manifest'), output = value('--output');
  if (!manifest || !output) { console.error('usage: node scripts/blueprint_timeline.mjs --manifest <file> --output <file>'); process.exitCode = 2; }
  else {
    try { console.log(JSON.stringify(await persistPlan(manifest, output))); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
