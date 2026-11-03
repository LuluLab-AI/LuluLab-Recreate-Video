#!/usr/bin/env node
/** Submit and resume StoryboardPlan with durable paid-task receipts. */
import {readFile, writeFile, mkdir, rename, stat, open, unlink} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {loadManifest, update, fileSha256} from './generation_manifest.mjs';
import {client as defaultClient} from './local_video_cli_lululab.mjs';
import {withPreparedAnalysisVideo} from './benchmark_preprocessing.mjs';
import {validateBlueprint} from './entity_bindings.mjs';
import {normalizeServerPlan} from './blueprint_timeline.mjs';
import {publicError, raiseIfAuthorizationUnavailable, sanitizePayload} from './service_privacy.mjs';

export const WORKFLOW_ID = 'StoryboardPlan';
export const PLANNER_VERSION = '2';
export const MAX_SERVER_ATTEMPTS = 2;
const success = new Set(['succeeded', 'success', 'completed', 'complete']);
const failed = new Set(['failed', 'failure', 'error', 'cancelled', 'canceled', 'timeout', 'timedout']);
const pending = new Set(['created', 'pending', 'processing', 'running', 'queued', 'submitted']);
const expand = p => resolve(String(p).replace(/^~(?=\/|$)/, homedir()));
const object = x => x && typeof x === 'object' && !Array.isArray(x);
export class AnalysisError extends Error {}
async function save(path, value) {
  await mkdir(dirname(path), {recursive: true});
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2) + '\n');
  await rename(`${path}.tmp`, path);
}
async function acquire(path) {
  await mkdir(dirname(path), {recursive: true});
  try {return await open(path, 'wx');}
  catch (error) {if (error.code === 'EEXIST') throw new AnalysisError('同一任务已有进程在运行；请继续原进程，禁止启动第二个上传或submit。'); throw error;}
}
export const submissionReceiptPath = manifestPath => join(dirname(expand(manifestPath)), 'analysis',
  'recreate-video-prompt-v3-submit-receipt.json');
export async function loadSubmitAttempts(manifestPath) {
  let value;
  try {value = JSON.parse(await readFile(submissionReceiptPath(manifestPath), 'utf8'));}
  catch {return [];}
  if (!object(value)) return [];
  if (Array.isArray(value.attempts)) {
    const attempts = value.attempts.map((item, i) => object(item) && String(item.taskId || '').trim() ?
      {attempt: Number(item.attempt ?? i + 1), taskId: String(item.taskId).trim(), recordedAt: item.recordedAt} : null)
      .filter(Boolean);
    if (attempts.length) return attempts;
  }
  const id = String(value.taskId || '').trim();
  return id ? [{attempt: 1, taskId: id, recordedAt: value.recordedAt}] : [];
}
export async function persistSubmitReceipt(manifestPath, taskId) {
  const path = submissionReceiptPath(manifestPath), attempts = await loadSubmitAttempts(manifestPath);
  if (attempts.some(item => item.taskId === taskId)) return path;
  if (attempts.length >= MAX_SERVER_ATTEMPTS)
    throw new AnalysisError(`服务端拆解已达最大尝试次数${MAX_SERVER_ATTEMPTS}，禁止继续提交。`);
  const recordedAt = Date.now() / 1000;
  attempts.push({attempt: attempts.length + 1, taskId, recordedAt});
  await save(path, {workflowId: WORKFLOW_ID, taskId, attempt: attempts.length,
    maxAttempts: MAX_SERVER_ATTEMPTS, recordedAt, attempts});
  return path;
}
export async function reserveSubmission(manifestPath, requestPath) {
  return update(manifestPath, data => {
    if (object(data.videoBlueprint) && data.videoBlueprint.workflowId === WORKFLOW_ID)
      throw new AnalysisError('manifest已存在服务端拆解记录，禁止创建第二个提交预留。');
    data.videoBlueprint = {source: WORKFLOW_ID, workflowId: WORKFLOW_ID, taskId: '',
      status: 'preparing_submission', requestFile: requestPath, file: ''};
  });
}
export function* walkDicts(value) {
  const queue = [value];
  while (queue.length) {
    const current = queue.shift();
    if (object(current)) {
      yield current;
      queue.push(...Object.values(current).filter(x => object(x) || Array.isArray(x)));
    } else if (Array.isArray(current)) queue.push(...current.filter(x => object(x) || Array.isArray(x)));
  }
}
export function taskState(response) {
  for (const item of walkDicts(response)) {
    const state = item.status || item.state;
    if (typeof state === 'string' && state.trim()) return state.trim().toLowerCase();
  }
  return '';
}
export function extractBlueprint(response) {
  for (const item of walkDicts(response)) if (item.success === false) {
    raiseIfAuthorizationUnavailable(item);
    throw new AnalysisError(publicError(item.errorMessage || item.message, '服务端视频拆解失败。'));
  }
  let candidate;
  for (const item of walkDicts(response)) {
    if (object(item.videoBlueprint)) {candidate = item.videoBlueprint; break;}
    if (object(item.videoAnalysisSummary)) candidate = item.videoAnalysisSummary;
  }
  if (!object(candidate) || !Object.keys(candidate).length)
    throw new AnalysisError('StoryboardPlan返回缺少有效videoBlueprint。');
  return {...candidate};
}
export function extractReplicationPlan(response) {
  let candidate;
  for (const item of walkDicts(response)) if (object(item.replicationPlan)) {candidate = item.replicationPlan; break;}
  if (!object(candidate) || !Object.keys(candidate).length)
    throw new AnalysisError('StoryboardPlan返回缺少有效replicationPlan。');
  const schema = String(candidate.schemaVersion || '').trim();
  if (!schema || schema.split('.')[0] !== '1')
    throw new AnalysisError(`replicationPlan协议版本不兼容：${schema || '缺失'}。`);
  const planner = String(candidate.plannerVersion || '').trim();
  if (!['1', '2'].includes(planner))
    throw new AnalysisError(`服务端Planner版本不匹配：期望${PLANNER_VERSION}，实际${planner || '缺失'}。`);
  if (!Array.isArray(candidate.segments) || !candidate.segments.length)
    throw new AnalysisError('replicationPlan缺少有效segments。');
  candidate.segments.forEach((segment, i) => {
    if (!object(segment)) throw new AnalysisError(`replicationPlan第${i + 1}个Segment不是对象。`);
    if (!Array.isArray(segment.anchors) || !segment.anchors.length)
      throw new AnalysisError(`replicationPlan第${i + 1}个Segment缺少anchors。`);
    for (const field of ['segmentId', 'globalStart', 'globalEnd', 'duration'])
      if (!Object.hasOwn(segment, field)) throw new AnalysisError(`replicationPlan第${i + 1}个Segment缺少${field}。`);
  });
  return {...candidate};
}
export function analysisCutCandidates(technical) {
  const limit = technical.analysisDuration, cuts = technical.candidateCuts ?? [];
  return typeof limit !== 'number' ? cuts : cuts.filter(cut =>
    typeof cut === 'number' && Number.isFinite(cut) && cut >= 0 && cut < limit);
}
export function displayModel(config) {
  const model = String(config.videoModel || 'seedance-2-fast');
  return ({'seedance-2-fast': 'Seedance2 Fast', 'seedance-2-mini': 'Seedance2 Mini',
    'seedance-2': 'Seedance2', 'minimax-h3': 'MiniMax H3', 'wan-3': 'Wan 3',
    'google-omni': 'Omini'})[model] ?? model;
}
export function buildInput(manifest, media) {
  const config = manifest.userConfig;
  if (!object(config)) throw new AnalysisError('manifest.userConfig必须是对象。');
  const mode = String(config.durationMode || 'source'), duration = config.duration ?? config.requestedDuration;
  if (mode !== 'source' && (typeof duration !== 'number' || duration <= 0))
    throw new AnalysisError('部分复刻必须在manifest中记录有效的正数目标时长。');
  const label = mode === 'source' ? '跟原视频一致' : `仅复刻原视频0～${Math.trunc(duration)}秒`;
  let requirements = String(config.customRequirement || '').trim();
  if (mode !== 'source') requirements = `仅分析原视频0～${Math.trunc(duration)}秒，忽略此后的内容。 ${requirements}`.trim();
  const technical = object(manifest.benchmarkVideo?.analysis) ? manifest.benchmarkVideo.analysis : {};
  const plannerVersion = String(config.plannerVersion || (String(manifest.skillVersion || '') === '5.1' ? '2' : '1'));
  return {plannerVersion, benchmarkVideo: {url: media.url, mimeType: 'video/mp4', expiredAt: media.expiredAt || null},
    userConfig: {model: displayModel(config), newVideoDuration: label,
      targetCountry: String(config.targetCountry || '跟原视频一致'),
      targetLanguage: String(config.targetLanguage || '跟原视频一致'),
      otherRequirements: requirements, blueprintSchemaVersion: plannerVersion === '2' ? '7.0' : '6.0',
      technicalCutCandidates: analysisCutCandidates(technical), targetDuration: config.duration ?? null,
      sourceDuration: technical.media?.duration ?? null,
      targetDurationSource: technical.targetDurationSource ?? null}};
}
async function mergedAttemptHistory(manifestPath, existing) {
  const attempts = Array.isArray(existing) ? existing.map(item => ({...item})) : [];
  const known = new Set(attempts.map(item => String(item.taskId || '')));
  for (const receipt of await loadSubmitAttempts(manifestPath)) if (!known.has(receipt.taskId)) {
    attempts.push({attempt: receipt.attempt, taskId: receipt.taskId, status: 'submitted',
      submittedAt: receipt.recordedAt}); known.add(receipt.taskId);
  }
  return attempts.sort((a, b) => Number(a.attempt || 0) - Number(b.attempt || 0));
}
async function updateSubmission(manifestPath, taskId, requestPath, media, attemptNumber) {
  return update(manifestPath, async data => {
    const attempts = await mergedAttemptHistory(manifestPath, data.videoBlueprint?.attempts);
    for (const attempt of attempts) if (attempt.taskId === taskId) {
      attempt.attempt = attemptNumber; attempt.status = 'submitted';
      attempt.submittedAt ??= Date.now() / 1000;
    }
    data.videoBlueprint = {source: WORKFLOW_ID, workflowId: WORKFLOW_ID, taskId, status: 'submitted',
      requestFile: requestPath, file: '', attempt: attemptNumber, maxAttempts: MAX_SERVER_ATTEMPTS, attempts};
    (data.publicMedia ??= {}).benchmarkVideo = {...media};
    data.publicMedia.rawStoryboards = [];
  });
}
async function recordAttemptFailure(manifestPath, taskId, response) {
  const state = taskState(response) || 'failed';
  let message = '';
  for (const item of walkDicts(response)) if (item.errorMessage || item.message) {
    message = publicError(item.errorMessage || item.message, '服务端视频拆解失败。'); break;
  }
  return update(manifestPath, async data => {
    const current = data.videoBlueprint;
    if (!object(current)) return;
    current.attempts = await mergedAttemptHistory(manifestPath, current.attempts);
    for (const attempt of current.attempts) if (attempt.taskId === taskId) {
      attempt.status = state; attempt.failedAt = Date.now() / 1000;
      if (message) attempt.error = message;
    }
    current.status = state;
    if (message) current.lastError = message;
  });
}
async function submitAttempt(api, manifestPath, requestPath, payload, media) {
  if ((await loadSubmitAttempts(manifestPath)).length >= MAX_SERVER_ATTEMPTS)
    throw new AnalysisError(`服务端拆解已达最大尝试次数${MAX_SERVER_ATTEMPTS}，禁止继续提交。`);
  const result = await api.submit(WORKFLOW_ID, payload);
  const taskId = String(result?.id || result?.taskId || '').trim();
  if (!taskId) throw new AnalysisError('task submit响应缺少任务ID。');
  await persistSubmitReceipt(manifestPath, taskId);
  const attemptNumber = (await loadSubmitAttempts(manifestPath)).length;
  await updateSubmission(manifestPath, taskId, requestPath, media, attemptNumber);
  return [taskId, attemptNumber];
}
async function poll(api, taskId, intervalMs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await api.task(taskId), state = taskState(response);
    if (success.has(state) || failed.has(state)) {
      if (failed.has(state)) raiseIfAuthorizationUnavailable(response);
      return response;
    }
    if (!pending.has(state)) throw new AnalysisError(`任务返回未知状态：${state || '缺失'}`);
    if (Date.now() >= deadline) throw new AnalysisError(`任务${taskId}轮询超时；请用同一ID恢复。`);
    await new Promise(done => setTimeout(done, Math.min(Math.max(1000, intervalMs), deadline - Date.now())));
  }
}
async function updateSuccess(manifestPath, taskId, requestPath, response, blueprint, plan) {
  const root = join(dirname(manifestPath), 'analysis');
  await mkdir(root, {recursive: true});
  const rawPath = join(root, 'recreate-video-prompt-v3-task.json');
  const blueprintPath = join(root, 'server-video-blueprint.json');
  const planPath = join(root, 'server-replication-plan.json');
  await save(rawPath, sanitizePayload(response));
  await save(blueprintPath, {videoBlueprint: blueprint});
  await save(planPath, plan);
  const recommended = plan.segments.filter(object).map(segment => Object.fromEntries(
    ['segmentId', 'globalStart', 'globalEnd', 'duration'].map(key => [key, segment[key]])));
  await update(manifestPath, async data => {
    const attempts = await mergedAttemptHistory(manifestPath, data.videoBlueprint?.attempts);
    for (const attempt of attempts) if (attempt.taskId === taskId) {
      attempt.status = 'succeeded'; attempt.completedAt = Date.now() / 1000;
    }
    data.videoBlueprint = {source: WORKFLOW_ID, workflowId: WORKFLOW_ID, taskId,
      status: 'succeeded', requestFile: requestPath, rawFile: rawPath, file: blueprintPath,
      attempt: attempts.length, maxAttempts: MAX_SERVER_ATTEMPTS, attempts};
    data.replicationPlan = {source: WORKFLOW_ID, status: 'succeeded', file: planPath,
      plannerVersion: String(plan.plannerVersion || PLANNER_VERSION),
      schemaVersion: String(plan.schemaVersion || '1.0'), policyVersion: String(plan.policyVersion || '')};
    (data.benchmarkVideo ??= {}).analysis ??= {};
    data.benchmarkVideo.analysis.recommendedSegments = recommended;
    data.timelinePlan = {file: planPath, schemaVersion: String(plan.schemaVersion || '1.0'),
      plannerVersion: String(plan.plannerVersion || PLANNER_VERSION), source: 'server'};
    data.workflowStatus = 'step3a_complete';
  });
  return {ok: true, workflowId: WORKFLOW_ID, taskId, file: blueprintPath,
    replicationPlanFile: planPath, segments: recommended.length};
}
export async function run({manifest, benchmark = null, benchmarkUrl = null, resumeTaskId = null,
  pollIntervalMs = 5000, pollTimeoutMs = 1_800_000, api = null,
  prepare = withPreparedAnalysisVideo} = {}) {
  if (!manifest) throw new AnalysisError('需要 --manifest');
  const manifestPath = expand(manifest), c = api || await defaultClient();
  const credits = await c.credits();
  if (typeof credits?.balance !== 'number' || !Number.isFinite(credits.balance))
    throw new AnalysisError('LuluLab user --credits 未返回文档规定的有效鉴权响应。');
  const lockPath = join(dirname(manifestPath), 'analysis', 'server-video-analysis.lock');
  const handle = await acquire(lockPath);
  try {
    const state = await loadManifest(manifestPath), existing = state.videoBlueprint;
    let existingId = object(existing) && existing.workflowId === WORKFLOW_ID ? String(existing.taskId || '').trim() : '';
    const receipt = await loadSubmitAttempts(manifestPath);
    if (receipt.length) existingId = receipt.at(-1).taskId;
    const resumeId = String(resumeTaskId || '').trim();
    if (existingId && !resumeId) throw new AnalysisError(`manifest已记录任务${existingId}；只能用--resume-task-id继续。`);
    if (resumeId && existingId && resumeId !== existingId)
      throw new AnalysisError('--resume-task-id与manifest记录不一致。');
    if (object(existing) && existing.workflowId === WORKFLOW_ID && !existingId && !resumeId)
      throw new AnalysisError('manifest已标记preparing_submission且任务状态未知；禁止重新上传或submit。请先确认原进程或外部任务历史，只有确认从未提交后才可人工清除预留。');
    const requestPath = join(dirname(manifestPath), 'analysis', 'recreate-video-prompt-v3-input.json');
    let payload, media, taskId, attemptNumber;
    if (resumeId) {
      taskId = resumeId;
      try {payload = JSON.parse(await readFile(requestPath, 'utf8'));}
      catch (error) {throw new AnalysisError(`恢复任务时无法读取原请求：${error.message}`);}
      if (!object(payload) || !object(payload.benchmarkVideo))
        throw new AnalysisError('恢复任务的原请求缺少benchmarkVideo。');
      media = {...payload.benchmarkVideo};
      if (!receipt.length) await persistSubmitReceipt(manifestPath, taskId);
      attemptNumber = (await loadSubmitAttempts(manifestPath)).length;
    } else {
      if (!benchmark && !benchmarkUrl) throw new AnalysisError('首次提交必须提供--benchmark或--benchmark-url。');
      await prepare(state.userConfig, join(dirname(manifestPath), 'analysis', 'upload'),
        {benchmark, url: benchmarkUrl}, async prepared => {
          const technical = (state.benchmarkVideo ??= {}).analysis ??= {};
          if (benchmark) {
            technical.sourceSha256 = await fileSha256(expand(benchmark));
            technical.sourceFile = expand(benchmark);
          }
          (technical.media ??= {}).duration = prepared.sourceDuration;
          technical.analysisDuration = prepared.analysisDuration;
          technical.candidateCuts = analysisCutCandidates(technical);
          await update(manifestPath, data => {((data.benchmarkVideo ??= {}).analysis = technical);});
          await reserveSubmission(manifestPath, requestPath);
          media = prepared.directUrl ? {url: prepared.directUrl, mimeType: 'video/mp4', expiredAt: null} :
            {...await c.upload(prepared.filePath), mimeType: 'video/mp4'};
        });
      if (benchmark) await update(manifestPath, data => {(data.benchmarkVideo ??= {}).file = expand(benchmark);});
      payload = buildInput(state, media);
      await save(requestPath, payload);
      [taskId, attemptNumber] = await submitAttempt(c, manifestPath, requestPath, payload, media);
    }
    for (;;) {
      const response = await poll(c, taskId, pollIntervalMs, pollTimeoutMs);
      if (success.has(taskState(response))) {
        const blueprint = extractBlueprint(response), plan = extractReplicationPlan(response);
        const requested = String(JSON.parse(await readFile(requestPath, 'utf8')).plannerVersion || '1');
        if (String(plan.plannerVersion) !== requested)
          throw new AnalysisError('服务端Planner与本次请求不匹配；请导入配套工作流，不自动降级或重提。');
        if (requested === '2') {
          validateBlueprint(blueprint, plan.targetDuration);
          normalizeServerPlan(plan);
        }
        return updateSuccess(manifestPath, taskId, requestPath, response, blueprint, plan);
      }
      await recordAttemptFailure(manifestPath, taskId, response);
      if (attemptNumber >= MAX_SERVER_ATTEMPTS) {
        const ids = (await loadSubmitAttempts(manifestPath)).map(item => item.taskId);
        throw new AnalysisError(`服务端视频拆解已自动重试${MAX_SERVER_ATTEMPTS - 1}次仍失败；任务ID：${ids.join(', ')}。`);
      }
      [taskId, attemptNumber] = await submitAttempt(c, manifestPath, requestPath, payload, media);
    }
  } finally {await handle.close(); await unlink(lockPath).catch(() => {});}
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
    console.log(JSON.stringify(await run({manifest: option('--manifest'), benchmark: option('--benchmark'),
      benchmarkUrl: option('--benchmark-url'), resumeTaskId: option('--resume-task-id'),
      pollIntervalMs: Number(option('--poll-interval') || 5) * 1000,
      pollTimeoutMs: Number(option('--poll-timeout') || 1800) * 1000})));
  } catch (error) {console.error(error.message); process.exitCode = 1;}
}
