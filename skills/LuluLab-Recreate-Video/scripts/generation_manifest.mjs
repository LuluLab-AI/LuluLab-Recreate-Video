#!/usr/bin/env node
/** Node.js manifest storage and schema migration helpers. */
import { createHash } from 'node:crypto';
import { realpathSync, readFileSync, statSync } from 'node:fs';
import { readFile, writeFile, rename, mkdir, stat, open, unlink } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { normalizeLocale, resolveInteractionLocale, resolveInteractionLanguage } from './interaction_language.mjs';
import { sanitizePayload, sanitizeJsonFile } from './service_privacy.mjs';
import { segmentContext } from './entity_bindings.mjs';
import { normalizeReplacementMap } from './storyboard_cells.mjs';

export const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const allowedOptimizationSuffixes = new Set(['.md', '.mjs', '.js', '.yaml', '.yml', '.json', '.txt']);
const expand = path => {
  const value = String(path).startsWith('~/') ? resolve(homedir(), String(path).slice(2)) : resolve(String(path));
  try { return realpathSync.native(value); }
  catch {
    if (dirname(value) === value) return value;
    return join(expand(dirname(value)), basename(value));
  }
};
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const pyTruthy = value => Array.isArray(value) ? value.length > 0 : isObject(value) ? Object.keys(value).length > 0 : Boolean(value);
const setDefault = (object, key, value) => { if (!Object.hasOwn(object, key)) object[key] = value; return object[key]; };
export const now = () => new Date().toISOString().replace('Z', '000+00:00');

export async function fileSha256(path) {
  const bytes = await readFile(expand(path));
  return createHash('sha256').update(bytes).digest('hex');
}

export async function skillVersion(skillRoot = SKILL_ROOT) {
  const source = await readFile(resolve(skillRoot, 'SKILL.md'), 'utf8');
  return source.match(/^#\s+LuluLab-Recreate-Video\s+[vV]([^\s]+)/m)?.[1] ??
    source.match(/^version:\s*([^\s]+)\s*$/m)?.[1] ?? 'unknown';
}

export function optimizationRelativePath(value) {
  const parts = String(value).split(/[\\/]/);
  if (isAbsolute(value) || parts.includes('..') || !parts.length || !value)
    throw new Error(`技能优化文件必须是技能内相对路径：${value}`);
  if (value === 'SKILL.md') return value;
  if (!['references', 'scripts', 'tests', 'agents'].includes(parts[0]))
    throw new Error(`技能优化文件不在允许目录：${value}`);
  if (!allowedOptimizationSuffixes.has(extname(value).toLowerCase()))
    throw new Error(`技能优化文件类型不允许：${value}`);
  return value;
}

export async function skillFileFingerprints(paths, skillRoot = SKILL_ROOT) {
  const root = resolve(skillRoot), result = {};
  for (const value of [...new Set(paths)].sort()) {
    const name = optimizationRelativePath(value), target = resolve(root, name);
    if (target !== root && !target.startsWith(root + sep))
      throw new Error(`技能优化文件越出技能目录：${value}`);
    result[name] = (await stat(target).catch(() => null))?.isFile() ? await fileSha256(target) : 'missing';
  }
  return result;
}

export async function loadManifest(path) {
  const value = expand(path);
  const data = JSON.parse(await readFile(value, 'utf8'));
  if (String(data.version) !== '4') throw new Error('Unsupported manifest version');
  setDefault(data, 'schemaRevision', '4.0');
  setDefault(data, 'migrationArchive', {});
  for (const field of ['shotContracts', 'renderUnits']) {
    const legacy = data[field]; delete data[field];
    const meaningful = field === 'shotContracts' && isObject(legacy) ? pyTruthy(legacy.shotContracts) : pyTruthy(legacy);
    if (meaningful && !Object.hasOwn(data.migrationArchive, field)) data.migrationArchive[field] = legacy;
  }
  const revision = String(data.schemaRevision ?? '4.0'), migrating50 = revision.startsWith('5.0');
  if (migrating50 || revision.startsWith('5.1') || revision.startsWith('5.2')) data.schemaRevision = '5.3';
  setDefault(data, 'benchmarkVideo', {});
  setDefault(data, 'product', {});
  if (isObject(data.product) && !data.product.productImages?.length && !data.product.images?.length &&
      !Object.hasOwn(data.product, 'useBenchmarkProduct')) {
    data.product.useBenchmarkProduct = true; setDefault(data.product, 'productImages', []);
  }
  setDefault(data, 'storyboards', { original: [], edited: [], generation: [] });
  setDefault(data.storyboards, 'original', []); setDefault(data.storyboards, 'edited', []); setDefault(data.storyboards, 'generation', []);
  if (migrating50 && !data.storyboards.generation.length &&
      ['step3_complete', 'step4_complete', 'step5_review_pending', 'complete'].includes(String(data.workflowStatus ?? 'initialized')))
    data.workflowStatus = data.storyboards.edited.length ? 'step2_complete' :
      data.storyboards.original.length ? 'step1_complete' : 'initialized';
  const config = setDefault(data, 'userConfig', {});
  setDefault(config, 'videoModel', 'seedance-2-fast'); setDefault(config, 'durationMode', 'source');
  setDefault(config, 'requestedDuration', null); setDefault(config, 'customRequirement', '');
  setDefault(config, 'targetCountry', '跟原视频一致'); setDefault(config, 'targetLanguage', '跟原视频一致');
  config.interactionLocale = resolveInteractionLocale(config.interactionLocale);
  config.interactionLanguage = resolveInteractionLanguage(config.interactionLocale);
  setDefault(config, 'resolution', '720p'); setDefault(config, 'qualityProfile', 'fast');
  setDefault(config, 'fidelityMode', 'high_fidelity'); setDefault(config, 'peopleMode', 'recreate');
  setDefault(config, 'imageProvider', 'agent_local'); setDefault(config, 'videoProvider', 'auto');
  config.storyboardValidationMode = 'fast';
  setDefault(data, 'providerCapabilities', {}); setDefault(data, 'qualityReports', []); setDefault(data, 'skillOptimizations', []);
  setDefault(data, 'videoGeneration', { status: 'not_started', generated: false });
  if (data.workflowStatus === 'step5_review_pending' && isObject(data.finalVideo) && data.finalVideo.file)
    data.workflowStatus = 'complete';
  const sanitized = sanitizePayload(data);
  if (isObject(sanitized.videoBlueprint) && sanitized.videoBlueprint.rawFile)
    sanitizeJsonFile(sanitized.videoBlueprint.rawFile, { root: dirname(value) });
  if (JSON.stringify(sanitized) !== JSON.stringify(data)) await saveManifest(value, sanitized);
  return sanitized;
}

export async function saveManifest(path, data) {
  const value = expand(path), sanitized = sanitizePayload(data);
  for (const key of Object.keys(data)) delete data[key];
  Object.assign(data, sanitized);
  data.updatedAt = now();
  await mkdir(dirname(value), { recursive: true });
  const temporary = `${value}.tmp`;
  await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await rename(temporary, value);
  return value;
}

export async function requireFile(path, role) {
  const value = expand(path), info = await stat(value).catch(() => null);
  if (!info?.isFile() || !info.size) throw new Error(`${role}不存在或为空：${value}`);
  return value;
}

export async function update(path, mutator) {
  const value = expand(path), lockPath = `${value}.jslock`;
  await mkdir(dirname(value), { recursive: true });
  let lock;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { lock = await open(lockPath, 'wx'); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await new Promise(resolveWait => setTimeout(resolveWait, 50));
    }
  }
  if (!lock) throw new Error(`manifest lock unavailable: ${lockPath}`);
  try {
    const data = await loadManifest(value);
    await mutator(data);
    return await saveManifest(value, data);
  } finally { await lock.close(); await unlink(lockPath).catch(() => {}); }
}

export async function commandInit(args) {
  const creatorMode = String(args.creatorMode || 'ai_generated');
  if (!['ai_generated', 'keep_source', 'user_provided'].includes(creatorMode))
    throw new Error(`无效达人模式：${creatorMode}`);
  const videoModel = String(args.videoModel || 'seedance-2-mini');
  const durationMode = String(args.durationMode || 'source');
  const targetDuration = args.targetDuration ?? null;
  const customRequirement = String(args.customRequirement || '');
  const targetCountry = String(args.targetCountry || '跟原视频一致');
  const targetLanguage = String(args.targetLanguage || '跟原视频一致');
  const interactionLocale = resolveInteractionLocale(args.interactionLocale,
    { configuredLocale: args.codexLocale });
  if (!['source', 'custom'].includes(durationMode)) throw new Error('durationMode 必须是 source 或 custom。');
  if (durationMode === 'custom' && (!Number.isInteger(targetDuration) || targetDuration <= 0))
    throw new Error('custom 模式必须提供正整数 --target-duration。');
  if (durationMode === 'source' && targetDuration !== null)
    throw new Error('source 模式不得提供 --target-duration。');
  const root = join(expand(args.outputRoot), args.taskId);
  for (const name of ['analysis', 'storyboards/original', 'storyboards/edited',
    'storyboards/generation', 'creators', 'prompts', 'videos', 'candidates', 'review'])
    await mkdir(join(root, name), { recursive: true });
  const manifest = join(root, 'manifest.json');
  const exists = Boolean(await stat(manifest).catch(() => null));
  if (exists && !args.reuse) throw new Error(`manifest 已存在：${manifest}`);
  if (!exists) {
    const created = now();
    await saveManifest(manifest, {
      version: '4', schemaRevision: '5.3', skillVersion: await skillVersion(), taskId: args.taskId,
      createdAt: created, updatedAt: created, benchmarkVideo: {},
      product: { useBenchmarkProduct: true, productImages: [] },
      userConfig: { videoModel, durationMode, requestedDuration: targetDuration,
        customRequirement, targetCountry, targetLanguage, interactionLocale,
        interactionLanguage: resolveInteractionLanguage(interactionLocale), resolution: '720p',
        qualityProfile: 'fast', plannerVersion: '2', fidelityMode: 'high_fidelity',
        peopleMode: 'recreate', imageProvider: 'lululab_cli', videoProvider: 'lululab_cli',
        storyboardValidationMode: 'fast' },
      storyboards: { original: [], edited: [], generation: [] }, providerCapabilities: {},
      creators: [], creator: { mode: creatorMode, targetCreatorIds: [] }, creatorGeneration: {},
      videoBlueprint: { source: 'local_agent', file: '' }, videoPrompts: { file: '', segments: [] },
      videos: [], videoGeneration: { status: 'not_started', generated: false }, finalVideo: null,
      qualityReports: [], skillOptimizations: [], activeCandidate: 'candidate-01',
      workflowStatus: 'initialized',
    });
  }
  return manifest;
}

export async function setInteractionLocale(path, locale) {
  const normalized = normalizeLocale(locale);
  if (!normalized) throw new Error('A non-empty interaction locale is required.');
  return update(path, data => {
    const config = setDefault(data, 'userConfig', {});
    config.interactionLocale = normalized;
    config.interactionLanguage = resolveInteractionLanguage(normalized);
  });
}

export async function setJsonField(path, field, jsonFile) {
  const value = JSON.parse(await readFile(expand(jsonFile), 'utf8'));
  return update(path, data => { data[field] = value; });
}

export async function setBenchmarkAnalysis(path, analysisFile) {
  const source = expand(analysisFile), value = JSON.parse(await readFile(source, 'utf8'));
  if (!isObject(value.media)) throw new Error('基准视频分析缺少 media。');
  return update(path, data => {
    const benchmark = setDefault(data, 'benchmarkVideo', {});
    benchmark.analysis = { file: source, ...value };
    if (value.sourceFile) benchmark.file = expand(value.sourceFile);
    const config = setDefault(data, 'userConfig', {});
    if (value.targetDuration != null) config.duration = Number.parseInt(String(value.targetDuration), 10);
    if (value.durationMode != null) config.durationMode = String(value.durationMode);
    if (Object.hasOwn(value, 'requestedDuration')) config.requestedDuration = value.requestedDuration;
  });
}

export async function setProductReferences(path, images) {
  if (!images?.length) throw new Error('新产品替换必须至少提供一张产品参考图。');
  const normalized = [...new Set(await Promise.all(images.map(image => requireFile(image, '产品参考图'))))];
  return update(path, data => {
    const product = setDefault(data, 'product', {});
    if (!isObject(product)) throw new Error('manifest.product 必须是对象。');
    product.mode = 'replacement'; product.useBenchmarkProduct = false;
    const registered = new Map();
    for (const item of product.productImages ?? product.images ?? []) {
      const key = String(typeof item === 'string' ? item : item.file ?? item.filePath ?? '');
      registered.set(key, typeof item === 'string' ? { file: item } : { ...item });
    }
    for (const image of normalized) if (!registered.has(image)) registered.set(image, { file: image });
    product.productImages = [...registered.values()]; delete product.images;
  });
}

export async function registerProductUploads(path, images, { preserveOriginal = false } = {}) {
  const normalized = await Promise.all((images ?? []).map(image => requireFile(image, '产品参考图')));
  if (!normalized.length) throw new Error('至少需要一张产品参考图。');
  return update(path, data => {
    const product = setDefault(data, 'product', {});
    const existing = product.productImages ?? product.images ?? [];
    const paths = existing.map(item => String(typeof item === 'string' ? item : item.file ?? item.filePath ?? ''));
    product.productImages = [...new Set([...paths, ...normalized])]
      .map(file => ({ file, sourceType: 'user_provided' }));
    if (preserveOriginal) product.referenceIntent = 'preserve_original_identity';
  });
}

export async function setProviderCapabilities(path, capabilityFile) {
  const value = JSON.parse(await readFile(expand(capabilityFile), 'utf8'));
  if (!isObject(value)) throw new Error('providerCapabilities 必须为对象。');
  return update(path, data => { data.providerCapabilities = value; });
}

export function validatePromptRecord(prompts, data) {
  const segments = prompts?.segments;
  if (!Array.isArray(segments) || !segments.length) throw Error('本地智能体输出缺少非空 videoPrompts.segments。');
  const generationBoards = data.storyboards?.generation ?? [];
  if (!generationBoards.length) throw Error('Step 4 前必须登记 storyboards.generation。');
  const windows = data.benchmarkVideo?.analysis?.recommendedSegments ?? [];
  if (data.timelinePlan) {
    const blueprint = JSON.parse(readFileSync(expand(data.videoBlueprint.file), 'utf8')).videoBlueprint;
    const shots = blueprint['逐镜头拆解'], beats = blueprint['节奏结构'].dramaticBeats;
    const utterances = shots.flatMap(shot => shot['声音'].utterances);
    if (segments.length > windows.length) throw Error('Prompt超过锁定Segment数量');
    const byId = new Map(windows.map(window => [Number(window.segmentId), window]));
    for (const segment of segments) {
      const window = byId.get(Number(segment.segmentId));
      if (!window) throw Error(`Segment ${segment.segmentId} 不在锁定时间窗内`);
      if (['segmentId', 'globalStart', 'globalEnd', 'duration'].some(key => segment[key] !== window[key]))
        throw Error('Prompt改变了锁定时间窗');
      if (JSON.stringify(segment.storyboardIds) !== JSON.stringify([window.segmentId]))
        throw Error('Storyboard与Segment不对应');
      for (const [field, items, identifier] of [
        ['shotIds', shots, 'shotId'], ['beatIds', beats, 'beatId'], ['utteranceIds', utterances, 'utteranceId']]) {
        const expected = new Set(items.filter(item => item.start < window.globalEnd && item.end > window.globalStart)
          .map(item => item[identifier]));
        const actual = new Set(segment[field] ?? []);
        if (expected.size !== actual.size || [...expected].some(item => !actual.has(item)))
          throw Error(`Segment ${window.segmentId} 的${field}遗漏或越界`);
      }
      if (!generationBoards.some(board => Number(board.segmentId) === Number(window.segmentId)))
        throw Error(`Segment ${window.segmentId} 尚无已完成的生成分镜`);
    }
  }
  for (const segment of segments) {
    const context = segmentContext(data, segment);
    if (context) {
      const expected = new Set(context.creatorIds), actual = new Set(segment.creatorIds ?? []);
      if (expected.size !== actual.size || [...expected].some(item => !actual.has(item)))
        throw Error('Prompt的creatorIds必须覆盖完整镜头的目标人物');
      if (segment.productPresent !== context.productPresent)
        throw Error('Prompt的productPresent与完整镜头不一致');
    }
  }
  const seen = new Set();
  for (const [index, segment] of segments.entries()) {
    if (!isObject(segment)) throw Error(`videoPrompts.segments[${index + 1}] 必须是对象。`);
    const id = Number(segment.segmentId), duration = Number(segment.duration);
    if (!Number.isInteger(id) || id < 1 || seen.has(id) || !Number.isFinite(duration) || duration <= 0)
      throw Error(`Segment ${index + 1} 的 segmentId/duration 无法用于生成。`);
    seen.add(id);
    if (typeof segment.prompt !== 'string' || !segment.prompt.trim()) throw Error(`Segment ${id} 缺少非空 prompt。`);
    if (!Array.isArray(segment.storyboardIds) || !segment.storyboardIds.length)
      throw Error(`Segment ${id} 缺少 storyboardIds。`);
  }
}


export async function setPrompts(path, promptsFile) {
  const source = expand(promptsFile), payload = JSON.parse(await readFile(source, 'utf8'));
  const prompts = payload?.videoPrompts, data = await loadManifest(path);
  validatePromptRecord(prompts, data);
  const segments = prompts.segments;
  return update(path, async current => {
    const existing = current.videoPrompts ?? {}, merged = new Map((existing.segments ?? [])
      .map(item => [Number(item.segmentId), item]));
    const submitted = new Set((current.videos ?? []).filter(item => item.taskId ||
      item.attempts?.some(attempt => attempt.taskId)).map(item => Number(item.segmentId)));
    for (const item of segments) {
      const id = Number(item.segmentId);
      if (submitted.has(id) && merged.has(id) && JSON.stringify(merged.get(id)) !== JSON.stringify(item))
        throw Error(`Segment ${id} 已提交视频任务，禁止覆盖对应 Prompt。`);
      merged.set(id, item);
    }
    const record = {...existing, file: source, segments: [...merged].sort((a, b) => a[0] - b[0]).map(([, item]) => item)};
    if (isObject(prompts.qualitySpec)) record.qualitySpec = prompts.qualitySpec;
    if (isObject(prompts.adaptationPlan)) record.adaptationPlan = prompts.adaptationPlan;
    const mergedFile = join(dirname(source), `${basename(source, extname(source))}.registered.json`);
    const clean = {segments: record.segments};
    if (record.qualitySpec) clean.qualitySpec = record.qualitySpec;
    if (record.adaptationPlan) clean.adaptationPlan = record.adaptationPlan;
    await writeFile(`${mergedFile}.tmp`, JSON.stringify({videoPrompts: clean}, null, 2) + '\n');
    await rename(`${mergedFile}.tmp`, mergedFile);
    record.file = mergedFile;
    current.videoPrompts = record;
    if (record.adaptationPlan) (current.product ??= {}).adaptationPlan = record.adaptationPlan;
    current.workflowStatus = 'step4_complete';
  });
}

export async function setVideo(path, segmentId, status, fields = {}) {
  const {candidateId = 'candidate-01', ...other} = fields;
  return update(path, data => {
    const videos = data.videos ??= [];
    let entry = videos.find(item => Number(item.segmentId) === Number(segmentId));
    if (!entry) { entry = {segmentId}; videos.push(entry); }
    const clean = Object.fromEntries(Object.entries(other).filter(([, value]) => value != null && value !== ''));
    const attempts = entry.attempts ??= [];
    let attempt = attempts.find(item => item.candidateId === candidateId);
    if (!attempt) { attempt = {candidateId}; attempts.push(attempt); }
    Object.assign(attempt, {status, ...clean});
    Object.assign(entry, {candidateId, status, ...clean});
    videos.sort((a, b) => Number(a.segmentId) - Number(b.segmentId));
  });
}

export async function addCreator(path, image, creatorId, sourceType, {
  views = [], productFreeVerified = false, preserveOriginal = false} = {}) {
  const imagePath = await requireFile(image, 'Creator 图');
  const source = String(sourceType).trim().toLowerCase();
  if (!['user_provided', 'generated_multiview', 'ai_generated'].includes(source))
    throw Error('Creator来源无效；禁止登记原视频抽帧。');
  const normalized = [...new Set(views.map(x => String(x).trim().toLowerCase()).filter(Boolean))].sort();
  if (source !== 'user_provided') {
    const missing = ['front', 'back'].filter(x => !normalized.includes(x));
    if (!['side_profile', 'left_profile', 'right_profile'].some(x => normalized.includes(x)))
      missing.push('side_profile');
    if (source === 'ai_generated' && !normalized.includes('close_up')) missing.push('close_up');
    if (missing.length) throw Error(`生成的达人多视图缺少角度：${missing.join(', ')}`);
    if (!productFreeVerified) throw Error('生成的达人多视图必须完成无产品视觉检查。');
  }
  return update(path, data => {
    const creators = data.creators ??= [];
    const previous = creators.find(item => String(item.creatorId) === creatorId);
    if (previous?.sourceType === 'user_provided' && source !== 'user_provided')
      throw Error(`Creator ${creatorId} 已有用户上传图，不得用生成图覆盖。`);
    const entry = {creatorId, file: imagePath, sourceType: source,
      layout: source === 'user_provided' ? 'provided' : 'multi-view'};
    if (source === 'user_provided') {
      if (preserveOriginal || previous?.referenceIntent === 'preserve_original_identity')
        entry.referenceIntent = 'preserve_original_identity';
      if (previous?.sourceType === source) {
        entry.referenceImages = [...new Set([...(previous.referenceImages ?? [previous.file]), imagePath].filter(Boolean))];
        entry.file = entry.referenceImages[0];
      }
    } else {
      entry.views = normalized; entry.productFreeVerified = true;
      entry.imageProvider = source === 'ai_generated' ? 'lululab_cli' : 'agent_native';
    }
    data.creators = creators.filter(item => String(item.creatorId) !== creatorId);
    data.creators.push(entry);
  });
}

export async function setCreatorMode(path, mode, creatorIds = null, profile = null) {
  if (!['ai_generated', 'user_provided', 'keep_source'].includes(mode)) throw Error(`无效达人模式：${mode}`);
  const allowed = new Set(['targetCountry', 'gender', 'ageRange', 'appearanceStyle',
    'clothingStyle', 'vibe', 'otherRequirements']);
  if (profile != null && (!isObject(profile) || Object.entries(profile).some(([key, value]) =>
    !allowed.has(key) || typeof value !== 'string'))) throw Error('达人配置字段或类型无效。');
  const ids = [...new Set((creatorIds ?? []).map(x => String(x).trim()).filter(Boolean))];
  return update(path, data => {
    const creator = isObject(data.creator) ? {...data.creator} : {};
    creator.mode = mode;
    if (mode !== 'ai_generated') creator.targetCreatorIds = [];
    else if (creatorIds !== null) creator.targetCreatorIds = ids;
    Object.assign(creator, profile ?? {});
    data.creator = creator;
  });
}
export function nextCandidateId(data) {
  const numbers = (data.videos ?? []).flatMap(video => video.attempts ?? [])
    .map(item => /^candidate-(\d+)$/.exec(String(item.candidateId || ''))?.[1])
    .filter(Boolean).map(Number);
  return `candidate-${String(Math.max(0, ...numbers) + 1).padStart(2, '0')}`;
}
export async function setQualityReport(path, candidateId, reportFile) {
  const source = await requireFile(reportFile, '质量报告');
  const report = JSON.parse(await readFile(source, 'utf8'));
  const digest = await fileSha256(source);
  return update(path, data => {
    const reports = data.qualityReports ??= [];
    data.qualityReports = reports.filter(item => item.candidateId !== candidateId);
    data.qualityReports.push({candidateId, file: source, sha256: digest,
      status: report.status ?? 'reported', passed: Boolean(report.passed), deliveryBlocked: false});
    if (data.finalVideo?.candidateId === candidateId) {
      data.finalVideo.qualityReport = source;
      data.finalVideo.qualityStatus = report.status ?? 'reported';
      data.finalVideo.qualityPassed = Boolean(report.passed);
      data.workflowStatus = 'complete';
    }
  });
}
export function normalizeReplacementRecord(value) {
  if (!isObject(value)) throw Error('replacement 必须是对象。');
  const record = {...value}, attempts = Number(record.generationAttempts ?? 0), maximum = Number(record.maxImageEditAttempts ?? 1);
  if (![1, 2].includes(maximum) || !Number.isInteger(attempts) || attempts < 0 || attempts > maximum)
    throw Error('replacement.generationAttempts 超过 maxImageEditAttempts。');
  const validFile = path => {try {const info = statSync(expand(path)); return info.isFile() && info.size > 0;} catch {return false;}};
  const sha = path => createHash('sha256').update(readFileSync(expand(path))).digest('hex');
  const edited = String(record.editedImageFile || ''), final = String(record.finalImageFile || '');
  const artifact = key => {
    const raw = String(record[key] ?? '').trim(); if (!raw) return ['', null];
    const path = expand(raw); if (!validFile(path)) return [path, null];
    try {const value = JSON.parse(readFileSync(path, 'utf8')); return [path, isObject(value) ? value : null];}
    catch {return [path, null];}
  };
  if (record.method === 'whole-board-fast-v1') {
  const evidenceFile = String(record.fastPrepareFile || '');
  let evidence = null;
  if (validFile(evidenceFile)) try {evidence = JSON.parse(readFileSync(expand(evidenceFile), 'utf8'));} catch {}
  let matches = Boolean(isObject(evidence) && evidence.method === 'whole-board-fast-v1' &&
    evidence.validationLevel === 'mechanical' && evidence.layoutRestored === true &&
    evidence.labelsRestored === true);
  for (const [path, key] of [[edited, 'editedSha256'], [final, 'finalSha256'],
    [evidence?.originalFile || '', 'originalSha256']])
    matches = matches && validFile(path) && sha(path) === evidence[key];
  const conditions = {imageEditSucceeded: Boolean(record.imageEditSucceeded) && attempts === 1 &&
      maximum === 1 && validFile(edited), layoutRestored: matches,
    artifactIntegrityVerified: matches && validFile(final)};
  const verified = Boolean(record.applied) && record.validationLevel === 'mechanical' &&
    Object.values(conditions).every(Boolean);
  if (record.replacementVerified && !verified)
    throw Error('replacementVerified=true 与快速模式机械验证状态不一致：' +
      Object.entries(conditions).filter(([, ok]) => !ok).map(([key]) => key).join('、'));
  Object.assign(record, conditions, {generationAttempts: attempts, maxImageEditAttempts: maximum,
    editedImageFile: validFile(edited) ? expand(edited) : edited,
    finalImageFile: validFile(final) ? expand(final) : final,
    fastPrepareFile: validFile(evidenceFile) ? expand(evidenceFile) : evidenceFile,
    validationLevel: 'mechanical', visualReviewRequired: false,
    fullBoardVisualReviewRequired: false, replacementVerified: verified});
  delete record.visualReviewPassed;
  return record;
  }
  const [mapFile, mapValue] = artifact('mapFile'), [lockFile, lockValue] = artifact('lockMergeFile');
  let map = null;
  if (mapValue) try {map = normalizeReplacementMap(mapValue);} catch {}
  const mappedEditable = map?.editableCells ?? [], mappedFrozen = map?.frozenCells ?? [];
  const requestedEditable = [...new Set((record.editableCells ?? []).map(Number))].sort((a,b) => a-b);
  const requestedFrozen = [...new Set((record.frozenCells ?? []).map(Number))].sort((a,b) => a-b);
  const arraysEqual = (a,b) => JSON.stringify(a) === JSON.stringify(b);
  const mapValid = Boolean(record.mapValid && map && arraysEqual(requestedEditable, mappedEditable) && arraysEqual(requestedFrozen, mappedFrozen));
  const base = {imageEditSucceeded: Boolean(record.imageEditSucceeded) && attempts >= 1 && validFile(edited), mapValid};
  const finalValid = validFile(final), digestMatches = (evidence, bindings) =>
    bindings.every(([file, key]) => validFile(file) && sha(file) === evidence?.[key]);
  let conditions, verified;
  if (record.method === 'local-board-direct') {
    conditions = {...base, sourceImageUnmodified: record.sourceImageUnmodified === true && validFile(edited) && finalValid &&
      expand(edited) === expand(final) && Boolean(record.localOutputSha256) && sha(final) === record.localOutputSha256};
    verified = Boolean(record.applied) && Object.values(conditions).every(Boolean);
    if (record.replacementVerified && !verified) throw Error('replacementVerified=true 与本地目标板验证状态不一致。');
    Object.assign(record, conditions, {generationAttempts: attempts, maxImageEditAttempts: maximum,
      editedImageFile: finalValid ? expand(final) : edited, finalImageFile: finalValid ? expand(final) : final,
      mapFile, editableCells: requestedEditable, frozenCells: requestedFrozen,
      fullBoardVisualReviewRequired: false, visualReviewRequired: false, replacementVerified: verified});
    delete record.visualReviewPassed; return record;
  }
  const commonEvidence = Boolean(lockValue && lockValue.editableCells && arraysEqual(lockValue.editableCells, mappedEditable) &&
    arraysEqual(lockValue.frozenCells, mappedFrozen) && digestMatches(lockValue,
      [[edited,'editedSha256'],[mapFile,'mapSha256'],[final,'finalSha256'],[lockValue.originalFile,'originalSha256']]));
  if (record.method === 'whole-board-visual-review' || record.method === 'whole-board-user-review') {
    const direct = record.method === 'whole-board-visual-review';
    const evidence = commonEvidence && lockValue.method === record.method && lockValue.layoutRestored === true &&
      lockValue.labelsRestored === true && map?.mergeMode === (direct ? 'whole-board-direct-v1' : 'object-regions-v1') &&
      (direct ? lockValue.mergeMode === 'whole-board-direct-v1' && lockValue.fullBoardVisualReviewRequired === true :
        lockValue.mapValid === true && lockValue.fullBoardUserReviewRequired === true);
    const review = isObject(record.visualReview) ? record.visualReview : {};
    const reviewPassed = direct ? review.targetCorrect === true && review.protectedCorrect === true && finalValid &&
      review.imageSha256 === sha(final) && validFile(mapFile) && review.mapSha256 === sha(mapFile) :
      record.userConfirmed === true && finalValid && record.confirmedImageSha256 === sha(final);
    conditions = {...base, layoutRestored: Boolean(record.layoutRestored && evidence),
      [direct ? 'fullBoardVisualReviewRequired' : 'fullBoardUserReviewRequired']: true,
      [direct ? 'visualReviewPassed' : 'userConfirmed']: reviewPassed};
    verified = Boolean(record.applied) && Object.values(conditions).every(Boolean);
    if (record.replacementVerified && !verified) throw Error('replacementVerified=true 与实际验证状态不一致。');
    Object.assign(record, conditions, {generationAttempts: attempts, maxImageEditAttempts: maximum,
      editedImageFile: validFile(edited) ? expand(edited) : edited, mapFile, lockMergeFile: lockFile,
      finalImageFile: finalValid ? expand(final) : final, editableCells: requestedEditable,
      frozenCells: requestedFrozen, replacementVerified: verified});
    return record;
  }
  let lockMatches = Boolean(commonEvidence && lockValue.method === 'whole-board-lock-merge' &&
    lockValue.mapValid === true && lockValue.lockMergeSucceeded === true);
  if (map?.mergeMode === 'object-regions-v1' || lockValue?.mergeMode === 'object-regions-v1') {
    lockMatches = Boolean(lockMatches && map?.mergeMode === 'object-regions-v1' && map.compositionMode === 'region-lock-v1' &&
      lockValue.mergeMode === 'object-regions-v1' && lockValue.compositionMode === 'region-lock-v1' &&
      lockValue.editRule === map.editRule && lockValue.protectedPixelsRestored === true &&
      lockValue.outsideMaskChangedPixels === 0 && validFile(lockValue.maskFile) && sha(lockValue.maskFile) === lockValue.maskSha256);
  }
  conditions = {...base, lockMergeSucceeded: Boolean(record.lockMergeSucceeded && lockMatches),
    frozenCellsRestored: Boolean(record.frozenCellsRestored && lockMatches && lockValue.frozenCellsRestored === true)};
  verified = Boolean(record.applied) && record.method === 'whole-board-lock-merge' && Object.values(conditions).every(Boolean);
  if (record.replacementVerified && !verified) throw Error('replacementVerified=true 与实际验证状态不一致。');
  Object.assign(record, conditions, {generationAttempts: attempts, maxImageEditAttempts: maximum,
    editedImageFile: validFile(edited) ? expand(edited) : edited, mapFile, lockMergeFile: lockFile,
    finalImageFile: finalValid ? expand(final) : final, editableCells: requestedEditable,
    frozenCells: requestedFrozen, replacementVerified: verified});
  if (map?.mergeMode === 'object-regions-v1' && lockValue) Object.assign(record,
    {mergeMode: lockValue.mergeMode, compositionMode: lockValue.compositionMode,
      protectedPixelsRestored: lockValue.protectedPixelsRestored === true,
      outsideMaskChangedPixels: lockValue.outsideMaskChangedPixels});
  return record;
}

export async function setGenerationStoryboards(path, metadataFile) {
  const source = expand(metadataFile), value = JSON.parse(await readFile(source, 'utf8'));
  const boards = value?.boards;
  if (!Array.isArray(boards) || !boards.length) throw Error('段内 Storyboard 元数据缺少非空 boards。');
  const normalized = [], seen = new Set();
  for (const item of boards) {
    const boardId = Number(item.storyboardId), segmentId = Number(item.segmentId);
    if (seen.has(boardId)) throw Error(`段内 Storyboard ID 重复：${boardId}`);
    seen.add(boardId);
    const filePath = await requireFile(String(item.file), '段内 Storyboard');
    const start = Number(item.globalStart), end = Number(item.globalEnd),
      localStart = Number(item.localStart ?? 0), localEnd = Number(item.localEnd);
    if (end <= start || Math.abs(localStart) > .01 || Math.abs(localEnd - (end - start)) > .01)
      throw Error(`段内 Storyboard ${boardId} 时间范围无效。`);
    const anchors = item.anchors ?? [];
    if (!Array.isArray(anchors) || ![9, 16].includes(anchors.length))
      throw Error(`段内 Storyboard ${boardId} 必须包含9或16个锚点。`);
    const entry = {storyboardId: boardId, segmentId, file: filePath,
      layout: anchors.length === 16 ? '4x4' : '3x3', globalStart: start, globalEnd: end,
      localStart, localEnd, replacementVerified: Boolean(item.replacementVerified), anchors};
    if (isObject(item.replacement)) {
      entry.replacement = normalizeReplacementRecord(item.replacement);
      entry.replacementVerified = Boolean(entry.replacement.replacementVerified);
      if (entry.replacement.applied && !entry.replacementVerified)
        throw Error(`段内 Storyboard ${boardId} 尚未完成本地文件完整性登记。`);
    }
    normalized.push(entry);
  }
  normalized.sort((a, b) => a.segmentId - b.segmentId);
  return update(path, data => {
    (data.storyboards ??= {}).generation = normalized;
    data.schemaRevision = '5.3'; data.generationStoryboardStatus = 'ready';
  });
}

export function anchorsFromPayload(payload, boardId) {
  let anchors;
  if (Array.isArray(payload)) anchors = payload;
  else if (isObject(payload) && Array.isArray(payload.boards)) {
    const board = payload.boards.find(x => Number(x.storyboardId ?? x.segmentId ?? -1) === Number(boardId));
    if (!board) throw Error(`Storyboard metadata 中没有 storyboardId=${boardId}。`);
    anchors = board.anchors;
  } else throw Error('anchors 文件必须是9项数组或 storyboard-metadata.json。');
  if (!Array.isArray(anchors) || ![9, 16].includes(anchors.length))
    throw Error(`Storyboard ${boardId} 必须包含9或16个 anchors。`);
  return anchors;
}

export async function addStoryboard(path, kind, image, boardId, {anchors = null, quality = null, replacement = null} = {}) {
  if (!['original','edited','generation'].includes(kind)) throw Error(`无效 Storyboard 类型：${kind}`);
  const imagePath = await requireFile(image, 'Storyboard'), id = Number(boardId);
  if (!Number.isInteger(id) || id < 1) throw Error('Storyboard ID 必须是正整数。');
  return update(path, data => {
    const boards = data.storyboards[kind];
    const entry = {storyboardId: id, file: imagePath, layout: anchors?.length === 16 ? '4x4' : '3x3', realFrames: kind === 'original'};
    if (anchors) entry.anchors = anchors;
    if (quality) entry.quality = quality;
    if (replacement) {
      if (kind !== 'edited') throw Error('replacement metadata 只能登记到 edited Storyboard。');
      entry.replacement = normalizeReplacementRecord(replacement);
      entry.replacementVerified = Boolean(entry.replacement.replacementVerified);
    }
    data.storyboards[kind] = [...boards.filter(x => Number(x.storyboardId) !== id), entry]
      .sort((a, b) => Number(a.storyboardId) - Number(b.storyboardId));
    data.workflowStatus = kind === 'original' ? 'step1_complete' : kind === 'edited' ? 'step2_complete' : 'step2_artifact_incomplete';
  });
}

export async function addOriginalStoryboardsFromMetadata(path, metadataFile) {
  const payload = JSON.parse(await readFile(expand(metadataFile), 'utf8'));
  if (!Array.isArray(payload?.boards) || !payload.boards.length)
    throw Error('Storyboard metadata 缺少非空 boards 数组。');
  const entries = [], seen = new Set();
  for (const board of payload.boards) {
    const id = Number(board.storyboardId ?? board.segmentId ?? -1);
    if (!Number.isInteger(id) || id < 1 || seen.has(id)) throw Error(`Storyboard metadata 含无效或重复ID：${id}`);
    seen.add(id);
    if (!['3x3','4x4'].includes(String(board.layout ?? payload.layout ?? '')))
      throw Error(`Storyboard ${id} 不是3x3布局。`);
    entries.push({storyboardId: id, file: await requireFile(board.file ?? '', `Storyboard ${id}`),
      layout: board.layout ?? '3x3', realFrames: true, anchors: anchorsFromPayload(payload, id)});
  }
  return update(path, data => {
    const existing = new Map(data.storyboards.original.filter(x => !seen.has(Number(x.storyboardId)))
      .map(x => [Number(x.storyboardId), x]));
    for (const entry of entries) existing.set(entry.storyboardId, entry);
    data.storyboards.original = [...existing.values()].sort((a,b) => Number(a.storyboardId)-Number(b.storyboardId));
    data.workflowStatus = 'step1_complete';
  });
}

export async function setReplacementBindings(path, bindingsFile) {
  const {loadBlueprint, validateBindings} = await import('./entity_bindings.mjs');
  const data = await loadManifest(path), bp = loadBlueprint(data);
  if (!bp) throw Error('旧蓝图不自动迁移；replacementBindings仅用于Blueprint 7.0');
  const payload = JSON.parse(await readFile(expand(bindingsFile), 'utf8'));
  data.replacementBindings = payload.replacementBindings;
  validateBindings(data, bp);
  return update(path, current => {current.replacementBindings = data.replacementBindings;});
}

export async function setAudioReview(path, reviewFile) {
  const source = expand(reviewFile), payload = JSON.parse(await readFile(source, 'utf8'));
  const review = payload?.audioReview;
  if (!isObject(review) || !['transcript_ready','verified_no_speech','no_audio'].includes(review.status) ||
      !Array.isArray(review.segments) || review.audioUploaded !== false)
    throw Error('audioReview 文件缺少有效的本地转写状态、segments 或 audioUploaded=false。');
  return update(path, data => {data.audioReview = {...review, file: source};});
}

export async function setVideoBlueprint(path, blueprintFile) {
  const source = await requireFile(blueprintFile, 'videoBlueprint');
  const payload = JSON.parse(await readFile(source, 'utf8')), blueprint = payload?.videoBlueprint;
  if (!isObject(blueprint) || !Object.keys(blueprint).length) throw Error('本地智能体输出缺少 videoBlueprint。');
  if (blueprint.schemaVersion != null && blueprint.schemaVersion !== '6.0') {
    const {validateBlueprint} = await import('./entity_bindings.mjs'); validateBlueprint(blueprint);
  }
  return update(path, data => {
    const previous = data.videoBlueprint ?? {};
    data.videoBlueprint = {...previous, source: 'local_agent', file: source};
    if (previous.file) data.videoBlueprint.sourceFile = previous.sourceFile ?? previous.file;
  });
}

const proposalClasses = new Set(['skill_actionable','task_specific','provider_limited','insufficient_evidence']);
const acceptedTargetSkills = new Set(['LuluLab-Recreate-Video','recreate-video-agent','recreate-video-system',
  'recreate-product-video','recreate-product-video-v4']);
const equalSets = (a,b) => a.size === b.size && [...a].every(x => b.has(x));
export function validateSkillOptimizationProposal(proposal, report, candidateId) {
  if (proposal?.proposalVersion !== '1.0') throw Error('技能优化方案 proposalVersion 必须为 1.0。');
  if (String(proposal.candidateId) !== candidateId) throw Error('技能优化方案 candidateId 与质量报告不一致。');
  if (!acceptedTargetSkills.has(proposal.targetSkill)) throw Error('技能优化方案 targetSkill 无效。');
  if (proposal.confirmationPhrase !== '确认优化 skill') throw Error('技能优化方案 confirmationPhrase 必须为“确认优化 skill”。');
  if (report?.status !== 'failed' || Boolean(report.passed)) throw Error('只有最终状态为 failed 的质量报告可以登记技能优化方案。');
  const {issues, changes, exclusions} = proposal;
  if (!Array.isArray(issues) || !issues.length) throw Error('技能优化方案 issues 必须为非空数组。');
  if (!Array.isArray(changes) || !Array.isArray(exclusions)) throw Error('技能优化方案 changes 和 exclusions 必须为数组。');
  const findings = report.findings ?? [], hard = (report.hardFailures ?? []).map(String);
  if (!Array.isArray(findings)) throw Error('质量报告 findings 必须为数组。');
  const issueIds = new Set(), findingCoverage = new Set(), hardCoverage = new Set(), classifications = new Map();
  for (const issue of issues) {
    if (!isObject(issue)) throw Error('技能优化方案 issue 必须为对象。');
    const id = String(issue.issueId ?? '').trim(), cls = String(issue.classification ?? '').trim();
    if (!id || issueIds.has(id)) throw Error('技能优化方案 issueId 不能为空或重复。');
    if (!proposalClasses.has(cls)) throw Error(`技能优化方案分类无效：${cls}`);
    if (!String(issue.evidence ?? '').trim() || !String(issue.reason ?? '').trim()) throw Error(`技能优化方案 ${id} 缺少 evidence 或 reason。`);
    issueIds.add(id); classifications.set(id, cls);
    if (!Array.isArray(issue.sourceFindingIndices ?? []) || !Array.isArray(issue.hardFailureCodes ?? []))
      throw Error(`技能优化方案 ${id} 的来源字段必须为数组。`);
    for (const index of issue.sourceFindingIndices ?? []) {
      if (!Number.isInteger(index) || index < 0 || index >= findings.length) throw Error(`技能优化方案 ${id} 引用了无效 finding 索引。`);
      findingCoverage.add(index);
    }
    for (const code of issue.hardFailureCodes ?? []) {
      if (!hard.includes(String(code))) throw Error(`技能优化方案 ${id} 引用了未知 hardFailure：${code}`);
      hardCoverage.add(String(code));
    }
  }
  if (!equalSets(findingCoverage, new Set(findings.map((_,i) => i)))) throw Error('技能优化方案必须覆盖质量报告中的每条 finding。');
  if (!equalSets(hardCoverage, new Set(hard))) throw Error('技能优化方案必须覆盖质量报告中的每个 hardFailure。');
  const changeIds = new Set(), addressed = new Set(), paths = [];
  for (const change of changes) {
    if (!isObject(change)) throw Error('技能优化方案 change 必须为对象。');
    const id = String(change.changeId ?? '').trim();
    if (!id || changeIds.has(id)) throw Error('技能优化方案 changeId 不能为空或重复。');
    changeIds.add(id); paths.push(optimizationRelativePath(String(change.path ?? '')));
    for (const key of ['section','change','expectedEffect']) if (!String(change[key] ?? '').trim()) throw Error(`技能优化方案 ${id} 缺少 ${key}。`);
    if (!Array.isArray(change.risks) || !Array.isArray(change.tests)) throw Error(`技能优化方案 ${id} 的 risks 和 tests 必须为数组。`);
    if (!Array.isArray(change.addresses) || !change.addresses.length) throw Error(`技能优化方案 ${id} 必须引用至少一个 issue。`);
    for (const issueId of change.addresses) {
      if (classifications.get(String(issueId)) !== 'skill_actionable') throw Error(`技能优化修改只能引用 skill_actionable issue：${issueId}`);
      addressed.add(String(issueId));
    }
  }
  const actionable = new Set([...classifications].filter(([,cls]) => cls === 'skill_actionable').map(([id]) => id));
  if (!equalSets(addressed, actionable)) throw Error('每个 skill_actionable issue 必须由 changes 覆盖。');
  const excluded = new Set();
  for (const item of exclusions) {
    if (!isObject(item)) throw Error('技能优化方案 exclusion 必须为对象。');
    const id = String(item.issueId ?? '');
    if (!classifications.has(id) || classifications.get(id) === 'skill_actionable') throw Error(`技能优化排除项引用无效：${id}`);
    if (excluded.has(id) || !String(item.reason ?? '').trim()) throw Error('技能优化排除项重复或缺少原因。');
    excluded.add(id);
  }
  if (!equalSets(excluded, new Set([...issueIds].filter(id => !actionable.has(id)))))
    throw Error('exclusions 必须恰好覆盖全部非 skill_actionable issue。');
  if (!Array.isArray(proposal.acceptanceTests)) throw Error('技能优化方案 acceptanceTests 必须为数组。');
  return {paths, status: changes.length ? 'proposed' : 'no_change', issueCount: issues.length, changeCount: changes.length};
}

export async function setSkillOptimizationProposal(path, candidateId, proposalFile) {
  const proposalPath = await requireFile(proposalFile, '技能优化方案');
  const proposal = JSON.parse(await readFile(proposalPath, 'utf8')), data = await loadManifest(path);
  const reportEntry = (data.qualityReports ?? []).findLast(x => x.candidateId === candidateId);
  if (!reportEntry) throw Error(`候选 ${candidateId} 没有质量报告。`);
  const reportPath = await requireFile(reportEntry.file, '质量报告');
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const validated = validateSkillOptimizationProposal(proposal, report, candidateId);
  const reportDigest = await fileSha256(reportPath), proposalDigest = await fileSha256(proposalPath);
  const fingerprints = await skillFileFingerprints(validated.paths), version = await skillVersion();
  return update(path, current => {
    const records = current.skillOptimizations ??= [];
    let record = records.findLast(x => x.candidateId === candidateId && x.qualityReportSha256 === reportDigest);
    if (!record) {record = {candidateId, qualityReport: reportPath, qualityReportSha256: reportDigest, createdAt: now()}; records.push(record);}
    for (const item of records) if (item !== record && item.candidateId === candidateId &&
      ['proposal_required','proposed'].includes(item.status)) {item.status = 'stale'; item.staleAt = now();}
    Object.assign(record, {proposalId: `${candidateId}-${proposalDigest.slice(0,12)}`, proposalFile: proposalPath,
      proposalSha256: proposalDigest, sourceSkillVersion: version, sourceFileFingerprints: fingerprints,
      issueCount: validated.issueCount, changeCount: validated.changeCount, status: validated.status, proposedAt: now()});
  });
}

export async function setSkillOptimizationResult(path, candidateId, proposalFile, status, validationFile = null) {
  if (!['applied','rolled_back','stale'].includes(status)) throw Error('技能优化结果状态必须为 applied、rolled_back 或 stale。');
  const proposalPath = await requireFile(proposalFile, '技能优化方案'), digest = await fileSha256(proposalPath);
  const validationPath = validationFile ? await requireFile(validationFile, '技能优化验证报告') : null;
  const validation = validationPath ? JSON.parse(await readFile(validationPath, 'utf8')) : null;
  if (status === 'applied' && (!isObject(validation) || validation.passed !== true)) throw Error('登记 applied 必须提供 passed=true 的验证报告。');
  if (status === 'rolled_back' && (!isObject(validation) || validation.passed === true)) throw Error('登记 rolled_back 必须提供 passed=false 的验证报告。');
  const version = status === 'applied' ? await skillVersion() : null;
  return update(path, async data => {
    const record = (data.skillOptimizations ?? []).findLast(x => x.candidateId === candidateId && x.proposalSha256 === digest);
    if (!record || record.status === 'no_change') throw Error('manifest 中没有匹配的技能优化方案，或方案内容已变化。');
    Object.assign(record, {status, resultAt: now()});
    if (validationPath) record.validationReport = validationPath;
    if (status === 'applied') {
      record.appliedSkillVersion = version;
      record.appliedFileFingerprints = await skillFileFingerprints(Object.keys(record.sourceFileFingerprints ?? {}));
    }
  });
}

export async function commandSetFinal({ manifest, outputFile, segmentIds = [], candidateId = 'candidate-01' }) {
  const output = await requireFile(outputFile, '最终视频');
  return update(manifest, data => {
    data.finalVideo = { file: output, segmentIds: [...segmentIds], candidateId: String(candidateId) };
    data.activeCandidate = String(candidateId);
    data.workflowStatus = 'complete';
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2], flags = {};
  try {
    for (let index = 3; index < process.argv.length; index++) {
      const flag = process.argv[index];
      if (!flag.startsWith('--')) throw new Error(`unrecognized argument: ${flag}`);
      if (['--reuse', '--preserve-original', '--product-free-verified'].includes(flag)) flags[flag] = true;
      else {
        const value = process.argv[++index];
        if (value == null) throw new Error(`argument ${flag}: expected one argument`);
        if (['--image', '--creator-id', '--view', '--segment-id'].includes(flag)) (flags[flag] ??= []).push(value);
        else flags[flag] = value;
      }
    }
    const required = flag => {
      if (!flags[flag]) throw new Error(`missing ${flag}`);
      return flags[flag];
    };
    let result;
    if (command === 'init') result = await commandInit({
      taskId: required('--task-id'), outputRoot: required('--output-root'), reuse: flags['--reuse'],
      videoModel: flags['--video-model'], durationMode: flags['--duration-mode'],
      targetDuration: flags['--target-duration'] == null ? null : Number(flags['--target-duration']),
      customRequirement: flags['--custom-requirement'], targetCountry: flags['--target-country'],
      targetLanguage: flags['--target-language'], creatorMode: flags['--creator-mode'],
      interactionLocale: flags['--interaction-locale'], codexLocale: flags['--codex-locale'],
    });
    else if (command === 'set-interaction-locale')
      result = await setInteractionLocale(required('--manifest'), required('--interaction-locale'));
    else if (command === 'set-benchmark-analysis')
      result = await setBenchmarkAnalysis(required('--manifest'), required('--file'));
    else if (command === 'set-product-references')
      result = await setProductReferences(required('--manifest'), required('--image'));
    else if (command === 'register-product-uploads')
      result = await registerProductUploads(required('--manifest'), required('--image'),
        { preserveOriginal: Boolean(flags['--preserve-original']) });
    else if (command === 'set-provider-capabilities')
      result = await setProviderCapabilities(required('--manifest'), required('--file'));
    else if (command === 'set-prompts')
      result = await setPrompts(required('--manifest'), required('--file'));
    else if (command === 'set-video')
      result = await setVideo(required('--manifest'), Number(required('--segment-id')),
        required('--status'), {taskId: flags['--task-id'], output_file: flags['--output-file'],
          candidateId: flags['--candidate-id']});
    else if (command === 'add-creator')
      result = await addCreator(required('--manifest'), required('--image')[0],
        required('--creator-id')[0], required('--source-type'),
        {views: flags['--view'] ?? [], productFreeVerified: Boolean(flags['--product-free-verified']),
          preserveOriginal: Boolean(flags['--preserve-original'])});
    else if (command === 'set-creator-mode')
      result = await setCreatorMode(required('--manifest'), required('--mode'), flags['--creator-id'] ?? null,
        flags['--profile-file'] ? JSON.parse(await readFile(expand(flags['--profile-file']), 'utf8')) : null);
    else if (command === 'set-generation-storyboards')
      result = await setGenerationStoryboards(required('--manifest'), required('--metadata-file'));
    else if (command === 'add-storyboards-from-metadata')
      result = await addOriginalStoryboardsFromMetadata(required('--manifest'), required('--metadata-file'));
    else if (command === 'add-storyboard')
      result = await addStoryboard(required('--manifest'), required('--kind'), required('--image')[0],
        Number(required('--storyboard-id')), {
          anchors: flags['--anchors-file'] ? anchorsFromPayload(JSON.parse(await readFile(expand(flags['--anchors-file']), 'utf8')),
            Number(flags['--storyboard-id'])) : null,
          quality: flags['--quality-file'] ? JSON.parse(await readFile(expand(flags['--quality-file']), 'utf8')) : null,
          replacement: flags['--replacement-file'] ? JSON.parse(await readFile(expand(flags['--replacement-file']), 'utf8')) : null,
        });
    else if (command === 'set-replacement-bindings')
      result = await setReplacementBindings(required('--manifest'), required('--file'));
    else if (command === 'set-audio-review')
      result = await setAudioReview(required('--manifest'), required('--file'));
    else if (command === 'set-video-blueprint')
      result = await setVideoBlueprint(required('--manifest'), required('--file'));
    else if (command === 'set-final')
      result = await commandSetFinal({manifest: required('--manifest'), outputFile: required('--output-file'),
        segmentIds: (flags['--segment-id'] ?? []).map(Number), candidateId: flags['--candidate-id'] ?? 'candidate-01'});
    else if (command === 'set-quality-report')
      result = await setQualityReport(required('--manifest'), required('--candidate-id'), required('--file'));
    else if (command === 'set-skill-optimization-proposal')
      result = await setSkillOptimizationProposal(required('--manifest'), required('--candidate-id'), required('--file'));
    else if (command === 'set-skill-optimization-result')
      result = await setSkillOptimizationResult(required('--manifest'), required('--candidate-id'), required('--proposal'),
        required('--status'), flags['--validation-file'] ?? null);
    else throw new Error(`unsupported manifest command: ${command}`);
    console.log(JSON.stringify({ ok: true, manifest: result }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
