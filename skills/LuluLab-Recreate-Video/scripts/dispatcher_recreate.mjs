#!/usr/bin/env node
/** Frontend-compatible recreation parent tasks. Node >=20, no dependencies. */
import { readFile, writeFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { LuluLabClient, resolveApiKey } from './lululab_cli.mjs';

export const WORKFLOWS = { storyboard: 'StoryboardRecreationV1', deep: 'DeepRecreationV1', element_replace: 'ElementReplacementV1' };
const models = { storyboard: ['seedance-2-mini', 'seedance-2-fast', 'seedance-2', 'seedance-2-5', 'wan-3'],
  deep: ['seedance-2-fast', 'seedance-2', 'seedance-2-5', 'wan-3'], element_replace: ['seedance-2-5', 'wan-3'] };
const guid = value => typeof value === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value) && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value);
const sleep = ms => new Promise(done => setTimeout(done, ms));
function https(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw Error('Media must use HTTPS without embedded credentials.');
  return url.href;
}
function reference(file, type) {
  if (!file || typeof file !== 'object') throw Error('Media requires an uploaded file object.');
  const mimeType = file.mimeType;
  if (typeof mimeType !== 'string' || !mimeType.startsWith(`${type}/`)) throw Error(`Expected ${type} media MIME type.`);
  const expiredAt = file.expiredAt || file.expiresAt;
  if (expiredAt && (!Number.isFinite(Date.parse(expiredAt)) || Date.parse(expiredAt) <= Date.now())) throw Error('Media is expired.');
  return { url: https(file.url || file.location), mimeType, ...(expiredAt ? { expiredAt } : {}) };
}

export function buildTask(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw Error('Request must be a JSON object.');
  if (config.promptOnly || config.executionMode === 'prompt-only') throw Error('Prompt-only requests must use the legacy export path, not a paid Dispatcher parent.');
  const mode = config.mode ?? 'deep';
  if (!Object.hasOwn(WORKFLOWS, mode)) throw Error('mode must be storyboard, deep or element_replace.');
  const model = config.model ?? (mode === 'element_replace' ? 'seedance-2-5' : 'seedance-2-fast');
  if (!models[mode].includes(model)) throw Error('The frontend does not support this model for the selected mode.');
  const duration = config.sourceDuration;
  if (!Number.isFinite(duration) || duration < 4 || duration > 60) throw Error('sourceDuration must be the measured source duration, 4–60 seconds.');
  if (!guid(config.source?.id)) throw Error('source.id must be an owned uploaded Asset file ID, not a public URL or asset-record ID.');
  const source = reference(config.source, 'video');
  const images = name => {
    const files = config[name] ?? [];
    if (!Array.isArray(files)) throw Error(`${name} must be an array.`);
    return files.map(file => reference(file, 'image'));
  };
  const productImages = images('productImages'), personImages = images('personImages'), backgroundImages = images('backgroundImages');
  const creatorMode = config.creatorMode ?? (personImages.length ? 'user_provided' : 'ai_generated');
  if (!['ai_generated', 'user_provided', 'keep_source'].includes(creatorMode)) throw Error('Invalid creatorMode.');
  if (mode !== 'element_replace' && ((creatorMode === 'user_provided') !== Boolean(personImages.length))) throw Error('Only user_provided creator mode accepts and requires person images.');
  const imageLimit = mode === 'element_replace' ? 10 : ((mode === 'deep' && creatorMode !== 'user_provided') || creatorMode === 'ai_generated' ? 6 : 7);
  if (productImages.length + personImages.length + backgroundImages.length > imageLimit) throw Error(`At most ${imageLimit} reference images are supported for this mode.`);
  if (config.referenceAudios !== undefined && !Array.isArray(config.referenceAudios)) throw Error('referenceAudios must be an array.');
  const referenceAudios = (config.referenceAudios ?? []).map(file => reference(file, 'audio'));
  if (referenceAudios.length > 1) throw Error('At most one voice reference is supported.');
  if (config.generateAudio !== undefined && typeof config.generateAudio !== 'boolean') throw Error('generateAudio must be boolean.');
  const generateAudio = config.generateAudio ?? true;
  if (referenceAudios.length && !generateAudio) throw Error('Voice references require generateAudio=true.');
  const aspectRatio = config.aspectRatio ?? '9:16', resolution = config.resolution ?? '720p';
  const ratios = model === 'wan-3' ? ['9:16', '16:9', '1:1', '3:4', '4:3'] : ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
  const resolutions = model === 'wan-3' ? ['720p'] : model === 'seedance-2-5' ? ['480p', '720p', '1080p'] : ['480p', '720p'];
  if (!ratios.includes(aspectRatio) || !resolutions.includes(resolution)) throw Error('Unsupported model aspect ratio or resolution; use the frontend model settings.');
  if (config.requirement !== undefined && typeof config.requirement !== 'string') throw Error('requirement must be text.');
  const requirement = (config.requirement ?? '').trim();
  if (config.marketingText !== undefined && typeof config.marketingText !== 'string') throw Error('marketingText must be text.');
  const locale = config.interactionLocale ?? 'zh-CN';
  if (typeof locale !== 'string' || !locale.trim()) throw Error('interactionLocale must be nonempty text.');
  let input;
  if (mode === 'storyboard') {
    const shared = { interactionLocale: locale, targetCountry: config.targetCountry ?? '跟原视频一致',
      targetLanguage: config.targetLanguage ?? '跟原视频一致', customRequirement: requirement };
    input = { schemaVersion: 'lululab.recreate.video.v1', recreateMode: 'storyboard',
      storyboardPipelineVersion: 2, reviewBeforeGeneration: false,
      postproduction: { marketingText: (config.marketingText ?? requirement).trim(), marketingTextMode: config.marketingText === undefined ? 'creative_brief' : 'literal' },
      benchmarkVideo: { ...source, assetId: config.source.id, duration },
      userConfig: { model, sourceDuration: duration, targetDuration: Math.round(duration), targetDurationSource: 'source_nearest_integer', ...shared },
      product: { mode: productImages.length ? 'replace' : 'keep_source', images: productImages },
      creator: { mode: creatorMode, images: personImages },
      assets: { backgroundMode: backgroundImages.length ? 'replace' : 'keep_source', backgroundImages, referenceAudios },
      settings: { videoModel: model, durationMode: 'source', aspectRatio, resolution, generateAudio, ...shared } };
  } else {
    if (config.targetLanguage || config.targetCountry) throw Error('For deep/element_replace, include language/country instructions in requirement, as in the frontend.');
    input = { model, intentVersion: 'lululab.recreation.intent.v1', userRequirement: requirement,
      productImages, personImages, backgroundImages, aspectRatio: model === 'seedance-2-5' ? 'adaptive' : aspectRatio,
      resolution, duration: Math.ceil(duration), generateAudio, sourceAssetId: config.source.id,
      sourceDurationMs: Math.round(duration * 1000), modelDurationLimitMs: ['seedance-2-5', 'wan-3'].includes(model) ? 30000 : 15000,
      ...([...productImages, ...personImages, ...backgroundImages].length ? { referenceImages: [...productImages, ...personImages, ...backgroundImages] } : {}),
      ...(referenceAudios.length ? { referenceAudios } : {}) };
    if (mode === 'deep') Object.assign(input, { deepPipelineVersion: 2, deepPresentationVersion: 1, creator: { mode: creatorMode }, recreateMode: 'deep', benchmarkVideo: source,
      deepRequirement: requirement, sourceAspectRatio: aspectRatio });
  }
  const stored = (originals, normalized) => normalized.map((file, index) => ({ ...originals[index], ...file }));
  const selected = { product: stored(config.productImages ?? [], productImages), person: stored(config.personImages ?? [], personImages),
    background: stored(config.backgroundImages ?? [], backgroundImages), voice: stored(config.referenceAudios ?? [], referenceAudios) };
  const editorSnapshot = { cloneMode: mode, brief: requirement, selected, referenceVideo: { ...config.source, ...source },
    sourceVideoDuration: duration, model, aspectRatio, resolution, duration: Math.round(duration), generateAudio,
    personSource: creatorMode === 'user_provided' ? 'upload' : creatorMode === 'keep_source' ? 'original' : 'generate',
    personPhotos: selected.person, mentionBindings: [] };
  return { workflowId: WORKFLOWS[mode], input, editorSnapshot };
}

export async function estimate(config, client) {
  const result = await client.request('/billing/estimates', { method: 'POST', body: { items: [buildTask(config)] } });
  if (!Number.isSafeInteger(result?.credits) || result.credits < 0) throw Error('Billing estimate has no valid credit total. Do not submit.');
  return result;
}

export class DispatcherClient extends LuluLabClient {
  async upload(file, mimeType) {
    const bytes = await readFile(file);
    if (!bytes.length || !/^(video|image|audio)\/[\w.+-]+$/.test(mimeType ?? '')) throw Error('Provide a nonempty file and its media MIME type.');
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
    return { id: result.id, ...ref };
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
export async function submit(config, file, client) {
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
  node scripts/dispatcher_recreate.mjs submit --config <request.json> --state <task-state.json> --generation-approved
  node scripts/dispatcher_recreate.mjs poll --state <task-state.json> [--max-polls 60] [--interval-ms 8000]
  node scripts/dispatcher_recreate.mjs download --state <task-state.json> --output <final.mp4>
Credentials: LULULAB_API_KEY or existing private LuluLab config. Never pass keys in arguments.
plan is offline. estimate only queries /billing/estimates. submit obtains /billing/quotes then POSTs /tasks once. poll never submits.
`;
export async function main(args = process.argv.slice(2)) {
  if (!args.length || args.includes('--help')) { process.stdout.write(HELP); return; }
  const command = args[0];
  const allowed = { upload: ['--file', '--mime-type', '--output'], plan: ['--config', '--output'], estimate: ['--config'],
    submit: ['--config', '--state', '--generation-approved'], poll: ['--state', '--max-polls', '--interval-ms'], download: ['--state', '--output'] };
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
  else if (command === 'submit') result = await submit(config, stateFile, client);
  else if (command === 'poll') result = await poll(stateFile, client, { maxPolls, intervalMs, onProgress: progress => process.stderr.write(JSON.stringify(progress) + '\n') });
  else result = await download(stateFile, output, client);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (['Failed', 'Cancelled'].includes(result.status)) process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
