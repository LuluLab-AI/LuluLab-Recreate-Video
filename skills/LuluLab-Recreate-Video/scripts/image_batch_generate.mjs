#!/usr/bin/env node
/** Submit related storyboard images together, then use the existing per-image recovery reports. */
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, open, unlink, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execute } from './lululab_image_generate.mjs';
import * as cli from './local_video_cli_lululab.mjs';
import { quoteTaskBatch, validateBatchResponse } from './credit_batch.mjs';

const expand = value => resolve(String(value).replace(/^~(?=\/|$)/, homedir()));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function load(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function save(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, path);
}
export async function executeBatch(config, dependencies = cli) {
  if (!config?.state || !Array.isArray(config.items) || !config.items.length || config.items.length > 100)
    throw Error('需要 state 路径和 1–100 个图片任务 items。');
  const statePath = expand(config.state), items = [];
  for (const item of config.items) {
    if (!item.report || !item.output || !['16:9', '1:1', '3:4', '4:3', '9:16'].includes(item.aspectRatio)) throw Error('图片任务缺少报告、输出路径或有效宽高比。');
    const prompt = (item.promptFile ? await readFile(expand(item.promptFile), 'utf8') : item.prompt || '').trim();
    if (!prompt) throw Error('图片 Prompt 不能为空。');
    const references = (item.referenceImages ?? []).map(expand), digests = [];
    if (references.length > 9) throw Error('参考图不能超过 9 张。');
    for (const file of references) {
      if (!(await stat(file)).size) throw Error('参考图片为空。');
      digests.push(sha(await readFile(file)));
    }
    items.push({ ...item, prompt, report: expand(item.report), output: expand(item.output), references,
      evidence: { promptSha256: sha(Buffer.from(prompt)), referenceSha256: digests } });
  }
  if (new Set([statePath, ...items.flatMap(item => [item.report, item.output])]).size !== 1 + 2 * items.length)
    throw Error('整批 state、各图片报告和输出必须使用不同路径。');
  const signature = sha(JSON.stringify(items.map(item => ({ report: item.report, output: item.output, aspectRatio: item.aspectRatio, ...item.evidence }))));
  await mkdir(dirname(statePath), { recursive: true });
  const lockPath = `${statePath}.lock`, lock = await open(lockPath, 'wx');
  const reportLocks = [];
  async function releaseReports() {
    for (const entry of reportLocks.splice(0)) { await entry.handle.close(); await unlink(entry.path).catch(() => {}); }
  }
  try {
    for (const item of [...items].sort((a, b) => a.report.localeCompare(b.report))) {
      await mkdir(dirname(item.report), { recursive: true });
      const path = `${item.report}.lock`, handle = await open(path, 'wx');
      reportLocks.push({ path, handle });
    }
    let state = await load(statePath);
    if (state && state.signature !== signature) throw Error('整批输入与原提交不同，请核对已有任务。');
    if (state?.submissionUnknown) throw Error('整批提交响应未知，请核对已有任务，禁止自动重提。');
    state ??= { signature, tasks: {} };
    const missing = [];
    for (const [index, item] of items.entries()) {
      const previous = await load(item.report);
      if (previous && Object.keys(item.evidence).some(key => Object.hasOwn(previous, key) && JSON.stringify(previous[key]) !== JSON.stringify(item.evidence[key])))
        throw Error('图片报告的 Prompt 或参考图与本次输入不同。');
      if (previous?.taskId) state.tasks[index] ??= { id: previous.taskId };
      if (!state.tasks[index]?.id) {
        if (previous && ['submit_pending', 'submit_outcome_unknown', 'success'].includes(previous.status)) throw Error('已有图片提交结果未知，禁止整批重提。');
        missing.push({ item, index });
      }
    }
    if (missing.length) {
      const api = await dependencies.client(), forms = [];
      for (const { item } of missing) {
        const referenceImages = await dependencies.uploadReferenceImages(item.references, { api });
        forms.push({ workflowId: dependencies.imageWorkflowId(), input: { model: cli.IMAGE_MODEL, resolution: cli.IMAGE_RESOLUTION,
          prompt: item.prompt, aspectRatio: item.aspectRatio, referenceImages } });
      }
      const quoted = await quoteTaskBatch(api, forms);
      state.quoteIds = quoted.map(form => form.quoteId); state.submissionUnknown = true;
      await save(statePath, state);
      const tasks = validateBatchResponse(await api.request('/tasks/batch', { method: 'POST', body: quoted }), forms.length);
      missing.forEach(({ index }, offset) => { state.tasks[index] = tasks[offset]; });
      state.submissionUnknown = false; await save(statePath, state);
    }
    for (const [index, item] of items.entries()) {
      if (!(await load(item.report))?.taskId) await save(item.report, { ...item.evidence, taskId: state.tasks[index].id, status: 'submitted', output: item.output });
    }
    await releaseReports(); // Every receipt is durable before the existing per-image poller takes its lock.
    const results = [];
    for (const [index, item] of items.entries()) {
      const taskId = state.tasks[index].id;
      results.push(await execute({ ...item, referenceImages: item.references, resumeTaskId: taskId }, dependencies));
    }
    return { code: results.every(result => result.code === 0) ? 0 : 3, state: statePath, results };
  } finally { await releaseReports(); await lock.close(); await unlink(lockPath).catch(() => {}); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--config') throw Error('用法：image_batch_generate.mjs --config batch.json');
    const result = await executeBatch(JSON.parse(await readFile(expand(process.argv[3]), 'utf8')));
    process.stdout.write(JSON.stringify(result) + '\n'); process.exitCode = result.code;
  } catch (error) { process.stderr.write(JSON.stringify({ status: 'failed', message: error.message }) + '\n'); process.exitCode = 1; }
}
