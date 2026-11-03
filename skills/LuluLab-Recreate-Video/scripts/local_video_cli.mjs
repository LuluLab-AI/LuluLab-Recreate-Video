#!/usr/bin/env node
/** Provider discovery and legacy CLI compatibility for the native LuluLab client. */
import {spawnSync} from 'node:child_process';
import {stat} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {findOnPath} from '../utils/ffmpeg.mjs';
import {MODEL_CAPABILITIES, LOCAL_CLI_REQUIRED_MODEL_IDS, normalizeModel, validateGeneration} from './model_capabilities.mjs';
import {raiseIfAuthorizationUnavailable, publicError} from './service_privacy.mjs';
import * as lulu from './local_video_cli_lululab.mjs';

export const LULULAB_IMAGE_MODEL_ID = lulu.IMAGE_MODEL;
export const LULULAB_IMAGE_RESOLUTION = lulu.IMAGE_RESOLUTION;
export const LULULAB_IMAGE_WORKFLOW_ID = lulu.IMAGE_WORKFLOW;
export const LULULAB_VIDEO_WORKFLOW_ID = 'VideoGenV2';
export const TaskFailedError = lulu.TaskFailedError;
export const media = lulu.media;
export const pollTask = lulu.pollTask;
export const downloadMedia = lulu.downloadMedia;
export const uploadReferenceImages = lulu.uploadReferenceImages;
export const submitLululabImage = lulu.submitImage;
export const imageWorkflowId = lulu.imageWorkflowId;
export class LocalVideoCliError extends Error {}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const expand = p => resolve(String(p).replace(/^~(?=\/|$)/, homedir()));
const executable = async p => {const s = await stat(p).catch(() => null); return Boolean(s?.isFile() && s.size && (process.platform === 'win32' || s.mode & 0o111));};
async function resolveExecutable(names, configured = '', cliPath = null) {
  const choices = cliPath ? [expand(cliPath)] : configured ? [expand(configured)] :
    [...await Promise.all(names.map(name => findOnPath(name))), join(homedir(), '.local', 'bin', names[0])];
  for (const p of choices.filter(Boolean)) if (await executable(p)) return resolve(p);
  throw new LocalVideoCliError(`未发现可执行 CLI：${names[0]}`);
}
export const resolveDreaminaCli = (cliPath = null) => resolveExecutable(process.platform === 'win32' ? ['dreamina.exe','dreamina'] : ['dreamina'], process.env.DREAMINA_CLI?.trim(), cliPath);
export const resolveXiaoyunqueCli = (cliPath = null) => resolveExecutable(process.platform === 'win32' ? ['xiaoyunque.exe','xiao-yunque.exe','xiaoyunque-cli.exe'] : ['xiaoyunque','xiao-yunque','xiaoyunque-cli'], process.env.XIAOYUNQUE_CLI?.trim(), cliPath);
export async function resolveLibtvCli(cliPath = null) {
  if (!cliPath && !process.env.LIBTV_CLI && !await findOnPath('libtv'))
    cliPath = join(homedir(), '.libtv', process.platform === 'win32' ? 'libtv.exe' : 'libtv');
  return resolveExecutable(process.platform === 'win32' ? ['libtv.exe','libtv'] : ['libtv'], process.env.LIBTV_CLI?.trim(), cliPath);
}
export async function resolveLululabCli(cliPath = null) {
  const path = expand(cliPath || process.env.LULULAB_CLI || join(root, 'scripts', 'lululab_cli.mjs'));
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || !info.size || !path.endsWith('.mjs')) throw new LocalVideoCliError('未发现 Node.js LuluLab CLI：scripts/lululab_cli.mjs');
  return path;
}
function run(exe, args, provider, timeoutMs = 600000) {
  const response = spawnSync(exe, args.map(String), {encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024});
  if (response.error) throw new LocalVideoCliError(`${provider} CLI 调用失败：${response.error.message}`);
  if (response.status !== 0) {
    const detail = (response.stderr || response.stdout || '未知错误').trim();
    raiseIfAuthorizationUnavailable(detail);
    throw new LocalVideoCliError(`${provider} CLI 退出码 ${response.status}：${publicError(detail.slice(0, 1000), '未知错误')}`);
  }
  for (const line of [response.stdout, ...response.stdout.trim().split(/\r?\n/).reverse()]) {
    try {const value = JSON.parse(line); raiseIfAuthorizationUnavailable(value); return value;} catch (e) {if (!(e instanceof SyntaxError)) throw e;}
  }
  throw new LocalVideoCliError(`${provider} CLI 返回内容不是有效 JSON。`);
}
export const runDreaminaCli = async (args, cliPath = null) => run(await resolveDreaminaCli(cliPath), args, '即梦');
export const runXiaoyunqueCli = async (args, cliPath = null) => run(await resolveXiaoyunqueCli(cliPath), args, '小云雀');
export async function libtvCliAvailable(cliPath = null) {
  try {return spawnSync(await resolveLibtvCli(cliPath), ['--help'], {timeout: 30000}).status === 0;} catch {return false;}
}
export async function lululabCliAvailable(cliPath = null) {
  try {
    const path = await resolveLululabCli(cliPath), node = process.env.LULULAB_NODE || process.execPath;
    for (const [command, required] of [['submit', ['--workflow-id','--input']], ['fetch', ['--id']]]) {
      const r = spawnSync(node, [path, 'task', command, '--help'], {encoding: 'utf8', timeout: 30000});
      if (r.status !== 0 || required.some(flag => !`${r.stdout}${r.stderr}`.includes(flag))) return false;
    }
    return true;
  } catch {return false;}
}
const modelId = (provider, model) => {
  const name = normalizeModel(model);
  if (provider === 'lululab_cli') return name;
  const key = provider === 'dreamina_cli' ? 'dreaminaId' : 'xiaoyunqueId';
  const id = MODEL_CAPABILITIES[name]?.[key];
  if (!id) throw new LocalVideoCliError(`${provider} 不支持视频模型：${name}。`);
  if (LOCAL_CLI_REQUIRED_MODEL_IDS[name] && id !== LOCAL_CLI_REQUIRED_MODEL_IDS[name])
    throw new LocalVideoCliError(`${name} 必须映射为 ${LOCAL_CLI_REQUIRED_MODEL_IDS[name]}。`);
  return id;
};
async function supports(provider, model, cliPath = null) {
  let id; try {id = modelId(provider, model);} catch {return false;}
  try {
    const exe = provider === 'dreamina_cli' ? await resolveDreaminaCli(cliPath) : await resolveXiaoyunqueCli(cliPath);
    const submit = spawnSync(exe, ['multimodal2video','--help'], {encoding: 'utf8', timeout: 30000});
    const text = `${submit.stdout}${submit.stderr}`;
    if (submit.status !== 0 || !text.includes(id) || ['--image','--prompt','--duration','--ratio','--video_resolution','--model_version'].some(flag => !text.includes(flag))) return false;
    if (provider === 'dreamina_cli') return true;
    const query = spawnSync(exe, ['query_result','--help'], {encoding: 'utf8', timeout: 30000});
    return query.status === 0 && `${query.stdout}${query.stderr}`.includes('--submit_id');
  } catch {return false;}
}
export const dreaminaCliSupportsVideoModel = (model, cliPath = null) => supports('dreamina_cli', model, cliPath);
export const xiaoyunqueCliSupportsVideoModel = (model, cliPath = null) => supports('xiaoyunque_cli', model, cliPath);
export async function detectVideoProviders(model = null) {
  const dreamina = model ? await dreaminaCliSupportsVideoModel(model) : await resolveDreaminaCli().then(() => true, () => false);
  const xiaoyunque = model ? await xiaoyunqueCliSupportsVideoModel(model) : await resolveXiaoyunqueCli().then(() => true, () => false);
  return {dreamina_cli: dreamina, xiaoyunque_cli: xiaoyunque, lululab_cli: await lululabCliAvailable()};
}
export async function detectGenerationProviders(model = null) {
  return {libtv_cli: await libtvCliAvailable(), ...await detectVideoProviders(model)};
}
export function resolveGenerationProvider(availability) {
  return ['libtv_cli','xiaoyunque_cli','dreamina_cli'].find(p => availability[p]) ?? null;
}
export function resolveVideoProvider(provider = 'auto', availability) {
  if (!['auto','dreamina_cli','xiaoyunque_cli','lululab_cli'].includes(provider))
    throw new LocalVideoCliError('videoProvider 必须是 auto、dreamina_cli、xiaoyunque_cli 或 lululab_cli。');
  if (provider !== 'auto') {
    if (!availability[provider]) throw new LocalVideoCliError(`视频生成渠道不可用：${provider}`);
    return provider;
  }
  return ['xiaoyunque_cli','dreamina_cli','lululab_cli'].find(p => availability[p]) ?? null;
}
export async function submitVideo(provider, model, prompt, duration, options = {}) {
  if (!['dreamina_cli','xiaoyunque_cli','lululab_cli'].includes(provider)) throw new LocalVideoCliError(`未知本地视频 provider：${provider}`);
  if (typeof prompt !== 'string' || !prompt.trim()) throw new LocalVideoCliError('视频 Prompt 不能为空。');
  const checked = validateGeneration(model, duration, options.resolution ?? '720p');
  const files = [...new Set((options.referenceFiles ?? []).map(expand))];
  if (files.length > checked.maxImages) throw new LocalVideoCliError(`视频参考图数量 ${files.length} 超过模型上限 ${checked.maxImages}。`);
  for (const file of files) if (!(await stat(file).catch(() => null))?.size) throw new LocalVideoCliError(`视频参考图不存在或为空：${file}`);
  if (provider === 'lululab_cli') return lulu.submitVideo(model, prompt, duration, {...options, referenceFiles: files});
  const args = [files.length ? 'multimodal2video' : 'text2video', '--prompt', prompt.trim(), '--duration', String(checked.duration),
    '--ratio', options.aspectRatio ?? '9:16', '--video_resolution', options.resolution ?? '720p', '--model_version', modelId(provider, model)];
  for (const file of files) args.push('--image', file);
  const value = provider === 'dreamina_cli' ? await runDreaminaCli(args) : await runXiaoyunqueCli(args);
  const id = value.id ?? value.taskId ?? value.data?.id ?? value.data?.taskId;
  if (!id) throw new LocalVideoCliError('submit 响应缺少 id。');
  return String(id);
}
export async function fetchVideo(provider, taskId) {
  if (!String(taskId).trim()) throw new LocalVideoCliError('任务 id 不能为空。');
  if (provider === 'lululab_cli') return (await lulu.client()).task(String(taskId).trim());
  const args = ['query_result','--submit_id',String(taskId).trim()];
  if (provider === 'dreamina_cli') return runDreaminaCli(args);
  if (provider === 'xiaoyunque_cli') return runXiaoyunqueCli(args);
  throw new LocalVideoCliError(`未知本地视频 provider：${provider}`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv[2] !== 'detect') {console.error('expected detect'); process.exitCode = 1;}
  else console.log(JSON.stringify(await detectVideoProviders(process.argv[4] || null)));
}
