#!/usr/bin/env node
/** Dispatch, resume, and assemble authorized LuluLab VideoGenV2 segments. */
import {createHash} from 'node:crypto';
import {readFile, writeFile, mkdir, rename, stat, open, unlink} from 'node:fs/promises';
import {join, dirname, resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {loadManifest, update, setVideo, validatePromptRecord, nextCandidateId,
  commandSetFinal, setQualityReport} from './generation_manifest.mjs';
import * as referenceAudit from './reference_audit.mjs';
import {segmentContext} from './entity_bindings.mjs';
import {capability, validateGeneration} from './model_capabilities.mjs';
import {render as renderReferenceBoard} from './reference_board.mjs';
import {orderedSegments, render as concatRender} from './concat_videos.mjs';
import {resolve as resolveTool, resolveOptional, buildReview} from './quality_review.mjs';
import {client as defaultClient, uploadReferenceImages, submitVideo, pollTask,
  media, downloadMedia, TaskFailedError} from './local_video_cli_lululab.mjs';
import {publicError} from './service_privacy.mjs';

const expand = p => resolve(String(p).replace(/^~(?=\/|$)/, homedir()));
const file = x => typeof x === 'string' ? x : x?.file || x?.filePath || '';
const exists = async p => {const info = await stat(p).catch(() => null); return Boolean(info?.isFile() && info.size);};
const stable = x => Array.isArray(x) ? x.map(stable) : x && typeof x === 'object' ?
  Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)])) : x;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function productFiles(data) {
  const values = data.product?.productImages || data.product?.images || [];
  if (!Array.isArray(values)) throw Error('product.productImages/images 必须是数组。');
  return values.map(file).filter(Boolean);
}
export function creatorFiles(data, segment) {
  const selected = new Set((segment.creatorIds ?? []).map(String));
  if (referenceAudit.currentOrLegacyAtLeast(String(data.skillVersion || ''), 6, 5))
    referenceAudit.validateCreatorReferences(data, selected);
  const files = [];
  for (const item of data.creators ?? []) {
    if (item.sourceType === 'ai_generated' && (data.creator?.mode !== 'ai_generated' ||
      !(data.creator.targetCreatorIds ?? []).includes(String(item.creatorId)))) continue;
    if (selected.has(String(item.creatorId)) || item.sourceType === 'user_provided')
      files.push(...(item.referenceImages ?? [item.file]).map(String));
  }
  return files;
}
export function storyboardFiles(data, segment) {
  const selected = new Set((segment.storyboardIds ?? []).map(Number));
  if (!selected.size) throw Error(`Segment ${segment.segmentId} 缺少 storyboardIds。`);
  const files = (data.storyboards?.generation ?? []).filter(item => selected.has(Number(item.storyboardId)))
    .map(item => String(item.file));
  if (files.length !== selected.size) throw Error(`Segment ${segment.segmentId} 引用了不存在的最终 Segment Storyboard。`);
  return files;
}
export function selectedAttempt(entry, candidateId) {
  return entry?.attempts?.find(item => item.candidateId === candidateId) ??
    (candidateId === 'candidate-01' && !entry?.attempts?.length ? entry ?? {} : {});
}
export function selectSegments(segments, selectedIds = []) {
  const selected = new Set(selectedIds.map(Number));
  if (!selected.size) return segments;
  const available = new Set(segments.map(x => Number(x.segmentId)));
  const missing = [...selected].filter(x => !available.has(x));
  if (missing.length) throw Error(`请求的 Segment 不存在：${missing.join(', ')}`);
  return segments.filter(x => selected.has(Number(x.segmentId)));
}
export async function submissionFingerprint(segment, files, model, resolution, aspectRatio) {
  const identity = {segment, model, resolution, aspectRatio,
    referenceSha256: await Promise.all(files.map(async path => hash(await readFile(expand(path)))))};
  return hash(JSON.stringify(stable(identity)));
}
export async function prepareReferences(data, segment, root, model) {
  const boards = storyboardFiles(data, segment), context = segmentContext(data, segment);
  const registered = productFiles(data);
  const products = registered.length ? registered : context?.productReferenceImages ?? [];
  const creators = creatorFiles(data, segment), maximum = capability(model)?.maxImages ?? 9;
  let files = referenceAudit.deduplicateFiles([...boards, ...products, ...creators]);
  if (files.length > maximum && products.length > 1) {
    const identity = join(root, 'references', `product-identity-board-${segment.segmentId}.jpg`);
    const provenance = `${identity}.sources.json`, sourceSha256 = products.map(referenceAudit.fileSha256);
    let reusable = false;
    try {const old = JSON.parse(await readFile(provenance, 'utf8'));
      reusable = await exists(identity) && JSON.stringify(old.sourceSha256) === JSON.stringify(sourceSha256) &&
        old.outputSha256 === referenceAudit.fileSha256(identity);} catch {}
    if (!reusable) {
      await renderReferenceBoard(products.map(expand), identity);
      await mkdir(dirname(provenance), {recursive: true});
      await writeFile(provenance, JSON.stringify({outputSha256: referenceAudit.fileSha256(identity), sourceSha256}));
    }
    files = referenceAudit.deduplicateFiles([...boards, identity, ...creators]);
  }
  if (files.length > maximum) throw Error(`Segment ${segment.segmentId} 需要 ${files.length} 张参考图，超过模型上限 ${maximum}；不得静默丢弃素材。`);
  return files;
}
export function productReferenceRequired(data) {
  const product = data.product ?? {}, mode = String(product.mode || '').trim().toLowerCase();
  return !(product.useBenchmarkProduct === true || ['benchmark', 'use_benchmark', 'original'].includes(mode));
}
async function acquire(path) {
  await mkdir(dirname(path), {recursive: true});
  try {return await open(path, 'wx');}
  catch (error) {if (error.code === 'EEXIST') throw Error('同一任务已有进程在运行；请继续原进程。'); throw error;}
}
async function runLimited(items, limit, fn) {
  let cursor = 0;
  const results = [];
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {results[index] = {ok: true, value: await fn(items[index])};}
      catch (error) {results[index] = {ok: false, error};}
    }
  }));
  return results;
}
export async function run({manifest, videoProvider = 'lululab_cli', skipConcat = false,
  dispatchOnly = false, newCandidate = false, qualityRetryApproved = false,
  fullQualityReview = false, generationApproved = false, segmentIds = [],
  maxConcurrency = 5, api = null, dependencies = {}} = {}) {
  if (!manifest) throw Error('需要 --manifest');
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 5)
    throw Error('--max-concurrency 必须介于 1 和 5 之间。');
  if (dispatchOnly && (!segmentIds.length || !skipConcat))
    throw Error('逐段首次提交必须同时指定 --segment-id、--skip-concat 和 --dispatch-only。');
  if (!['auto', 'lululab_cli'].includes(videoProvider)) throw Error(`视频生成渠道不可用：${videoProvider}。`);
  const path = expand(manifest), root = dirname(path), lockPath = join(root, 'analysis', 'video-generation.lock');
  const handle = await acquire(lockPath);
  try {
    const data = await loadManifest(path), promptFile = expand(data.videoPrompts?.file || '');
    const prompts = JSON.parse(await readFile(promptFile, 'utf8')).videoPrompts;
    const segments = prompts.segments, config = data.userConfig ?? {};
    const model = String(config.videoModel || 'seedance-2-fast'), resolution = String(config.resolution || '720p');
    const targetDuration = Number(config.duration ?? segments.reduce((n, x) => n + Number(x.duration), 0));
    validatePromptRecord(prompts, data);
    const selected = selectSegments(segments, segmentIds);
    if (selected.length !== segments.length && !skipConcat)
      throw Error('部分 Segment 生成必须传入 --skip-concat，禁止拼接缺段候选。');
    const c = api || await defaultClient();
    const provider = 'lululab_cli', channels = {lululab_cli: true};
    const initialAudit = referenceAudit.audit(data, selected);
    await update(path, current => {current.referenceAudit = initialAudit;});
    if (newCandidate && !qualityRetryApproved)
      throw Error('创建新候选会再次提交视频任务；必须先取得用户同意并传入 --quality-retry-approved。');
    const candidateId = newCandidate ? nextCandidateId(data) : String(data.activeCandidate || 'candidate-01');
    const existing = new Map((data.videos ?? []).map(item => [Number(item.segmentId), item]));
    if (!dispatchOnly) {
      const realMissing = [];
      for (const segment of selected) {
        const prior = selectedAttempt(existing.get(Number(segment.segmentId)), candidateId);
        if (!prior.taskId && !(prior.status === 'success' && await exists(expand(prior.output_file || ''))))
          realMissing.push(Number(segment.segmentId));
      }
      if (realMissing.length) throw Error(`Segment ${realMissing.join(', ')} 尚无任务ID；查询/拼接命令只处理已提交任务。请在每段分镜及Prompt就绪后，用 --segment-id <ID> --skip-concat --dispatch-only 提交。`);
    }
    let requiresSubmit = false;
    if (dispatchOnly) for (const segment of selected) {
      const prior = selectedAttempt(existing.get(Number(segment.segmentId)), candidateId);
      if (!(prior.status === 'success' && await exists(expand(prior.output_file || ''))) &&
        !(prior.taskId && prior.status !== 'terminal_failed')) requiresSubmit = true;
    }
    if (requiresSubmit && !generationApproved)
      throw Error('首次视频生成必须处于用户已“确认开始”的本轮授权内；授权后传入 --generation-approved。');
    const products = productFiles(data);
    if (productReferenceRequired(data) && !products.length)
      throw Error('已选择新产品替换，但生成引用中没有产品图；请检查 product.productImages/images。');
    const plans = [], auditSegments = [];
    for (const segment of selected) {
      validateGeneration(model, Number(segment.duration), resolution);
      const files = await prepareReferences(data, segment, root, model);
      const uploaded = referenceAudit.auditSubmissionFiles(data, files, {segmentId: Number(segment.segmentId),
        selectedCreatorIds: new Set((segment.creatorIds ?? []).map(String))});
      const fingerprint = await submissionFingerprint(segment, files, model, resolution, String(config.aspectRatio || '9:16'));
      plans.push({segment, files, inputFingerprint: fingerprint});
      const board = (data.storyboards?.generation ?? []).find(item => Number(item.storyboardId) === Number(segment.storyboardIds[0]));
      const requiredProducts = referenceAudit.validateProductReferences(data, board);
      if (requiredProducts.length) referenceAudit.auditSubmissionFiles({...data, product: {...(data.product ?? {}),
        productImages: requiredProducts.map(file => ({file}))}}, files,
        {segmentId: Number(segment.segmentId), selectedCreatorIds: new Set((segment.creatorIds ?? []).map(String))});
      auditSegments.push({segmentId: Number(segment.segmentId), storyboards: storyboardFiles(data, segment),
        registeredProductImages: requiredProducts, productImages: uploaded.productImages,
        creatorImages: creatorFiles(data, segment), orderedFiles: files});
    }
    await update(path, current => {
      current.referenceAudit = {passed: true, provider, warnings: initialAudit.warnings, segments: auditSegments};
      current.videoGeneration = {status: 'ready', generated: false, provider, model, availability: channels};
    });
    const candidateRoot = join(root, 'candidates', candidateId), results = [], pending = [], fresh = [];
    for (const plan of plans) {
      const id = Number(plan.segment.segmentId), previous = selectedAttempt(existing.get(id), candidateId);
      if (previous.inputFingerprint && previous.inputFingerprint !== plan.inputFingerprint)
        throw Error(`Segment ${id} 的素材或Prompt已变化；现有任务ID不能用于新输入，请先核查并明确授权新候选。`);
      if (!previous.inputFingerprint && ['success', 'submitted', 'querying'].includes(previous.status) &&
        (referenceAudit.uploadedProductFiles(data).length || referenceAudit.uploadedCreatorFiles(data).length))
        throw Error(`Segment ${id} 的旧任务缺少参考图输入指纹，无法证明已上传图片参与生成；请核查旧请求，禁止自动重提。`);
      if (previous.status === 'success' && await exists(expand(previous.output_file || ''))) {
        results.push({ok: true, reused: true, segment: plan.segment,
          taskId: previous.taskId || '', output: expand(previous.output_file), media: previous.media ?? {}});
      } else if (previous.taskId && previous.status !== 'terminal_failed') {
        if (previous.provider && previous.provider !== provider) throw Error(`Segment ${id} 已锁定 provider=${previous.provider}，禁止切换。`);
        pending.push({...plan, taskId: previous.taskId});
      } else if (['submit_pending', 'submit_outcome_unknown', 'terminal_failed'].includes(previous.status))
        throw Error(`Segment ${id} 已有提交或失败记录；禁止自动重新提交，请核查原任务或明确授权新候选。`);
      else if (dispatchOnly) fresh.push(plan);
    }
    if (dispatchOnly) {
      const cachePath = join(root, 'analysis', 'reference-upload-cache.json');
      for (const plan of fresh) {
        plan.referenceMedia = await (dependencies.uploadReferenceImages || uploadReferenceImages)(plan.files,
          {api: c, cachePath});
        if (plan.referenceMedia.length !== plan.files.length)
          throw Error('最终 referenceImages 数量与审计通过的文件数量不一致。');
      }
      for (const plan of fresh) await setVideo(path, Number(plan.segment.segmentId), 'submit_pending',
        {candidateId, provider, model, inputFingerprint: plan.inputFingerprint});
      const submissions = await runLimited(fresh, maxConcurrency, async plan => {
        const id = await (dependencies.submitVideo || submitVideo)(model, plan.segment.prompt, Number(plan.segment.duration),
          {referenceFiles: plan.files, referenceMedia: plan.referenceMedia,
            aspectRatio: String(config.aspectRatio || '9:16'), resolution, api: c});
        await setVideo(path, Number(plan.segment.segmentId), 'submitted', {candidateId, taskId: id,
          provider, model, resolution, prompt: String(plan.segment.prompt), inputFingerprint: plan.inputFingerprint});
        return {...plan, taskId: id};
      });
      const errors = [];
      submissions.forEach((item, index) => {
        if (item.ok) pending.push(item.value);
        else errors.push({plan: fresh[index], error: item.error});
      });
      for (const {plan, error} of errors) await setVideo(path, Number(plan.segment.segmentId), 'submit_outcome_unknown',
        {candidateId, provider, error: publicError(error.message, '提交结果未知。')});
      if (errors.length) throw Error(errors.map(({plan, error}) =>
        `Segment ${plan.segment.segmentId} submit失败：${publicError(error.message, '提交结果未知。')}`).join('；') +
        '。其他已返回的任务ID已保存；再次运行只恢复这些ID。');
      return {ok: true, status: 'dispatched', candidateId,
        segments: pending.map(plan => ({segmentId: Number(plan.segment.segmentId), taskId: plan.taskId})),
        reusedSegments: results.map(item => Number(item.segment.segmentId)), manifest: path};
    }
    for (const plan of pending) await setVideo(path, Number(plan.segment.segmentId), 'querying',
      {candidateId, taskId: plan.taskId, provider});
    const polled = await runLimited(pending, maxConcurrency, async plan => {
      const raw = await (dependencies.pollTask || pollTask)(id => c.task(id), plan.taskId, {timeoutMs: 3_600_000});
      const mediaValue = (dependencies.media || media)(raw, 'video/mp4');
      const output = await (dependencies.downloadMedia || downloadMedia)(mediaValue,
        join(candidateRoot, `segment-${plan.segment.segmentId}.mp4`));
      return {ok: true, reused: false, segment: plan.segment, taskId: plan.taskId,
        output, media: mediaValue};
    });
    polled.forEach((item, index) => results.push(item.ok ? item.value : {ok: false, reused: false,
      segment: pending[index].segment, taskId: pending[index].taskId,
      error: publicError(item.error.message, '任务查询失败。'),
      terminalFailed: item.error instanceof TaskFailedError}));
    results.sort((a, b) => Number(a.segment.segmentId) - Number(b.segment.segmentId));
    for (const item of results) {
      const id = Number(item.segment.segmentId);
      if (item.ok) {
        const prior = selectedAttempt(existing.get(id), candidateId);
        await setVideo(path, id, 'success', {candidateId, taskId: item.taskId, provider,
          output_file: item.output, media: item.media, model, resolution,
          inputFingerprint: !item.reused || prior.inputFingerprint ? plans.find(p => Number(p.segment.segmentId) === id).inputFingerprint : undefined});
      } else await setVideo(path, id, item.terminalFailed ? 'terminal_failed' : 'querying',
        {candidateId, taskId: item.taskId, provider, error: item.error, model, resolution});
    }
    const failures = results.filter(item => !item.ok);
    if (failures.length) {
      await update(path, current => {current.videoGeneration = {status: 'failed', generated: false,
        provider, model, availability: channels};});
      return {ok: false, stage: 'step5', failures};
    }
    let report = null;
    if (!skipConcat) {
      const current = await loadManifest(path), ordered = await orderedSegments(current);
      const final = join(candidateRoot, 'final.mp4');
      await concatRender(ordered.map(([, file]) => file), final, resolveTool('ffmpeg'));
      await commandSetFinal({manifest: path, outputFile: final, segmentIds: ordered.map(([id]) => id), candidateId});
      const benchmark = file(data.benchmarkVideo), reviewDir = join(candidateRoot, 'review');
      const reportFile = join(reviewDir, 'quality-report.json');
      try {
        if (!benchmark || !await exists(expand(benchmark))) throw Error('原视频文件不可用，已跳过自动对齐分析。');
        report = await buildReview(resolveTool('ffmpeg'), resolveOptional('ffprobe'),
          expand(benchmark), final, reviewDir, {targetDuration,
            profile: fullQualityReview ? 'full' : 'fast'});
      } catch (error) {report = {status: 'report_error', passed: false,
        deliveryBlocked: false, requiresVisualReview: false, mayAutoRegenerate: false,
        error: error.message};}
      await mkdir(reviewDir, {recursive: true});
      await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
      await setQualityReport(path, candidateId, reportFile);
    }
    await update(path, current => {current.videoGeneration = {status: 'success', generated: true,
      provider, model, availability: channels, candidateId};});
    return {ok: true, generated: true, provider, candidateId, segments: results,
      qualityReport: report, manifest: path};
  } finally {await handle.close(); await unlink(lockPath).catch(() => {});}
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), option = name => args[args.indexOf(name) + 1],
      segments = [];
    for (let i = 0; i < args.length; i++) if (args[i] === '--segment-id') segments.push(Number(args[i + 1]));
    console.log(JSON.stringify(await run({manifest: option('--manifest'), videoProvider: option('--video-provider') || 'lululab_cli',
      skipConcat: args.includes('--skip-concat'), dispatchOnly: args.includes('--dispatch-only'),
      newCandidate: args.includes('--new-candidate'), qualityRetryApproved: args.includes('--quality-retry-approved'),
      fullQualityReview: args.includes('--full-quality-review'), generationApproved: args.includes('--generation-approved'),
      segmentIds: segments, maxConcurrency: Number(option('--max-concurrency') || 5)})));
  } catch (error) {console.error(error.message); process.exitCode = 1;}
}
