#!/usr/bin/env node
/** Generate and register one segment prompt through ChatGenV2. */
import {createHash} from 'node:crypto';
import {readFile, writeFile, mkdir, rename, stat} from 'node:fs/promises';
import {dirname, join, resolve, extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import {loadManifest, setPrompts} from './generation_manifest.mjs';
import {segmentContext} from './entity_bindings.mjs';
import {client, pollTask, TaskFailedError} from './local_video_cli_lululab.mjs';

const expand = p => resolve(String(p).replace(/^~(?=\/|$)/, homedir()));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const file = x => typeof x === 'string' ? x : x?.file || x?.filePath || '';
async function save(path, obj) {
  await mkdir(dirname(path), {recursive: true});
  const temp = `${path}.tmp`;
  await writeFile(temp, JSON.stringify(obj, null, 2) + '\n');
  await rename(temp, path);
}
export const buildChatgenInput = (prompt, images) => ({prompt, images, videos: []});
export function extractText(result) {
  const queue = [result];
  while (queue.length) {
    const item = queue.shift();
    if (item && typeof item === 'object') {
      if (item.success === false) throw Error('ChatGenV2 回调报告失败：' + (item.errorCode || 'ALL_PROVIDERS_FAILED'));
      if (typeof item.output?.text === 'string' && item.output.text.trim()) return item.output.text.trim();
      queue.push(...Object.values(item).filter(x => x && typeof x === 'object'));
    }
  }
  throw Error('ChatGenV2 成功返回但缺少 output.text');
}
export async function buildSegment(manifest, segmentId) {
  const windows = manifest.benchmarkVideo?.analysis?.recommendedSegments ?? [];
  const window = windows.find(x => Number(x.segmentId) === segmentId);
  if (!window) throw Error('Segment不在规划中');
  if (!(manifest.storyboards?.generation ?? []).some(x => Number(x.segmentId) === segmentId))
    throw Error('缺少目标 generation Storyboard，请先执行 prepare_prompt_handoff.mjs');
  const blueprintFile = manifest.videoBlueprint?.file;
  if (!blueprintFile) throw Error('缺少视频蓝图');
  const blueprint = JSON.parse(await readFile(expand(blueprintFile), 'utf8')).videoBlueprint;
  const overlaps = item => item.start < window.globalEnd && item.end > window.globalStart;
  const shots = (blueprint['逐镜头拆解'] ?? []).filter(overlaps);
  const beats = (blueprint['节奏结构']?.dramaticBeats ?? []).filter(overlaps);
  const utterances = shots.flatMap(shot => shot['声音']?.utterances ?? []).filter(overlaps);
  const context = segmentContext(manifest, {segmentId});
  return [{segmentId, title: `Segment ${segmentId}`, duration: window.duration,
    globalStart: window.globalStart, globalEnd: window.globalEnd, storyboardIds: [segmentId],
    creatorIds: context?.creatorIds ?? [], productPresent: context?.productPresent ??
      Boolean(manifest.product?.productImages?.length), shotIds: shots.map(s => s.shotId),
    beatIds: beats.map(b => b.beatId), utteranceIds: utterances.map(u => u.utteranceId)}, blueprint, context];
}
export function buildPrompt(manifest, segment, blueprint, context) {
  const config = manifest.userConfig ?? {};
  const language = String(config.interactionLocale || 'en').toLowerCase().startsWith('zh') ? '中文' : 'English';
  const unknown = (blueprint['逐镜头拆解'] ?? []).flatMap(shot => shot['声音']?.utterances ?? [])
    .filter(u => ['无法确认', '听不清', '[unclear]', '[inaudible]'].includes(String(u.text || '').trim()))
    .map(u => u.utteranceId);
  const instruction = {
    objective: 'Write the COMPLETE final video-generation prompt for ONE Segment; return only plain prompt text, never JSON or markdown fences.',
    instructionLanguage: language, spokenDialogueLanguage: config.targetLanguage || '跟原视频一致',
    referencePriority: 'Image 1 = final edited storyboard primary visual reference; following product pictures lock product appearance; creator references lock identity, not background. Do not invent unprovided reference images.',
    rules: ['Preserve source shots, camera moves, cut plan, dramatic beats, lip-sync, voices and timeline, including events omitted by 9-grid.',
      'Use target storyboard and replacementBindings for static appearance and identity.',
      'Write each shot with local timestamps = global timestamps minus globalStart exactly once; include all overlapping shotIds/beatIds/utteranceIds and verified spoken dialogue.',
      'Preserve creator wardrobe across Segments; no burned-in captions, UI, promotions or watermarks.',
      'Do not invent health claims, prices, product benefits, characters or objects.',
      'Showing multiple product units is only a visual arrangement. Never call them gifts, a free bundle, or a promotional offer unless the user explicitly provided those terms for the target product.',
      'When a source character is replaced, describe the target creator from the registered creator reference; do not copy source-only facial or skin traits into the target identity.',
      'Keep output as a single, ready-to-send video prompt for the requested video model.'],
    segmentMetadata: segment, userConfig: config, productBrief: manifest.product?.brief,
    productReferencePolicy: manifest.product?.useBenchmarkProduct ?? true,
    creatorBrief: manifest.creator ?? {}, entityContext: context, videoBlueprint: blueprint,
    generationMode: 'prompt_only',
  };
  if (unknown.length) instruction.unverifiedDialogueAdaptation = {
    utteranceIds: unknown,
    direction: 'The source dialogue was not reliably transcribed. Never speak or display the placeholder 无法确认. For these utterances, write short neutral speech in the source video language (Thai here), using only the verified product name, category and visible packaging format. Keep the original utterance IDs, timing, speaker, lip-sync and energetic delivery. Do not mention source-brand offers, prices, free gifts, shipping, shampoo functions or unsupported benefits. This adapts the user-approved removal of unverified promotional claims.',
  };
  return 'Follow this structured instruction exactly. Return only the final prompt text.\n' + JSON.stringify(instruction);
}
export function referenceFiles(manifest, segment) {
  const selected = new Set(segment.storyboardIds.map(Number));
  const boards = (manifest.storyboards?.generation ?? []).filter(x => selected.has(Number(x.storyboardId))).map(x => file(x.file));
  if (boards.length !== selected.size) throw Error('Segment 引用了不存在的最终 Segment Storyboard。');
  const products = (manifest.product?.productImages ?? manifest.product?.images ?? []).map(file).filter(Boolean);
  const creators = (manifest.creators ?? []).filter(x => segment.creatorIds.includes(String(x.creatorId)) || x.sourceType === 'user_provided')
    .flatMap(x => x.referenceImages ?? [x.file]).map(file).filter(Boolean);
  return [...boards, ...products, ...creators];
}
export async function invoke(manifestPath, segmentId, {resume = false, intervalMs = 5000, timeoutMs = 600000,
  api = null, register = setPrompts} = {}) {
  const path = expand(manifestPath), manifest = await loadManifest(path);
  const [segment, blueprint, context] = await buildSegment(manifest, segmentId);
  if ((manifest.videoPrompts?.segments ?? []).some(x => Number(x.segmentId) === segmentId))
    throw Error('此Segment已登记Prompt；禁止重复生成');
  const root = join(dirname(path), 'prompts', 'chatgen-v2', `segment-${String(segmentId).padStart(2, '0')}`);
  const receipt = join(root, 'receipt.json'), c = api || await client();
  let taskId;
  const previous = await readFile(receipt, 'utf8').then(JSON.parse, error => {
    if (error.code === 'ENOENT') return null; throw error;
  });
  if (previous) {
    taskId = previous.taskId;
    if (!taskId) throw Error('提交状态不确定，没有taskId；禁止自动重提，需人工核实');
    if (!resume) throw Error('已提交ChatGenV2任务，请使用 --resume 恢复查询，不可重新提交');
  } else {
    if (resume) throw Error('没有已提交任务可恢复');
    const prompt = buildPrompt(manifest, segment, blueprint, context);
    const images = [], seen = new Set();
    for (const item of referenceFiles(manifest, segment)) {
      const reference = expand(item), info = await stat(reference).catch(() => null);
      if (!info?.isFile() || !info.size) throw Error('参考图不存在：' + reference);
      const digest = sha(await readFile(reference));
      if (seen.has(digest)) continue;
      seen.add(digest);
      const uploaded = await c.upload(reference);
      images.push({...uploaded, mimeType: ['.jpg', '.jpeg'].includes(extname(reference).toLowerCase()) ? 'image/jpeg' : 'image/png'});
    }
    const input = buildChatgenInput(prompt, images);
    await save(join(root, 'request.json'), input);
    await save(receipt, {status: 'submission_unknown', taskId: null, workflowId: 'ChatGenV2', segmentId});
    const response = await c.submit('ChatGenV2', input);
    taskId = response.id;
    await save(receipt, {status: 'submitted', taskId, workflowId: 'ChatGenV2', segmentId});
  }
  let response;
  try { response = await pollTask(id => c.task(id), taskId, {intervalMs, timeoutMs}); }
  catch (error) {
    if (error instanceof TaskFailedError) {
      await save(receipt, {status: 'failed', taskId, workflowId: 'ChatGenV2', segmentId});
      throw Error('ChatGenV2 远端任务失败，需人工授权重新生成');
    }
    throw error;
  }
  let text;
  try { text = extractText(response); }
  catch (error) {
    await save(receipt, {status: 'invalid_output', taskId, workflowId: 'ChatGenV2', segmentId});
    throw error;
  }
  segment.prompt = text;
  const resultFile = join(root, 'video-prompts.json');
  await save(resultFile, {videoPrompts: {segments: [segment]}});
  try { await register(path, resultFile); }
  catch (error) {
    await save(receipt, {status: 'validation_failed', taskId, workflowId: 'ChatGenV2', segmentId, resultFile});
    throw error;
  }
  await save(receipt, {status: 'completed', taskId, workflowId: 'ChatGenV2', segmentId, resultFile});
  return {ok: true, segmentId, taskId, promptFile: resultFile, prompt: text};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
    const manifest = option('--manifest'), segmentId = Number(option('--segment-id'));
    if (!manifest || !Number.isInteger(segmentId) || segmentId < 1) throw Error('需要 --manifest 和 --segment-id');
    console.log(JSON.stringify(await invoke(manifest, segmentId, {resume: args.includes('--resume'),
      intervalMs: Number(option('--poll-interval') || 5) * 1000,
      timeoutMs: Number(option('--poll-timeout') || 600) * 1000})));
  } catch (error) {console.error(error.message); process.exitCode = 1;}
}
