#!/usr/bin/env node
/** Generate and register one reusable 2×2 AI creator identity sheet. */
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile, mkdir, stat, open, unlink} from 'node:fs/promises';
import {join, dirname, resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {loadManifest, update, fileSha256, addCreator} from './generation_manifest.mjs';
import {loadBlueprint, validateBindings} from './entity_bindings.mjs';
import {execute as generateImage} from './lululab_image_generate.mjs';
import {IMAGE_MODEL} from './local_video_cli_lululab.mjs';

const expand = p => resolve(String(p).replace(/^~(?=\/|$)/, homedir()));
const exec = promisify(execFile);
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ?
  Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sorted(v)])) : value;
const legacyFingerprintJson = value => Array.isArray(value) ? `[${value.map(legacyFingerprintJson).join(', ')}]` :
  value && typeof value === 'object' ? `{${Object.entries(value).map(([key, item]) =>
    `${JSON.stringify(key)}: ${legacyFingerprintJson(item)}`).join(', ')}}` : JSON.stringify(value);
export const PROMPT_TEMPLATE_VERSION = 'creator-2x2-v1';
export const VIEWS = ['close_up', 'front', 'side_profile', 'back'];

export function creatorProfile(manifest) {
  const creator = manifest.creator ?? {}, config = manifest.userConfig ?? {};
  let country = String(creator.targetCountry || config.targetCountry || 'source market');
  if (country === '跟原视频一致') country = "the source video's target market";
  return {
    targetCountry: country,
    gender: String(creator.gender || "appropriate to the source character's role"),
    ageRange: String(creator.ageRange || "appropriate to the source character's role"),
    appearanceStyle: String(creator.appearanceStyle || 'natural everyday UGC creator'),
    clothingStyle: String(creator.clothingStyle || 'appropriate to the product and source role'),
    vibe: String(creator.vibe || 'authentic, friendly, trustworthy'),
    otherRequirements: String(creator.otherRequirements || 'none'),
  };
}
export function buildPrompt(profile, role) {
  return 'Create exactly ONE photorealistic square 2x2 identity reference sheet for an original ' +
    'short-form ecommerce UGC creator. The role in the source video is: ' + role + '\n' +
    'Target market: ' + profile.targetCountry + '\n' +
    'Gender: ' + profile.gender + '; age range: ' + profile.ageRange + '\n' +
    'Appearance: ' + profile.appearanceStyle + '; clothing: ' + profile.clothingStyle + '\n' +
    'Vibe: ' + profile.vibe + '; additional requirements: ' + profile.otherRequirements + '\n' +
    'Exactly four equal panels of the SAME person: top-left close-up portrait with natural eyes, ' +
    'skin texture, pores and subtle imperfections; top-right full-body front view with natural ' +
    'proportions; bottom-left side profile showing face, hair and silhouette; bottom-right ' +
    'full-body back view. Keep face, hairstyle, skin tone, clothing, body and identity consistent ' +
    'in every panel. Everyday smartphone photography, unretouched appearance, soft natural ' +
    'light, clean neutral background. Adapt styling to the specified role and requirements. ' +
    'No product, prop, text, caption, logo, watermark, beauty filter, airbrushing, CGI, ' +
    'fashion editorial styling, glamour lighting or excessive sharpening.';
}
export function roleFromBlueprint(manifest, creatorId) {
  const blueprint = loadBlueprint(manifest);
  if (!blueprint) return 'primary on-camera commerce presenter';
  const bindings = validateBindings(manifest, blueprint);
  const sources = new Set(bindings.filter(item => item.entityType === 'character' && item.targetId === creatorId)
    .map(item => String(item.sourceId)));
  const people = blueprint['视频元素']['人物'].filter(item => sources.has(item.characterId));
  if (!people.length) throw Error('AI 达人目标没有对应的 Blueprint 来源人物。');
  const keys = ['role', '角色', '角色功能', '身份', '职业', '人物定位', 'function'];
  const roles = people.flatMap(item => keys.map(key => item[key]).filter(x => typeof x === 'string' && x.trim())
    .map(x => x.trim()));
  return roles.length ? roles.join('; ') : 'primary on-camera commerce presenter';
}
export async function inspectSheet(path) {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || !info.size) throw Error('AI 达人身份图不存在或为空。');
  let width, height;
  try {
    const {stdout} = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'json', path], {timeout: 20000});
    ({width, height} = JSON.parse(stdout).streams[0]);
    width = Number(width); height = Number(height);
    if (!Number.isInteger(width) || !Number.isInteger(height)) throw Error();
  } catch {throw Error('无法读取 AI 达人身份图的画布尺寸。');}
  if (Math.min(width, height) < 768 || Math.abs(width - height) > 0.1 * Math.max(width, height))
    throw Error('AI 达人身份图须为至少 768×768 的方形四宫格画布。');
  return {width, height, panelWidth: Math.floor(width / 2), panelHeight: Math.floor(height / 2),
    semanticReviewRequired: true};
}
async function record(path, creatorId, value) {
  return update(path, data => {
    (data.creatorGeneration ??= {})[creatorId] = value;
    if (value.status === 'ready_for_review' && typeof value.durationSeconds === 'number')
      (data.stageDurations ??= {}).creatorGenerationDuration = value.durationSeconds;
  });
}
async function acquire(path) {
  await mkdir(dirname(path), {recursive: true});
  try {return await open(path, 'wx');}
  catch (error) {if (error.code === 'EEXIST') throw Error('同一任务已有进程在运行；请继续原进程。'); throw error;}
}
export async function run(manifestPath, creatorId, role = null, {registerReviewed = false,
  generate = generateImage, inspect = inspectSheet} = {}) {
  const path = expand(manifestPath);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(creatorId))
    throw Error('creatorId 只能包含字母、数字、下划线或连字符。');
  const lockPath = join(dirname(path), 'creators', `${creatorId}.generation.lock`);
  const handle = await acquire(lockPath);
  try {
    const manifest = await loadManifest(path), creator = manifest.creator ?? {};
    if (creator.mode !== 'ai_generated') throw Error('当前任务未选择 AI 自动生成达人；不得提交图片任务。');
    if (!(creator.targetCreatorIds ?? []).includes(creatorId)) throw Error('creatorId 未登记为本任务需要替换的 AI 达人。');
    const saved = manifest.creatorGeneration?.[creatorId] ?? {};
    role ||= saved.input?.role || roleFromBlueprint(manifest, creatorId);
    const profile = creatorProfile(manifest), prompt = buildPrompt(profile, role);
    const identity = {creatorId, profile, role, model: IMAGE_MODEL, templateVersion: PROMPT_TEMPLATE_VERSION,
      aspectRatio: '1:1', resolution: '1K'};
    const fingerprint = createHash('sha256').update(legacyFingerprintJson(sorted(identity))).digest('hex');
    const output = join(dirname(path), 'creators', `${creatorId}-identity-2x2.png`);
    const report = join(dirname(path), 'creators', `${creatorId}-identity-task.json`);
    if (Object.keys(saved).length && saved.inputFingerprint !== fingerprint)
      throw Error('达人设定或模板已变化；现有图片任务不得自动重提。需要明确授权新候选。');
    if (saved.status === 'structural_failed') throw Error('现有身份板未通过结构检查；未经重新授权不得再次生成。');
    const reportExists = (await stat(report).catch(() => null))?.isFile();
    let taskId = '';
    if (reportExists) {
      const previous = JSON.parse(await readFile(report, 'utf8'));
      if (!previous || typeof previous !== 'object' || Array.isArray(previous)) throw Error('图片任务报告格式无效。');
      taskId = String(previous.taskId || '');
      if (!Object.keys(saved).length) throw Error('已有图片任务报告但无对应配置指纹；禁止重复提交。');
      if (['submit_pending', 'submit_outcome_unknown'].includes(previous.status) && !taskId)
        throw Error('图片提交结果不确定且无 taskId；禁止自动重复付费提交。');
      if (['terminal_failed', 'invalid_input'].includes(previous.status))
        throw Error('现有达人图片任务已失败；未经重新授权不得再次提交。');
      const outputExists = (await stat(output).catch(() => null))?.isFile();
      if (previous.status === 'success' && outputExists && saved.sha256 === await fileSha256(output)) {
        if (registerReviewed && saved.status === 'ready_for_review') {
          await addCreator(path, output, creatorId, 'ai_generated', {views: VIEWS, productFreeVerified: true});
          saved.status = 'ready'; saved.visualReview = 'agent_confirmed_four_views_and_product_free';
          await record(path, creatorId, saved);
        }
        return saved;
      }
      if (previous.status === 'success' && outputExists && saved.sha256 && saved.sha256 !== await fileSha256(output))
        throw Error('已保存的达人身份图 SHA256 不匹配；不能复用。');
      if (registerReviewed) throw Error('达人身份图尚未可用，不能登记视觉检查。');
    } else if (registerReviewed) throw Error('尚无 AI 达人生成任务。');
    else if (Object.keys(saved).length) throw Error('达人图片任务已有提交记录但报告缺失；禁止自动重复付费提交。');
    else await record(path, creatorId, {status: 'submit_pending', inputFingerprint: fingerprint,
      input: identity, taskId: '', file: output, report});
    const started = performance.now();
    const {code, report: result} = await generate({prompt, aspectRatio: '1:1', referenceImages: [],
      output, report, resumeTaskId: taskId || undefined});
    const current = {status: result.status, inputFingerprint: fingerprint, input: identity,
      taskId: result.taskId || '', file: output, report, durationSeconds: Math.round((performance.now() - started)) / 1000};
    if (code === 0) {
      try {
        current.structure = await inspect(output);
        current.sha256 = await fileSha256(output);
        current.status = 'ready_for_review';
      } catch (error) {current.status = 'structural_failed'; current.message = error.message;}
    }
    await record(path, creatorId, current);
    return current;
  } finally {await handle.close(); await unlink(lockPath).catch(() => {});}
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), option = name => args[args.indexOf(name) + 1];
    const manifest = option('--manifest'), creatorId = option('--creator-id');
    if (!manifest || !creatorId) throw Error('需要 --manifest 和 --creator-id');
    const result = await run(manifest, creatorId, option('--role'), {registerReviewed: args.includes('--register-reviewed')});
    console.log(JSON.stringify(result)); process.exitCode = ['ready', 'ready_for_review'].includes(result.status) ? 0 : 2;
  } catch (error) {console.log(JSON.stringify({status: 'blocked', message: error.message})); process.exitCode = 1;}
}
