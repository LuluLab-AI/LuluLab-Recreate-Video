#!/usr/bin/env node
/** Audit final storyboard, product, and creator references before paid video tasks. */
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve, extname} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {loadBlueprint, segmentContext} from './entity_bindings.mjs';
import {normalizeReplacementRecord} from './generation_manifest.mjs';

const expand = p => resolve(String(p).replace(/^~(?=\/|$)/, homedir()));
const obj = x => x && typeof x === 'object' && !Array.isArray(x);
const file = x => typeof x === 'string' ? x : x?.file || x?.filePath || '';
const exists = path => {try {return fs.statSync(path).isFile() && fs.statSync(path).size > 0;} catch {return false;}};
const sameSet = (a, b) => a.size === b.size && [...a].every(x => b.has(x));
export const fileSha256 = path => createHash('sha256').update(fs.readFileSync(expand(path))).digest('hex');
export function deduplicateFiles(files) {
  const result = [], seen = new Set();
  for (const raw of files) {
    const path = expand(raw);
    if (!exists(path)) throw Error(`参考图不存在或为空：${path}`);
    const digest = fileSha256(path);
    if (!seen.has(digest)) {result.push(raw); seen.add(digest);}
  }
  return result;
}
export function uploadedProductFiles(manifest) {
  const product = manifest.product;
  if (!obj(product)) return [];
  const values = product.productImages || product.images || [];
  if (!Array.isArray(values)) throw Error('product.productImages/images 必须是数组。');
  return deduplicateFiles(values.map(file));
}
export const uploadedCreatorFiles = manifest => deduplicateFiles((manifest.creators ?? [])
  .filter(x => obj(x) && x.sourceType === 'user_provided')
  .flatMap(x => x.referenceImages ?? [x.file]).map(String));
export function useBenchmarkProduct(manifest) {
  const product = manifest.product ?? {}, mode = String(product.mode || '').trim().toLowerCase();
  return product.useBenchmarkProduct === true || ['benchmark', 'use_benchmark', 'original'].includes(mode);
}
export function auditSubmissionFiles(manifest, files, {segmentId, selectedCreatorIds = null}) {
  const actual = deduplicateFiles(files), products = uploadedProductFiles(manifest),
    creators = uploadedCreatorFiles(manifest), product = manifest.product ?? {};
  if (products.length && useBenchmarkProduct(manifest) && product.productImages?.some(x => x?.sourceType === 'user_provided') &&
    product.referenceIntent !== 'preserve_original_identity')
    throw Error('用户上传产品图与沿用原产品的选择存在冲突；请明确图片仅用于原产品身份参考。');
  const preserved = new Set((manifest.replacementBindings ?? []).filter(x => x.entityType === 'character' && x.mode === 'preserve')
    .map(x => String(x.targetId)));
  for (const creator of manifest.creators ?? []) if (creator.sourceType === 'user_provided' &&
    preserved.has(String(creator.creatorId)) && creator.referenceIntent !== 'preserve_original_identity')
    throw Error('用户上传达人图与沿用原人物的选择存在冲突；请明确图片仅用于原人物身份参考。');
  const hashes = values => new Set(values.map(fileSha256));
  const covered = hashes(actual);
  for (const value of actual) {
    const path = expand(value), provenance = `${path}.sources.json`;
    if (exists(provenance)) try {
      const record = JSON.parse(fs.readFileSync(provenance, 'utf8'));
      if (record.outputSha256 === fileSha256(path)) for (const digest of record.sourceSha256 ?? []) covered.add(digest);
    } catch {}
  }
  let aiTargets = new Set(manifest.creator?.targetCreatorIds ?? []);
  if (selectedCreatorIds) aiTargets = new Set([...aiTargets].filter(x => selectedCreatorIds.has(x)));
  const ai = (manifest.creators ?? []).filter(x => x.sourceType === 'ai_generated' && aiTargets.has(String(x.creatorId)))
    .map(x => String(x.file));
  const missing = [...hashes([...products, ...creators, ...ai])].filter(x => !covered.has(x));
  if (missing.length) throw Error(`Segment ${segmentId} 最终 referenceImages 缺少用户上传参考图或 AI 身份板。`);
  return {productImages: products, creatorImages: creators, aiCreatorImages: ai};
}
export const storyboardValidationMode = () => 'fast';
export function segmentCount(manifest) {
  const prompts = manifest.videoPrompts?.segments ?? [];
  if (prompts.length) return prompts.length;
  const boards = manifest.storyboards?.generation ?? [];
  if (boards.length) return new Set(boards.map(x => Number(x.segmentId ?? x.storyboardId ?? -1))).size;
  return manifest.benchmarkVideo?.analysis?.recommendedSegments?.length ?? 0;
}
export function crossSegmentCreatorIds(manifest) {
  let prompts = manifest.videoPrompts?.segments ?? [];
  if (loadBlueprint(manifest)) prompts = (manifest.benchmarkVideo?.analysis?.recommendedSegments ?? [])
    .map(window => ({...window, creatorIds: segmentContext(manifest, window).creatorIds}));
  const appearances = new Map();
  for (const segment of prompts) for (const creator of segment.creatorIds ?? []) {
    const id = String(creator).trim();
    if (id) {if (!appearances.has(id)) appearances.set(id, new Set()); appearances.get(id).add(Number(segment.segmentId));}
  }
  return new Set([...appearances].filter(([, ids]) => ids.size > 1).map(([id]) => id));
}
export function validateCreatorReferences(manifest, visibleIds) {
  const entries = new Map((manifest.creators ?? []).filter(x => obj(x) && String(x.creatorId || '').trim())
    .map(x => [String(x.creatorId), x]));
  const count = segmentCount(manifest), multi = count > 1, submitted = [];
  for (const [id, item] of entries) {
    const source = String(item.sourceType || '').trim().toLowerCase();
    if (!['user_provided', 'generated_multiview', 'ai_generated'].includes(source))
      throw Error(`Creator ${id} 来源无效；禁止把原视频单帧登记或提交为达人参考图。`);
    for (const image of item.referenceImages ?? [item.file || '']) if (!exists(expand(image)))
      throw Error(`Creator ${id} 参考图不存在或为空：${expand(image)}`);
    if (source !== 'user_provided') {
      if (source === 'generated_multiview' && !multi)
        throw Error('单Segment且用户未提供达人图时，不得生成或提交达人参考图。');
      const views = new Set((item.views ?? []).map(x => String(x).trim().toLowerCase()));
      const missing = ['front', 'back'].filter(x => !views.has(x));
      if (!['side_profile', 'left_profile', 'right_profile'].some(x => views.has(x))) missing.push('side_profile');
      if (missing.length || item.layout !== 'multi-view') throw Error(`Creator ${id} 多视图不完整，缺少：${missing.join(', ')}`);
      if (source === 'ai_generated' && !views.has('close_up')) throw Error(`Creator ${id} AI 四视图缺少 close_up。`);
      if (item.productFreeVerified !== true) throw Error(`Creator ${id} 多视图未完成无产品视觉检查。`);
    }
    if (visibleIds.has(id)) submitted.push(id);
  }
  let required = new Set([...visibleIds].filter(x => crossSegmentCreatorIds(manifest).has(x)));
  const creator = manifest.creator ?? {};
  if (Object.hasOwn(creator, 'mode')) {
    if (!['ai_generated', 'keep_source', 'user_provided'].includes(creator.mode)) throw Error('creator.mode 无效。');
    const aiIds = new Set(creator.targetCreatorIds ?? []);
    required = creator.mode === 'ai_generated' ? new Set([...visibleIds].filter(x => aiIds.has(x))) : new Set();
    if (creator.mode === 'ai_generated') {
      if (visibleIds.size && !aiIds.size) throw Error('AI 达人模式须先登记目标 creatorId。');
      for (const id of aiIds) {
        const entry = entries.get(id), record = manifest.creatorGeneration?.[id] ?? {};
        if (!entry || entry.sourceType !== 'ai_generated' || record.status !== 'ready')
          throw Error(`AI 达人 ${id} 缺少已验证的四视图身份板。`);
        if (record.sha256 !== fileSha256(entry.file)) throw Error(`AI 达人 ${id} 身份板校验值不匹配。`);
      }
    } else if ([...visibleIds].some(id => entries.get(id)?.sourceType === 'ai_generated'))
      throw Error('当前达人模式与本段 AI 身份板绑定冲突。');
    if (creator.mode === 'user_provided' && ![...entries.values()].some(x => x.sourceType === 'user_provided'))
      throw Error('用户提供达人图模式缺少已登记的上传图片。');
  }
  const missing = [...required].filter(x => !entries.has(x));
  if (multi && missing.length) throw Error(`多Segment任务必须为跨段人物提供用户达人图或生成的无产品多视图；缺少：${missing.join(', ')}`);
  return {segmentCount: count, mode: multi ? 'multi_segment_required' : 'single_segment_optional',
    creatorIds: submitted.sort(), crossSegmentCreatorIds: [...required].sort()};
}
export function validateAiStoryboardInput(manifest, board, selectedIds) {
  if (manifest.creator?.mode !== 'ai_generated') return;
  const aiIds = [...selectedIds].filter(x => (manifest.creator.targetCreatorIds ?? []).includes(x));
  if (!aiIds.length) return;
  const replacement = board.replacement;
  if (!obj(replacement) || !board.replacementVerified) throw Error('AI 达人分镜缺少已完成的图片替换记录。');
  const reportPath = expand(replacement.imageTaskReport || '');
  if (!exists(reportPath)) throw Error('AI 达人分镜缺少 LuluLab 图片编辑任务报告。');
  let report;
  try {report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));}
  catch {throw Error('AI 达人分镜图片任务报告不可读取。');}
  if (!obj(report) || report.status !== 'success' || report.provider !== 'lululab_cli')
    throw Error('AI 达人分镜图片编辑任务尚未成功。');
  if (!replacement.editedImageFile || !report.output || expand(replacement.editedImageFile) !== expand(report.output))
    throw Error('AI 达人图片任务报告与本段 Storyboard 编辑候选文件不一致。');
  if (!Array.isArray(report.referenceSha256) || report.referenceSha256.some(x => typeof x !== 'string'))
    throw Error('AI 达人分镜图片报告缺少参考图 SHA256。');
  const references = new Set(report.referenceSha256), entries = new Map((manifest.creators ?? []).map(x => [String(x.creatorId), x]));
  const missing = aiIds.filter(id => !entries.has(id) || !exists(expand(entries.get(id).file)) ||
    !references.has(fileSha256(entries.get(id).file)));
  if (missing.length) throw Error(`AI 达人分镜编辑未使用目标身份图：${missing.sort().join(', ')}`);
}
export function versionAtLeast(value, major, minor) {
  const parts = String(value).trim().split('.').map(Number);
  return Number.isInteger(parts[0]) && Number.isInteger(parts[1]) &&
    (parts[0] > major || parts[0] === major && parts[1] >= minor);
}
export function currentOrLegacyAtLeast(value, major, minor) {
  const normalized = String(value).trim();
  return ['', 'unknown', '5.0', '5.1'].includes(normalized) ||
    (normalized.startsWith('1.') && normalized.split('.').length >= 3) ||
    versionAtLeast(normalized, major, minor);
}
export function validateIdentityRoster(manifest, board, segment) {
  const context = segmentContext(manifest, segment), known = new Set((manifest.creators ?? []).map(x => String(x.creatorId)));
  const anchors = board.anchors;
  if (!Array.isArray(anchors) || !anchors.length) throw Error(`Storyboard ${board.storyboardId} 缺少anchors，无法审计人物身份。`);
  const visible = new Set();
  anchors.forEach((anchor, i) => {
    if (!obj(anchor) || typeof anchor.personPresent !== 'boolean') throw Error(`Storyboard ${board.storyboardId} 第${i + 1}格缺少personPresent。`);
    if (!Array.isArray(anchor.creatorIds)) throw Error(`Storyboard ${board.storyboardId} 第${i + 1}格creatorIds必须是数组。`);
    const ids = new Set(anchor.creatorIds.map(x => String(x).trim()).filter(Boolean));
    const count = anchor.personCount ?? 0;
    if (!Number.isInteger(count) || count < 0) throw Error(`Storyboard ${board.storyboardId} 第${i + 1}格personCount无效。`);
    if (anchor.personPresent && (!ids.size || (!context && ids.size < Math.max(1, count))))
      throw Error(`Storyboard ${board.storyboardId} 第${i + 1}格有${count || 1}人出镜，但未绑定全部creatorIds。`);
    if (!anchor.personPresent && ids.size) throw Error(`Storyboard ${board.storyboardId} 第${i + 1}格无人物却绑定creatorIds。`);
    for (const id of ids) visible.add(id);
  });
  if (context) {
    const expected = new Set(context.creatorIds), selected = new Set(segment.creatorIds ?? []);
    if ([...visible].some(x => !expected.has(x))) throw Error('anchor人物不属于本段完整镜头映射');
    if (!sameSet(selected, expected)) throw Error('Segment creatorIds必须覆盖全部镜头人物，不仅是九格人物');
    validateCreatorReferences(manifest, expected);
    return expected;
  }
  if (currentOrLegacyAtLeast(manifest.skillVersion ?? '', 6, 5)) validateCreatorReferences(manifest, visible);
  else if ([...visible].some(x => !known.has(x))) throw Error(`Storyboard ${board.storyboardId} 引用了未登记的人物身份。`);
  if (!sameSet(new Set((segment.creatorIds ?? []).map(String)), visible))
    throw Error(`Segment ${segment.segmentId} creatorIds必须与Storyboard实际出镜人物完全一致。`);
  return visible;
}
export function productPresence(board, segment = null) {
  const anchors = board.anchors ?? [], auto = anchors.length > 0 &&
    anchors.every(x => String(x.semanticSource ?? 'observed') === 'unobserved');
  if (auto) return typeof segment?.productPresent === 'boolean' ? segment.productPresent :
    Boolean(board.replacement?.applied);
  const values = anchors.map(x => x.productPresent);
  if (!values.length || values.some(x => x == null)) throw Error(`Storyboard ${board.storyboardId} 缺少完整productPresent元数据。`);
  return values.some(x => x === true);
}
export function replacementTargetsProduct(board) {
  const replacement = board.replacement;
  if (!obj(replacement) || replacement.applied !== true) return false;
  if (replacement.method === 'whole-board-fast-v1') return replacement.replaceProduct === true;
  const mapFile = String(replacement.mapFile || '').trim();
  if (!mapFile) return false;
  try {return JSON.parse(fs.readFileSync(expand(mapFile), 'utf8')).replaceProduct === true;}
  catch {throw Error(`Storyboard ${board.storyboardId} 的Replacement Map不可读取。`);}
}
export function validateProductReferences(manifest, board) {
  if (loadBlueprint(manifest)) return segmentContext(manifest, {segmentId: Number(board.segmentId ?? board.storyboardId)}).productReferenceImages;
  if (!replacementTargetsProduct(board)) return [];
  if (useBenchmarkProduct(manifest)) throw Error(`Storyboard ${board.storyboardId} 已替换产品，但Manifest仍标记沿用原产品；请先用 set-product-references 登记新产品图。`);
  const values = manifest.product?.productImages;
  if (!Array.isArray(values) || !values.length) throw Error('已选择新产品替换，但Manifest没有登记产品参考图。');
  const files = [];
  for (const item of values) {
    const path = expand(file(item));
    if (!exists(path)) throw Error(`产品参考图不存在或为空：${path}`);
    if (!files.includes(path)) files.push(path);
  }
  return files;
}
export function audit(manifest, segments = null) {
  const boards = manifest.storyboards?.generation;
  if (!Array.isArray(boards) || !boards.length) throw Error('付费提交前必须有非空storyboards.generation。');
  const byId = new Map(boards.map(x => [Number(x.storyboardId), x]));
  const prompts = segments ?? manifest.videoPrompts?.segments;
  if (!Array.isArray(prompts) || !prompts.length) throw Error('付费提交前必须有非空videoPrompts.segments。');
  const creatorIds = new Set((manifest.creators ?? []).map(x => String(x.creatorId)));
  const benchmarkProduct = useBenchmarkProduct(manifest), skillVersion = String(manifest.skillVersion || '').trim();
  const currentMetadata = skillVersion.startsWith('5.13') || currentOrLegacyAtLeast(skillVersion, 6, 2);
  const protectedGate = currentOrLegacyAtLeast(skillVersion, 6, 2), currentCreator = currentOrLegacyAtLeast(skillVersion, 6, 5);
  const validIds = new Set((manifest.benchmarkVideo?.analysis?.recommendedSegments ?? []).map(x => Number(x.segmentId)));
  const results = [], warnings = []; let previous = 0;
  for (const segment of prompts) {
    const id = Number(segment.segmentId), selected = segment.storyboardIds;
    if (id <= previous || (validIds.size && !validIds.has(id)) || !Array.isArray(selected) || selected.length !== 1)
      throw Error('每个已选Segment必须按顺序且只能引用一张最终Storyboard。');
    previous = id;
    const boardId = Number(selected[0]), board = byId.get(boardId);
    if (!board || Number(board.segmentId) !== id) throw Error(`Segment ${id}引用了不存在或不属于本段的Storyboard。`);
    const registered = validateProductReferences(manifest, board);
    if (!exists(expand(board.file || ''))) throw Error(`Segment ${id}最终Storyboard不存在或为空。`);
    const anchors = board.anchors ?? [], auto = anchors.length > 0 &&
      anchors.every(x => String(x.semanticSource ?? 'observed') === 'unobserved');
    const inferred = auto && typeof segment.productPresent !== 'boolean';
    const context = segmentContext(manifest, segment);
    const hasProduct = context ? context.productPresent : productPresence(board, segment);
    if (context && segment.productPresent !== hasProduct) throw Error('productPresent与完整镜头不一致');
    if (inferred) warnings.push(`Segment ${id}缺少productPresent，已按Storyboard替换记录推断为${String(hasProduct).toLowerCase()}；该提示不阻断生成。`);
    let selectedCreators = new Set((segment.creatorIds ?? []).map(String));
    if (protectedGate) selectedCreators = validateIdentityRoster(manifest, board, segment);
    validateAiStoryboardInput(manifest, board, selectedCreators);
    const creatorPolicy = currentCreator ? validateCreatorReferences(manifest, selectedCreators) : null;
    if (!currentCreator && [...selectedCreators].some(x => !creatorIds.has(x))) throw Error(`Segment ${id}引用了不存在的Creator。`);
    const anchorCreators = new Set(anchors.flatMap(x => x.creatorIds ?? []).map(String));
    if (!context && !auto && [...selectedCreators].some(x => !anchorCreators.has(x)))
      throw Error(`Segment ${id}达人引用与Storyboard metadata不一致。`);
    const productRequired = context ? Boolean(context.productReferenceImages.length) : hasProduct && !benchmarkProduct;
    const creatorReplacementRequired = selectedCreators.size > 0 && !protectedGate;
    const registeredSelected = new Set((manifest.creators ?? []).filter(x => selectedCreators.has(String(x.creatorId)))
      .map(x => String(x.creatorId)));
    const creatorReferenceRequired = currentCreator ? selectedCreators.size > 0 &&
      ([...selectedCreators].some(x => crossSegmentCreatorIds(manifest).has(x)) || registeredSelected.size > 0) : creatorReplacementRequired;
    if ((productRequired || creatorReplacementRequired) && board.replacementVerified !== true)
      throw Error(`Segment ${id}需要新产品/新达人身份，但Storyboard未标记replacementVerified文件完整性状态。`);
    let replacement = board.replacement;
    if (obj(replacement)) {
      if (protectedGate && replacement.method !== 'whole-board-fast-v1')
        throw Error(`Segment ${id} fast模式只允许whole-board-fast-v1。`);
      if (!['local-board-direct', 'whole-board-lock-merge', 'whole-board-user-review', 'whole-board-fast-v1'].includes(replacement.method))
        throw Error(`Segment ${id} replacement.method 必须是受支持的完整故事板合成方式。`);
      if (currentMetadata || replacement.method === 'local-board-direct')
        replacement = normalizeReplacementRecord(replacement);
      if (protectedGate) {
        if (replacement.validationLevel !== 'mechanical' || replacement.artifactIntegrityVerified !== true ||
          replacement.visualReviewRequired !== false)
          throw Error(`Segment ${id} 缺少快速模式机械完整性证据。`);
      }
      if (replacement.replacementVerified !== true)
        throw Error(`Segment ${id} replacement metadata 未完成文件完整性登记。`);
    } else if (currentMetadata && (productRequired || creatorReplacementRequired))
      throw Error(`Segment ${id} 当前任务缺少replacement metadata。`);
    results.push({segmentId: id, storyboardId: boardId, productPresent: hasProduct,
      productReferenceRequired: productRequired, registeredProductImages: registered,
      creatorReferenceRequired, creatorIds: [...selectedCreators].sort(), creatorReferencePolicy: creatorPolicy});
  }
  return {passed: true, warnings, segments: results};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), index = args.indexOf('--manifest');
    if (index < 0 || !args[index + 1]) throw Error('需要 --manifest');
    console.log(JSON.stringify(audit(JSON.parse(fs.readFileSync(expand(args[index + 1]), 'utf8')))));
  } catch (error) {console.error(error.message); process.exitCode = 1;}
}
