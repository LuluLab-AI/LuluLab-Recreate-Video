#!/usr/bin/env node
/** Submit or resume one ImageGenV2 task without risking a duplicate paid submission. */
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, stat, open, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import * as cli from './local_video_cli_lululab.mjs';
import { AuthorizationUnavailableError, publicError } from './service_privacy.mjs';

const expand = value => resolve(String(value).replace(/^~(?=\/|$)/, homedir()));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const exists = async path => (await stat(path).catch(() => null))?.isFile() ?? false;
async function save(path, value) {
  await mkdir(dirname(path), {recursive: true});
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
  await rename(temporary, path);
}
async function lock(path) {
  await mkdir(dirname(path), {recursive: true});
  try {
    const handle = await open(path, 'wx');
    await handle.writeFile(JSON.stringify({pid: process.pid, acquiredAt: Date.now()}) + '\n');
    return handle;
  } catch (error) {
    if (error.code === 'EEXIST') throw Error('同一图片任务已有进程在运行；请继续原进程。');
    throw error;
  }
}
export async function execute(args, dependencies = cli) {
  const reportPath = expand(args.report), outputPath = expand(args.output);
  const lockPath = `${reportPath}.lock`, handle = await lock(lockPath);
  try {
    const result = await executeLocked(args, reportPath, outputPath, dependencies);
    await save(reportPath, result.report);
    return result;
  } finally {
    await handle.close(); await unlink(lockPath).catch(() => {});
  }
}
async function executeLocked(args, reportPath, outputPath, dependencies) {
  const prompt = (args.promptFile ? await readFile(expand(args.promptFile), 'utf8') : args.prompt || '').trim();
  if (!prompt) throw Error('图片 Prompt 不能为空。');
  if (!['16:9', '1:1', '3:4', '4:3', '9:16'].includes(args.aspectRatio)) throw Error('无效的图片宽高比。');
  const references = (args.referenceImages || []).map(expand);
  const digests = [];
  for (const path of references) {
    const info = await stat(path).catch(() => null);
    if (!info?.isFile() || !info.size) throw Error(`参考图不存在或为空：${path}`);
    digests.push(sha(await readFile(path)));
  }
  const evidence = {promptSha256: sha(Buffer.from(prompt)), referenceSha256: digests};
  let taskId = String(args.resumeTaskId || '').trim();
  if (await exists(reportPath)) {
    const previous = JSON.parse(await readFile(reportPath, 'utf8'));
    if (['promptSha256', 'referenceSha256'].some(key =>
      Object.hasOwn(previous, key) && JSON.stringify(previous[key]) !== JSON.stringify(evidence[key])))
      throw Error('恢复图片任务的 Prompt 或参考图与原提交不一致。');
    if (taskId && previous.taskId && taskId !== previous.taskId) throw Error('恢复任务 ID 与已保存的图片任务不一致。');
    if (!taskId && (previous.taskId || ['submit_pending', 'submit_outcome_unknown', 'success'].includes(previous.status)))
      throw Error('该输出已有提交记录；只能恢复原任务，禁止重复提交。');
  }
  const base = { ...evidence, taskId, provider: 'lululab_cli', model: cli.IMAGE_MODEL,
    resolution: cli.IMAGE_RESOLUTION, output: outputPath };
  if (!taskId) {
    dependencies.imageWorkflowId();
    await save(reportPath, {...base, status: 'submit_pending'});
    try { taskId = await dependencies.submitImage(prompt, references, args.aspectRatio); }
    catch (error) {
      if (error instanceof AuthorizationUnavailableError || error instanceof Error)
        return {code: 3, report: {...base, status: 'submit_outcome_unknown',
          message: publicError(error.message, 'LuluLab图片提交失败。')}};
      throw error;
    }
    base.taskId = taskId;
    await save(reportPath, {...base, status: 'submitted'});
  }
  try {
    const raw = await dependencies.pollTask(id => dependencies.client().then(api => api.task(id)), taskId,
      {timeoutMs: 1800000});
    const media = dependencies.media(raw, 'image/png');
    const saved = await dependencies.downloadMedia(media, outputPath);
    return {code: 0, report: {...base, status: 'success', output: saved, media}};
  } catch (error) {
    if (error instanceof cli.TaskFailedError)
      return {code: 2, report: {...base, status: 'terminal_failed', message: error.message}};
    return {code: 3, report: {...base, status: 'poll_unknown',
      message: publicError(error.message, 'LuluLab图片任务查询失败。')}};
  }
}
export function parseArgs(args) {
  const out = {referenceImages: []};
  const names = {'--prompt': 'prompt', '--prompt-file': 'promptFile', '--aspect-ratio': 'aspectRatio',
    '--output': 'output', '--report': 'report', '--resume-task-id': 'resumeTaskId'};
  for (let i = 0; i < args.length; i++) {
    const name = args[i], value = args[++i];
    if (!value) throw Error(`缺少 ${name} 的值。`);
    if (name === '--reference-image') out.referenceImages.push(value);
    else if (names[name]) out[names[name]] = value;
    else throw Error(`未知参数：${name}`);
  }
  if ((!out.prompt && !out.promptFile) || (out.prompt && out.promptFile) || !out.output || !out.report || !out.aspectRatio)
    throw Error('需要 Prompt、宽高比、输出路径与报告路径。');
  return out;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let code = 1, report;
  try { ({code, report} = await execute(parseArgs(process.argv.slice(2)))); }
  catch (error) { report = {status: 'invalid_input', taskId: '', message: error.message}; }
  process.stdout.write(JSON.stringify(report) + '\n'); process.exitCode = code;
}
