#!/usr/bin/env node
/** Frontend-compatible recreation parent tasks. Node >=20, no dependencies. */
import { readFile, writeFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { LuluLabClient, resolveApiKey, imageMimeType } from './lululab_cli.mjs';
import { buildTask, guid, https, reference, validateReferenceImage } from './recreation_task.mjs';

export { buildTask, WORKFLOWS } from './recreation_task.mjs';

const sleep = ms => new Promise(done => setTimeout(done, ms));

export async function estimate(config, client) {
  const result = await client.request('/billing/estimates', { method: 'POST', body: { items: [buildTask(config)] } });
  if (!Number.isSafeInteger(result?.credits) || result.credits < 0) throw Error('Billing estimate has no valid credit total. Do not submit.');
  return result;
}

export class DispatcherClient extends LuluLabClient {
  async upload(file, mimeType) {
    const bytes = await readFile(file);
    if (!bytes.length || !/^(video|image|audio)\/[\w.+-]+$/.test(mimeType ?? '')) throw Error('Provide a nonempty file and its media MIME type.');
    if (mimeType.startsWith('image/')) {
      validateReferenceImage(mimeType, basename(file));
      if (imageMimeType(bytes) !== mimeType) throw Error(`参考图「${basename(file)}」的实际格式与 MIME 类型不一致。请转换为 JPG、PNG 或 WebP 后重新上传。`);
    }
    const destination = await this.request('/uploads', { method: 'POST' });
    if (!guid(destination.id)) throw Error('Upload ticket did not return an Asset ID.');
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mimeType }), basename(file));
    // Current Asset upload tickets accept multipart POST and return the actual file.
    // Never forward the Customer API key to the signed media host.
    const response = await this.fetch(https(destination.presignedUrl), { method: 'POST', body: form,
      redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw Error(`Asset upload HTTP ${response.status}.`);
    const result = await response.json();
    if (result.id !== destination.id) throw Error('Uploaded Asset ID does not match its ticket.');
    const ref = reference(result, mimeType.split('/')[0]);
    return { id: result.id, ...ref, ...(mimeType.startsWith('image/') ? { fileName: basename(file) } : {}) };
  }
  async quote(task) {
    const quote = await this.request('/billing/quotes', { method: 'POST', body: task });
    if (!guid(quote.id)) throw Error('Billing response has no quote ID.');
    return quote;
  }
}

export async function save(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, file);
}
async function load(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function locked(file, action) {
  await mkdir(dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  try { await mkdir(lock); }
  catch (error) { if (error.code === 'EEXIST') throw Error(`Task state is locked: ${lock}. If a process crashed, verify it stopped before removing the lock.`); throw error; }
  try { return await action(); } finally { await rm(lock, { recursive: true }); }
}
function summary(state) {
  const task = state.task ?? {};
  return { taskId: state.taskId, workflowId: state.workflowId, status: state.status,
    stage: task.output?.stage ?? task.attributes?.stage, completedSegments: task.output?.completedSegments,
    totalSegments: task.output?.totalSegments, video: task.output?.video, file: state.file,
    errorMessage: task.errorMessage };
}
export async function submit(config, file, client, { maxCredits } = {}) {
  const task = buildTask(config);
  const signature = createHash('sha256').update(JSON.stringify(task)).digest('hex');
  return locked(file, async () => {
    let state = await load(file);
    if (state) {
      if (state.schema !== 'lululab.dispatcher.recreate.v1' || state.signature !== signature) throw Error('State belongs to another input or a legacy task. Use its original recovery path.');
      if (state.taskId) return summary(state);
      throw Error('Previous submission may have created a task. Inspect task history; do not resubmit.');
    }
    const quote = await client.quote(task);
    if (maxCredits !== undefined && (!Number.isSafeInteger(quote.credits) || quote.credits < 0 || quote.credits > maxCredits)) {
      throw Error('Live quote is missing or exceeds the approved credits. Obtain an updated estimate before submitting.');
    }
    state = { schema: 'lululab.dispatcher.recreate.v1', signature, workflowId: task.workflowId,
      request: task, quoteId: quote.id, quotedCredits: quote.credits, status: 'submission_unknown', taskId: null };
    // Persist BEFORE POST: timeouts, invalid responses and crashes must never create an automatic second task.
    await save(file, state);
    const result = await client.request('/tasks', { method: 'POST', body: { ...task, quoteId: quote.id } });
    if (!guid(result?.id)) throw Error('Submit response has no task ID; inspect history before recovery.');
    state.taskId = result.id; state.status = result.status; state.task = result;
    await save(file, state);
    return summary(state);
  });
}
export async function poll(file, client, { intervalMs = 8000, maxPolls = 60, onProgress = () => {} } = {}) {
  return locked(file, async () => {
    const state = await load(file);
    if (state?.schema !== 'lululab.dispatcher.recreate.v1' || !guid(state.taskId)) throw Error('No saved Dispatcher parent task ID. Do not submit another task to recover.');
    for (let i = 0; i < maxPolls; i++) {
      if (['Succeeded', 'Failed', 'Cancelled'].includes(state.status)) break;
      const task = await client.task(state.taskId);
      state.task = task; state.status = task.status; state.checkedAt = new Date().toISOString();
      await save(file, state);
      onProgress(summary(state));
      if (['Succeeded', 'Failed', 'Cancelled'].includes(state.status)) break;
      if (i + 1 < maxPolls) await sleep(intervalMs);
    }
    return summary(state);
  });
}
export async function download(file, output, client) {
  return locked(file, async () => {
    const state = await load(file);
    if (state?.schema !== 'lululab.dispatcher.recreate.v1' || state.status !== 'Succeeded') throw Error('Parent task has not succeeded; poll the saved task first.');
    if (state.file && (await stat(state.file).catch(() => null))?.size > 0) return summary(state);
    const url = https(state.task?.output?.video?.url);
    const response = await client.fetch(url, { redirect: 'error', signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw Error(`Video download HTTP ${response.status}.`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 100) throw Error('Video output is empty.');
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, bytes);
    state.file = output;
    await save(file, state);
    return summary(state);
  });
}

const HELP = `Dispatcher recreation (same parent tasks as the frontend):
  node scripts/dispatcher_recreate.mjs upload --file <path> --mime-type <video/mp4> --output <asset.json>
  node scripts/dispatcher_recreate.mjs plan --config <request.json> [--output <task.json>]
  node scripts/dispatcher_recreate.mjs estimate --config <request.json>
  node scripts/dispatcher_recreate.mjs submit --config <request.json> --state <task-state.json> --generation-approved [--max-credits <approved-total>]
  node scripts/dispatcher_recreate.mjs poll --state <task-state.json> [--max-polls 60] [--interval-ms 8000]
  node scripts/dispatcher_recreate.mjs download --state <task-state.json> --output <final.mp4>
Credentials: LULULAB_API_KEY or existing private LuluLab config. Never pass keys in arguments.
plan is offline. estimate only queries /billing/estimates. submit obtains /billing/quotes then POSTs /tasks once. poll never submits.
`;
export async function main(args = process.argv.slice(2)) {
  if (!args.length || args.includes('--help')) { process.stdout.write(HELP); return; }
  const command = args[0];
  const allowed = { upload: ['--file', '--mime-type', '--output'], plan: ['--config', '--output'], estimate: ['--config'],
    submit: ['--config', '--state', '--generation-approved', '--max-credits'], poll: ['--state', '--max-polls', '--interval-ms'], download: ['--state', '--output'] };
  if (!Object.hasOwn(allowed, command)) throw Error('Unknown command. Use --help.');
  const flags = {};
  for (let i = 1; i < args.length; i++) {
    const name = args[i];
    if (!allowed[command].includes(name) || Object.hasOwn(flags, name)) throw Error('Unknown or repeated option.');
    if (name === '--generation-approved') flags[name] = true;
    else { if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error(`Missing ${name} value.`); flags[name] = args[++i]; }
  }
  const required = name => { if (!flags[name]) throw Error(`Missing ${name}.`); return flags[name]; };
  const file = name => resolve(required(name));
  let config;
  if (['plan', 'estimate', 'submit'].includes(command)) config = JSON.parse(await readFile(file('--config'), 'utf8'));
  if (command === 'plan') {
    const task = buildTask(config);
    if (flags['--output']) await save(file('--output'), task);
    process.stdout.write(JSON.stringify(task, null, 2) + '\n'); return;
  }
  if (command === 'submit' && !flags['--generation-approved']) throw Error('Paid generation requires existing user authorization and --generation-approved.');
  const maxCredits = flags['--max-credits'] === undefined ? undefined : Number(flags['--max-credits']);
  if (maxCredits !== undefined && (!Number.isSafeInteger(maxCredits) || maxCredits < 0)) throw Error('Invalid approved credit total.');
  const stateFile = ['submit', 'poll', 'download'].includes(command) ? file('--state') : null;
  const output = ['upload', 'download'].includes(command) ? file('--output') : null;
  const sourceFile = command === 'upload' ? file('--file') : null;
  const mimeType = command === 'upload' ? required('--mime-type') : null;
  const maxPolls = Number(flags['--max-polls'] ?? 60), intervalMs = Number(flags['--interval-ms'] ?? 8000);
  if (!Number.isInteger(maxPolls) || maxPolls < 1 || maxPolls > 10000 || !Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 60000) throw Error('Invalid polling bounds.');
  const client = new DispatcherClient({ apiKey: await resolveApiKey(), baseUrl: process.env.LULULAB_API_BASE_URL || 'https://customer.lululab.ai' });
  let result;
  if (command === 'estimate') result = await estimate(config, client);
  else if (command === 'upload') { result = await client.upload(sourceFile, mimeType); await save(output, result); }
  else if (command === 'submit') result = await submit(config, stateFile, client, { maxCredits });
  else if (command === 'poll') result = await poll(stateFile, client, { maxPolls, intervalMs, onProgress: progress => process.stderr.write(JSON.stringify(progress) + '\n') });
  else result = await download(stateFile, output, client);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (['Failed', 'Cancelled'].includes(result.status)) process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
