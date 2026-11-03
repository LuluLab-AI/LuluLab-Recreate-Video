#!/usr/bin/env node
/** Prepare a LibTV canvas and run approved video segments in parallel. */
import {spawnSync, execFile} from 'node:child_process';
import {mkdir, readFile, rename, stat, writeFile} from 'node:fs/promises';
import {basename, dirname, join, resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {loadManifest, saveManifest, setVideo, validatePromptRecord} from './generation_manifest.mjs';
import {resolveLibtvCli} from './local_video_cli.mjs';
import {audit} from './reference_audit.mjs';
import {prepareReferences, productFiles} from './run_generation.mjs';

export class LibTVBatchError extends Error {}
const expand = p => resolve(String(p).replace(/^~(?=\/|$)/, homedir()));
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const nonempty = async p => {const s = await stat(p).catch(() => null); return Boolean(s?.isFile() && s.size);};
const execFileAsync = promisify(execFile);
export async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), {recursive: true});
  const temp = `${path}.tmp`; await writeFile(temp, JSON.stringify(value, null, 2)); await rename(temp, path);
}
export function parseJsonOutput(stdout) {
  for (const line of stdout.split(/\r?\n/).reverse()) {
    try {const value = JSON.parse(line.trim()); if (object(value)) return value;} catch {}
  }
  throw new LibTVBatchError('LibTV CLI 没有返回可解析的JSON。');
}
export class LibTVClient {
  constructor(executable, cwd) {this.executable = executable; this.cwd = cwd;}
  call(...arguments_) {
    let expectJson = true;
    if (object(arguments_.at(-1)) && 'expectJson' in arguments_.at(-1)) expectJson = arguments_.pop().expectJson;
    const result = spawnSync(this.executable, arguments_.map(String), {cwd: this.cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024});
    if (result.error || result.status !== 0) {
      const message = result.error?.message ?? result.stderr?.trim() ?? result.stdout?.trim() ?? `exit=${result.status}`;
      throw new LibTVBatchError(`LibTV命令失败：${arguments_.slice(0, 3).join(' ')}：${message}`);
    }
    return expectJson ? parseJsonOutput(result.stdout) : result.stdout.trim();
  }
  accountInfo() {return this.call('account', 'info');}
  modelInfo(model) {return this.call('model', model);}
  projectInfo(uuid) {return this.call('project', uuid);}
  createWorkspace(name, description = '') {
    const value = this.call('workspace', 'create', name, ...(description ? ['-d', description] : []));
    const nested = object(value.workspace) ? value.workspace : {};
    const id = String(value.workspaceId || value.id || value.folderId || nested.workspaceId || nested.id || nested.folderId || '').trim();
    if (!/^-?\d+$/.test(id)) throw new LibTVBatchError(`创建LibTV工作区后未返回workspaceId：${JSON.stringify(value).slice(0, 200)}`);
    return Number(id);
  }
  createProject(name, workspaceId) {
    const value = this.call('project', 'create', name, '--workspace', String(workspaceId));
    const nested = object(value.project) ? value.project : {}, meta = object(value.projectMeta) ? value.projectMeta : {};
    const id = String(value.uuid || value.projectUuid || nested.uuid || nested.projectUuid || meta.uuid || meta.projectUuid || '').trim();
    if (!id) throw new LibTVBatchError(`创建LibTV画布后未返回projectUuid：${JSON.stringify(value).slice(0, 200)}`);
    return id;
  }
  upload(projectUuid, name, file, x, y) {
    const value = this.call('upload', name, '--project', projectUuid, '--file', file, '--type', 'image', '--x', String(x), '--y', String(y));
    const id = String(value.nodeKey || value.newNodeKey || '').trim();
    if (!id) throw new LibTVBatchError(`上传${name}后未返回nodeKey。`);
    return id;
  }
  createVideoNode(options) {
    const value = this.call(...videoNodeArguments(options));
    const id = String(value.nodeKey || value.newNodeKey || '').trim();
    if (!id) throw new LibTVBatchError(`创建${options.name}后未返回nodeKey。`);
    return id;
  }
  async runVideoNode(projectUuid, nodeKey) {
    try {
      const {stdout} = await execFileAsync(this.executable, ['node', nodeKey, '--project', projectUuid, '--run'],
        {cwd: this.cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024});
      return parseJsonOutput(stdout);
    } catch (error) {
      throw new LibTVBatchError(`LibTV命令失败：node ${nodeKey} --project：${error.stderr?.trim() || error.message}`);
    }
  }
  async download(projectUuid, nodeKey, outputDir, vip) {
    await mkdir(outputDir, {recursive: true});
    const output = this.call('download', '--project', projectUuid, '--node', nodeKey, '--out', outputDir,
      '--without-ai-watermark', ...(vip ? ['--vip'] : []), {expectJson: false});
    for (const candidate of output.split(/\r?\n/).reverse()) if (candidate.trim() && await nonempty(candidate.trim())) return resolve(candidate.trim());
    throw new LibTVBatchError(`下载节点${nodeKey}后未找到本地文件。`);
  }
}
export function videoNodeArguments({projectUuid, name, prompt, orderedNodeKeys, model, duration, ratio, resolution, x, y}) {
  const args = ['node','--x',String(x),'--y',String(y),'create',name,'--project',projectUuid,'--type','video',
    '--prompt',prompt,'--set',`model=${model}`,'--set','modeType=mixed2video','--set',`ratio=${ratio}`,
    '--set',`resolution=${resolution}`,'--set',`duration=${duration}`,'--set','enableSound=on',
    '--set','searchEnabled=0','--set','autoCompliance=1'];
  for (const nodeKey of orderedNodeKeys) args.push('--left', nodeKey);
  return args;
}
export const bindPrompt = (prompt, keys) => `参考图已按严格顺序绑定：${keys.map(key => `{{Node ${key}}}`).join('、')}。\n\n${prompt.trim()}`;
export function extractTask(result) {
  const data = object(result.data) ? result.data : result, task = object(data.taskInfo) ? data.taskInfo : {};
  const url = Array.isArray(data.url) ? String(data.url[0] ?? '').trim() : '';
  if (task.status !== 2 || !url) throw new LibTVBatchError(`LibTV视频节点未成功完成：status=${task.status}`);
  return {taskId: String(task.taskId ?? ''), remoteUrl: url, progressPercent: task.progressPercent};
}
export function nodeIndex(project) {
  if (!Array.isArray(project?.nodes)) throw new LibTVBatchError('LibTV画布详情缺少nodes数组。');
  const result = {}, duplicates = new Set();
  for (const item of project.nodes) {
    if (!object(item)) continue;
    const name = String(item.name ?? '').trim(), key = String(item.id || item.nodeKey || '').trim();
    if (!name || !key) continue;
    if (name in result) duplicates.add(name);
    result[name] = key;
  }
  if (duplicates.size) throw new LibTVBatchError(`LibTV画布存在重复节点名，无法安全复用：${[...duplicates].join(',')}`);
  return result;
}
export async function runNodesParallel(client, projectUuid, nodes, {maxWorkers = 4} = {}) {
  const completed = {}, errors = {}, entries = Object.entries(nodes); let cursor = 0;
  await Promise.all(Array.from({length: Math.max(1, Math.min(maxWorkers, entries.length))}, async () => {
    while (cursor < entries.length) {
      const [segmentId, nodeKey] = entries[cursor++];
      try {completed[segmentId] = extractTask(await client.runVideoNode(projectUuid, nodeKey));}
      catch (error) {errors[segmentId] = error.message;}
    }
  }));
  return {completed, errors};
}
const names = {'seedance-2-mini':'Seedance 2.0 Mini','seedance-2-fast':'Seedance 2.0 Fast VIP',
  'seedance-2':'Seedance 2.0 VIP','seedance-2-5':'Seedance 2.5'};
const keys = {'seedance-2-mini':'star-video2-mini','seedance-2-fast':'star-video2-fast',
  'seedance-2':'star-video2','seedance-2-5':'star-video2.5'};
export function defaultLibtvModel(manifestModel) {
  const raw = String(manifestModel).trim(), lower = raw.toLowerCase();
  if (names[lower]) return names[lower];
  for (const [logical, key] of Object.entries(keys)) if (key === lower) return names[logical];
  const spaced = lower.replaceAll('.', ' ');
  if (spaced.includes('seedance') && spaced.includes('fast')) return names['seedance-2-fast'];
  if (spaced.includes('seedance') && spaced.includes('mini')) return names['seedance-2-mini'];
  if (spaced.includes('seedance') && (spaced.includes('2 5') || spaced.includes('25'))) return names['seedance-2-5'];
  return raw;
}
export function resolveLibtvModel(client, requested) {
  const candidate = defaultLibtvModel(requested), wanted = keys[String(requested).trim().toLowerCase()] ?? String(requested).trim().toLowerCase();
  let payload; try {payload = client.call('model','search',candidate);} catch (error) {if (error instanceof LibTVBatchError) return candidate; throw error;}
  if (!Array.isArray(payload.matches)) return candidate;
  const exactKey = payload.matches.find(x => object(x) && String(x.modelKey ?? '').toLowerCase() === wanted);
  if (exactKey) return String(exactKey.modelName || candidate);
  const exactName = payload.matches.find(x => object(x) && String(x.modelName ?? '').trim().toLowerCase() === candidate.trim().toLowerCase());
  return exactName ? String(exactName.modelName) : candidate;
}
export function existingUploads(state) {
  const uploads = object(state.uploads) ? {...state.uploads} : {};
  for (const item of Object.values(object(state.sharedReferences) ? state.sharedReferences : {}))
    if (object(item) && item.file && item.nodeKey) uploads[expand(item.file)] = {nodeKey: String(item.nodeKey), name: String(item.name ?? '')};
  for (const segment of Array.isArray(state.segments) ? state.segments : [])
    for (const item of Array.isArray(segment?.orderedReferences) ? segment.orderedReferences : [])
      if (object(item) && item.file && item.nodeKey) uploads[expand(item.file)] = {nodeKey: String(item.nodeKey), name: String(item.name ?? '')};
  return uploads;
}
export async function loadState(path) {
  if (!await nonempty(path)) return {schemaVersion: '1.0', provider: 'libtv_cli', uploads: {}, segments: {}};
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (!object(value)) throw new LibTVBatchError('LibTV编排状态文件必须是JSON对象。');
  if (Array.isArray(value.segments)) value.segments = Object.fromEntries(value.segments.filter(object).map(x => [String(x.segmentId), x]));
  value.uploads = existingUploads(value); value.segments ??= {};
  return value;
}
export async function runBatch({manifest, workspaceId = null, projectUuid = null, projectName = null,
  libtvModel = null, generationApproved = false, vipDownload = false, planOnly = false,
  clientFactory = null} = {}) {
  const manifestPath = expand(manifest), root = dirname(manifestPath), data = await loadManifest(manifestPath);
  const promptPayload = JSON.parse(await readFile(expand(data.videoPrompts.file), 'utf8')).videoPrompts;
  if (!object(promptPayload)) throw new LibTVBatchError('Prompt 文件缺少 videoPrompts。');
  validatePromptRecord(promptPayload, data);
  const segments = promptPayload.segments, auditResult = audit(data, segments);
  const requestedModel = libtvModel || String(data.userConfig?.videoModel ?? '').trim() || 'seedance-2-fast';
  let model = defaultLibtvModel(requestedModel);
  const ratio = String(data.userConfig?.aspectRatio ?? '9:16'), resolution = String(data.userConfig?.resolution ?? '720p');
  const plans = [];
  for (const segment of segments) plans.push({segment, files: (await prepareReferences(data, segment, root,
    String(data.userConfig?.videoModel ?? 'seedance-2-fast'))).map(expand)});
  if (planOnly) return {ok: true, status: 'plan_only', model,
    segments: plans.map(x => ({segmentId: Number(x.segment.segmentId), orderedFiles: x.files})), audit: auditResult};
  if (!generationApproved) throw new LibTVBatchError('LibTV首次视频生成必须处于用户确认授权内；请传入--generation-approved。');
  const client = clientFactory ? await clientFactory(root) : new LibTVClient(await resolveLibtvCli(), root);
  const account = client.accountInfo(); model = resolveLibtvModel(client, requestedModel);
  const modelInfo = client.modelInfo(model), spec = modelInfo.schema?.properties?.duration ?? {};
  const minimum = Number(spec.min ?? 1), maximum = Number(spec.max ?? 60);
  for (const plan of plans) {
    const duration = Number(plan.segment.duration);
    if (!Number.isInteger(duration) || duration < minimum || duration > maximum)
      throw new LibTVBatchError(`Segment ${plan.segment.segmentId} 时长${duration}秒超出LibTV模型范围${minimum}-${maximum}秒。`);
  }
  const statePath = join(root, 'libtv-generation.json'), state = await loadState(statePath);
  let uuid = String(projectUuid || state.projectUuid || '').trim();
  let workspace = workspaceId || state.workspaceId;
  let project;
  if (uuid) project = client.projectInfo(uuid);
  else {
    const name = projectName || basename(root);
    if (!workspace) workspace = client.createWorkspace(name, 'recreate-video-agent 自动创建');
    uuid = client.createProject(name, Number(workspace)); project = client.projectInfo(uuid);
  }
  const knownNodes = nodeIndex(project);
  Object.assign(state, {schemaVersion: '1.0', provider: 'libtv_cli', projectUuid: uuid, workspaceId: workspace,
    model, requestedModel, status: 'preparing', account: {memberName: account.memberName}});
  await atomicWriteJson(statePath, state);
  const uploadNames = {}, products = new Set(productFiles(data).map(expand));
  const creatorByPath = Object.fromEntries((data.creators ?? []).filter(x => object(x) && x.file)
    .map(x => [expand(x.file), String(x.creatorId ?? 'creator')]));
  for (const plan of plans) {
    const sid = Number(plan.segment.segmentId);
    for (const [position, file] of plan.files.entries()) {
      if (file in uploadNames) continue;
      if (position === 0) uploadNames[file] = `S${String(sid).padStart(2, '0')}-最终Storyboard`;
      else if (products.has(file)) uploadNames[file] = `产品参考图-${Object.values(uploadNames).filter(x => x.startsWith('产品参考图-')).length + 1}`;
      else if (file in creatorByPath) uploadNames[file] = `${creatorByPath[file]}-人物参考图`;
      else uploadNames[file] = `参考图-${Object.keys(uploadNames).length + 1}`;
    }
  }
  const uploads = (state.uploads ??= {});
  for (const [index, [file, name]] of Object.entries(uploadNames).entries()) {
    const record = object(uploads[file]) ? uploads[file] : {};
    let key = String(record.nodeKey || knownNodes[name] || '').trim();
    if (!key) {key = client.upload(uuid, name, file, index % 3 * 380 - 760, Math.floor(index / 3) * 720); knownNodes[name] = key;}
    uploads[file] = {nodeKey: key, name}; await atomicWriteJson(statePath, state);
  }
  const stateSegments = (state.segments ??= {}), runnable = {};
  for (const [index, plan] of plans.entries()) {
    const sid = Number(plan.segment.segmentId), key = String(sid);
    const record = object(stateSegments[key]) ? stateSegments[key] : {};
    const orderedKeys = plan.files.map(file => String(uploads[file].nodeKey));
    const name = `S${String(sid).padStart(2, '0')}-生成视频`;
    let nodeKey = String(record.videoNodeKey || knownNodes[name] || '').trim();
    const bound = bindPrompt(String(plan.segment.prompt), orderedKeys);
    if (!nodeKey) {
      nodeKey = client.createVideoNode({projectUuid: uuid, name, prompt: bound, orderedNodeKeys: orderedKeys,
        model, duration: Number(plan.segment.duration), ratio, resolution, x: 760, y: index * 720});
      knownNodes[name] = nodeKey;
    }
    Object.assign(record, {segmentId: sid, duration: Number(plan.segment.duration), videoNodeKey: nodeKey,
      orderedFiles: plan.files, orderedNodeKeys: orderedKeys, prompt: bound});
    if (!['succeeded','run_started_uncertain'].includes(record.status)) record.status = 'prepared';
    stateSegments[key] = record; await atomicWriteJson(statePath, state);
  }
  for (const [key, record] of Object.entries(stateSegments)) {
    if (record.status === 'succeeded') continue;
    if (record.status === 'run_started_uncertain') {
      const current = client.call('node', String(record.videoNodeKey), '--project', uuid);
      try {Object.assign(record, extractTask(current), {status: 'succeeded'}); await atomicWriteJson(statePath, state); continue;}
      catch (error) {if (!(error instanceof LibTVBatchError)) throw error;}
      throw new LibTVBatchError(`Segment ${key}已有状态不确定的LibTV任务；为避免重复付费，本次不重新提交。`);
    }
    record.status = 'run_started_uncertain'; runnable[key] = String(record.videoNodeKey);
  }
  await atomicWriteJson(statePath, state);
  const {completed, errors} = await runNodesParallel(client, uuid, runnable);
  for (const [key, task] of Object.entries(completed)) {
    Object.assign(stateSegments[key], task, {status: 'succeeded'}); await atomicWriteJson(statePath, state);
  }
  for (const [key, error] of Object.entries(errors)) stateSegments[key].error = error;
  await atomicWriteJson(statePath, state);
  if (Object.keys(errors).length) throw new LibTVBatchError(Object.entries(errors).sort(([a],[b]) => Number(a) - Number(b))
    .map(([key, message]) => `Segment ${key}任务状态不确定：${message}`).join('；') + '。已保存节点和状态，禁止自动重提。');
  const outputDir = join(root, 'segments');
  for (const key of Object.keys(stateSegments).sort((a, b) => Number(a) - Number(b))) {
    const record = stateSegments[key];
    if (!await nonempty(record.localFile ?? '')) record.localFile = await client.download(uuid, String(record.videoNodeKey), outputDir, vipDownload);
    await setVideo(manifestPath, Number(key), 'success', {candidateId: 'candidate-01', taskId: String(record.taskId ?? ''),
      provider: 'libtv_cli', output_file: record.localFile, media: {url: record.remoteUrl ?? ''}, model, resolution});
    await atomicWriteJson(statePath, state);
  }
  state.status = 'segments_completed'; await atomicWriteJson(statePath, state);
  const latest = await loadManifest(manifestPath);
  latest.videoGeneration = {status: 'segments_completed', generated: true, provider: 'libtv_cli', model};
  await saveManifest(manifestPath, latest);
  return {ok: true, status: 'segments_completed', projectUuid: uuid,
    canvasUrl: `https://www.liblib.tv/canvas?projectId=${encodeURIComponent(uuid)}`, state: statePath,
    segments: Object.keys(stateSegments).sort((a,b) => Number(a)-Number(b)).map(key => stateSegments[key])};
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2), opts = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i]; if (!key.startsWith('--')) throw Error(`无效参数：${key}`);
    if (['--generation-approved','--vip-download','--plan-only'].includes(key)) opts[key.slice(2)] = true;
    else opts[key.slice(2)] = args[++i];
  }
  runBatch({manifest: opts.manifest, workspaceId: opts['workspace-id'] ? Number(opts['workspace-id']) : null,
    projectUuid: opts['project-uuid'], projectName: opts['project-name'], libtvModel: opts['libtv-model'],
    generationApproved: Boolean(opts['generation-approved']), vipDownload: Boolean(opts['vip-download']),
    planOnly: Boolean(opts['plan-only'])})
    .then(x => console.log(JSON.stringify(x))).catch(e => {console.error(JSON.stringify({ok: false, error: e.message})); process.exitCode = 1;});
}
