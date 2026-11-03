#!/usr/bin/env node
/** Register selected target Storyboards byte-for-byte for prompt generation. */
import {createHash} from 'node:crypto';
import {readFile, writeFile, mkdir, rename, stat} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {loadManifest, setGenerationStoryboards, normalizeReplacementRecord} from './generation_manifest.mjs';
import * as audit from './reference_audit.mjs';
import {loadBlueprint, segmentContext} from './entity_bindings.mjs';

export const HANDOFF_POLICY_VERSION = '3';
export const ANCHOR_FIELDS = ['shotId', 'anchorRole', 'eventType', 'productPresent',
  'productVisibility', 'productCount', 'personPresent', 'personExtent', 'personCount',
  'creatorIds', 'interactionState', 'semanticSource'];
const expand = p => resolve(String(p).replace(/^~(?=\/|$)/, homedir()));
const object = x => x && typeof x === 'object' && !Array.isArray(x);
const stable = x => Array.isArray(x) ? x.map(stable) : object(x) ?
  Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)])) : x;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function fileDigest(path) {return digest(await readFile(expand(path)));}
async function save(path, value) {
  await mkdir(dirname(path), {recursive: true});
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2) + '\n');
  await rename(`${path}.tmp`, path);
}
export function segmentWindows(manifest) {
  return new Map((manifest.benchmarkVideo?.analysis?.recommendedSegments ?? [])
    .map(item => [Number(item.segmentId), [Number(item.globalStart), Number(item.globalEnd)]]));
}
export function selectedBoards(manifest) {
  const originals = manifest.storyboards?.original ?? [], edited = manifest.storyboards?.edited ?? [];
  if (!originals.length) throw Error('必须先登记原始 Storyboard。');
  const byId = new Map(originals.map(item => [Number(item.storyboardId), item]));
  if (manifest.creator?.mode && !edited.length)
    throw Error('新任务必须先登记目标 edited Storyboard，不能用原始九宫格生成 Prompt。');
  const selected = edited.length ? edited : originals;
  for (const item of selected) {
    const id = Number(item.storyboardId);
    if (!byId.has(id)) throw Error(`最终 Storyboard ${id} 没有对应原始 Storyboard。`);
    if (audit.currentOrLegacyAtLeast(String(manifest.skillVersion || ''), 6, 2)) {
      let visible = new Set((item.anchors ?? []).flatMap(anchor => anchor.creatorIds ?? []).map(String).filter(Boolean));
      const context = segmentContext(manifest, {segmentId: id});
      if (context) visible = new Set(context.creatorIds);
      visible = audit.validateIdentityRoster(manifest, item,
        {segmentId: id, creatorIds: [...visible].sort()});
      audit.validateAiStoryboardInput(manifest, item, visible);
    }
    if (object(item.replacement) && item.replacement.applied) {
      audit.validateProductReferences(manifest, item);
      if (audit.currentOrLegacyAtLeast(String(manifest.skillVersion || ''), 6, 2) &&
        item.replacement.method !== 'whole-board-fast-v1')
        throw Error(`Storyboard ${id} fast模式必须使用whole-board-fast-v1。`);
      const normalized = normalizeReplacementRecord(item.replacement);
      if (!item.replacementVerified || !normalized.replacementVerified)
        throw Error(`Storyboard ${id} 尚未完成本地文件完整性登记。`);
    }
  }
  return [...selected].sort((a, b) => Number(a.segmentId ?? a.storyboardId) - Number(b.segmentId ?? b.storyboardId));
}
export function buildPlan(manifest, cellRoots) {
  const windows = segmentWindows(manifest), boards = selectedBoards(manifest);
  const complete = boards.length === (windows.size || (manifest.storyboards?.original ?? []).length);
  const segments = []; let cursor = 0;
  for (const board of boards) {
    const id = Number(board.storyboardId), segmentId = Number(board.segmentId ?? id);
    const [start, end] = board.globalStart != null && board.globalEnd != null ?
      [Number(board.globalStart), Number(board.globalEnd)] : windows.get(segmentId) ?? [];
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw Error(`Storyboard ${id} 缺少可确定的 Segment 时间窗。`);
    if (end <= start || start < cursor - .01 || complete && Math.abs(start - cursor) > .01)
      throw Error('已完成 Segment 时间窗不能重叠；全部完成后必须从0开始连续。');
    const anchors = board.anchors;
    if (!Array.isArray(anchors) || ![9, 16].includes(anchors.length)) throw Error(`Storyboard ${id} 必须包含9或16个 anchors。`);
    const cells = anchors.map((anchor, index) => {
      const timestamp = anchor.globalTimestamp ?? anchor.timestamp;
      if (timestamp == null) throw Error(`Storyboard ${id} 第${index + 1}格缺少全局时间。`);
      const cell = {file: join(expand(cellRoots[segmentId]), `cell-${String(index + 1).padStart(2, '0')}.png`),
        globalTimestamp: Number(timestamp)};
      for (const field of ANCHOR_FIELDS) if (Object.hasOwn(anchor, field)) cell[field] = anchor[field];
      return cell;
    });
    const segment = {segmentId, globalStart: start, globalEnd: end, labelHeight: Number(board.labelHeight ?? 38),
      replacementVerified: Boolean(board.replacementVerified), cells};
    if (object(board.replacement)) segment.replacement = board.replacement;
    segments.push(segment); cursor = end;
  }
  const expected = manifest.userConfig?.duration;
  if (expected != null && complete && Math.abs(cursor - Number(expected)) > .01)
    throw Error('最终 Storyboard 未覆盖完整复刻时长。');
  return {segments};
}
export async function inputFingerprint(manifest, boards) {
  const product = manifest.product ?? {}, products = product.productImages ?? product.images ?? [];
  const imageDigest = async value => fileDigest(typeof value === 'string' ? value : value.file || value.filePath || '');
  const identity = {schema: 'replication-package-v1', handoffPolicyVersion: HANDOFF_POLICY_VERSION,
    duration: manifest.userConfig?.duration ?? null, sourceBlueprint: loadBlueprint(manifest),
    replacementBindings: manifest.replacementBindings ?? null, creatorMode: manifest.creator ?? null,
    creatorGeneration: Object.fromEntries(Object.entries(manifest.creatorGeneration ?? {})
      .map(([key, value]) => [key, {inputFingerprint: value.inputFingerprint ?? null, sha256: value.sha256 ?? null}])),
    productImages: await Promise.all(products.map(imageDigest)),
    creators: await Promise.all((manifest.creators ?? []).map(async item => ({id: item.creatorId ?? null,
      source: item.sourceType ?? null,
      sha256: await Promise.all((item.referenceImages ?? [item]).map(imageDigest))}))),
    model: manifest.userConfig?.videoModel ?? null, targetLanguage: manifest.userConfig?.targetLanguage ?? null,
    boards: await Promise.all(boards.map(async board => ({storyboardId: Number(board.storyboardId),
      fileSha256: await fileDigest(board.file), anchors: board.anchors ?? [],
      replacementVerified: Boolean(board.replacementVerified), replacement: board.replacement ?? null})))};
  return digest(JSON.stringify(stable(identity)));
}
export function singleSegmentDirectMetadata(board, start, end) {
  const anchors = board.anchors;
  if (!Array.isArray(anchors) || ![9, 16].includes(anchors.length)) throw Error('单段 Storyboard 必须包含9或16个 anchors。');
  const normalized = anchors.map((anchor, index) => {
    const timestamp = anchor.globalTimestamp ?? anchor.timestamp;
    if (timestamp == null) throw Error(`单段 Storyboard 第${index + 1}格缺少全局时间。`);
    const item = {index: Number(anchor.index ?? index + 1), globalTimestamp: Number(timestamp),
      localTimestamp: Number(timestamp) - start};
    for (const field of ANCHOR_FIELDS) if (Object.hasOwn(anchor, field)) item[field] = anchor[field];
    return item;
  });
  const result = {storyboardId: Number(board.storyboardId), segmentId: Number(board.segmentId ?? board.storyboardId),
    file: expand(board.file), layout: anchors.length === 16 ? '4x4' : '3x3', globalStart: start,
    globalEnd: end, localStart: 0, localEnd: end - start,
    replacementVerified: Boolean(board.replacementVerified), labelHeight: Number(board.labelHeight ?? 38), anchors: normalized};
  if (object(board.replacement)) result.replacement = board.replacement;
  return {schemaRevision: '5.1', layout: '3x3', boards: [result], totalDuration: end - start};
}
export function allSegmentsDirectMetadata(manifest, boards) {
  const windows = segmentWindows(manifest), complete = boards.length ===
    (windows.size || (manifest.storyboards?.original ?? []).length);
  const results = []; let cursor = 0;
  for (const board of boards) {
    const id = Number(board.segmentId ?? board.storyboardId);
    const [start, end] = board.globalStart != null && board.globalEnd != null ?
      [Number(board.globalStart), Number(board.globalEnd)] : windows.get(id) ?? [];
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw Error(`Storyboard ${board.storyboardId} 缺少可确定的 Segment 时间窗。`);
    if (end <= start || start < cursor - .01 || complete && Math.abs(start - cursor) > .01)
      throw Error('已完成 Segment 时间窗不能重叠；全部完成后必须从0开始连续。');
    results.push(singleSegmentDirectMetadata(board, start, end).boards[0]); cursor = end;
  }
  const expected = manifest.userConfig?.duration;
  if (expected != null && complete && Math.abs(cursor - Number(expected)) > .01)
    throw Error('最终 Storyboard 未覆盖完整复刻时长。');
  return {schemaRevision: '5.4', layout: '3x3', boards: results, totalDuration: cursor};
}
export async function prepare(manifestPath, outputDir = null) {
  const started = performance.now(), path = expand(manifestPath), output = outputDir ? expand(outputDir) :
    join(dirname(path), 'storyboards', 'generation');
  const manifest = await loadManifest(path), boards = selectedBoards(manifest);
  const fingerprint = await inputFingerprint(manifest, boards), reportPath = join(output, 'replication-package.json');
  const previous = await readFile(reportPath, 'utf8').then(JSON.parse, () => null);
  if (previous?.inputFingerprint === fingerprint && (manifest.storyboards?.generation ?? []).length &&
    await Promise.all(manifest.storyboards.generation.map(item => stat(expand(item.file)).then(s => s.isFile(), () => false)))
      .then(values => values.every(Boolean)))
    return {ok: true, reused: true, package: reportPath, elapsedSeconds: Math.round(performance.now() - started) / 1000};
  const metadata = allSegmentsDirectMetadata(manifest, boards), metadataPath = join(output, 'segment-storyboard-metadata.json');
  await save(metadataPath, metadata);
  await setGenerationStoryboards(path, metadataPath);
  const entityContexts = boards.map(board => {
    const id = Number(board.segmentId ?? board.storyboardId), context = segmentContext(manifest, {segmentId: id});
    return context ? {segmentId: id, ...context} : null;
  }).filter(Boolean);
  const report = {schema: 'replication-package-v1', handoffPolicyVersion: HANDOFF_POLICY_VERSION,
    inputFingerprint: fingerprint, manifest: path, generationMetadata: metadataPath,
    segmentCount: boards.length, entityContexts, directReuse: true,
    pixelPolicy: 'target-board-byte-for-byte', timings: {splitSeconds: 0,
      renderAndRegisterSeconds: 0, totalSeconds: Math.round(performance.now() - started) / 1000}};
  await save(reportPath, report);
  return {ok: true, reused: false, package: reportPath, ...report};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
    if (!option('--manifest')) throw Error('需要 --manifest');
    console.log(JSON.stringify(await prepare(option('--manifest'), option('--output-dir'))));
  } catch (error) {console.error(error.message); process.exitCode = 1;}
}
