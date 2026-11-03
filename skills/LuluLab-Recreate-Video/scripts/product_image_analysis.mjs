#!/usr/bin/env node
/** One ChatGenV2 product analysis per registered image group. */
import {createHash} from 'node:crypto';
import {readFile, writeFile, mkdir, rename, stat} from 'node:fs/promises';
import {dirname, extname, join, resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {loadManifest, update} from './generation_manifest.mjs';
import {client, pollTask, TaskFailedError} from './local_video_cli_lululab.mjs';
import {buildChatgenInput, extractText} from './chatgen_prompt.mjs';
import {buildFastProductBrief, validateFastProductBrief} from '../core/product_builder.mjs';

const expand = p => resolve(String(p).replace(/^~(?=\/|$)/, homedir()));
const hash = value => createHash('sha256').update(value).digest('hex');
const mime = {'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.avif': 'image/avif'};
async function save(path, value) {
  await mkdir(dirname(path), {recursive: true});
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2) + '\n');
  await rename(`${path}.tmp`, path);
}
export function parseAnalysis(text) {
  let source = String(text).trim();
  if (source.startsWith('```')) source = source.split('\n').slice(1, -1).join('\n').trim();
  const data = JSON.parse(source);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('产品分析必须返回JSON对象');
  for (const key of ['productName', 'productType', 'usageMethod'])
    if (typeof (data[key] ?? '') !== 'string') throw Error('产品分析字段类型错误：' + key);
  const features = data.lockedFeatures ?? [];
  if (!Array.isArray(features) || features.length > 6 || features.some(x => typeof x !== 'string'))
    throw Error('lockedFeatures必须为最多6个字符串');
  return data;
}
export async function imageSources(manifest) {
  const sources = [], seen = new Set();
  for (const item of manifest.product?.productImages ?? []) {
    let source;
    if (item && typeof item === 'object' && item.url) {
      if (!/^https?:\/\//.test(item.url)) throw Error('商品图片URL无效');
      source = {url: item.url, mimeType: item.mimeType || 'image/png'};
    } else {
      const value = typeof item === 'string' ? item : item?.file || item?.filePath;
      if (!value) throw Error('产品图需要url或本地file');
      const path = expand(value), info = await stat(path).catch(() => null);
      if (!info?.isFile()) throw Error('产品图不存在：' + path);
      if (!mime[extname(path).toLowerCase()]) throw Error('不支持的图片格式');
      source = path;
    }
    const key = JSON.stringify(source);
    if (!seen.has(key)) {seen.add(key); sources.push(source);}
  }
  return sources;
}
export async function analyze(manifestPath, {resume = false, retryFailed = false,
  intervalMs = 5000, timeoutMs = 600000, api = null} = {}) {
  if (resume && retryFailed) throw Error('--resume 与 --retry-failed 不能同时使用');
  const path = expand(manifestPath), manifest = await loadManifest(path);
  const existingBrief = manifest.product?.brief;
  if (existingBrief && !retryFailed) return {ok: true, skipped: true,
    reason: '已提供或已完成商品信息，无需再次识图', productBrief: existingBrief};
  const sources = await imageSources(manifest);
  if (!sources.length) return {ok: true, skipped: true, reason: '没有已登记产品图'};
  const hashes = [];
  for (const source of sources) hashes.push(hash(typeof source === 'string' ? await readFile(source) :
    JSON.stringify(Object.fromEntries(Object.entries(source).sort(([a], [b]) => a.localeCompare(b))))));
  const fingerprint = hash(JSON.stringify(hashes));
  const root = join(dirname(path), 'analysis', 'product-chatgen-v2'), receipt = join(root, 'receipt.json');
  let previous = await readFile(receipt, 'utf8').then(JSON.parse, error => {
    if (error.code === 'ENOENT') return null; throw error;
  });
  const priorFailedTaskIds = [...(previous?.priorFailedTaskIds ?? [])];
  const saveReceipt = (status, taskId) => save(receipt, {status, workflowId: 'ChatGenV2', taskId,
    imageFingerprint: fingerprint, priorFailedTaskIds});
  let taskId = previous?.taskId ?? null;
  if (previous) {
    if (previous.imageFingerprint !== fingerprint) throw Error('产品图发生变化，请使用新的任务，避免混淆已扣费任务');
    if (previous.status === 'completed') {
      if (retryFailed) throw Error('只有明确失败的任务才能使用 --retry-failed');
      return {ok: true, cached: true, productBrief: JSON.parse(await readFile(join(root, 'product-brief.json'), 'utf8'))};
    }
    if (!taskId) throw Error('产品分析提交状态不明确，禁止自动重提');
    if (retryFailed) {
      if (previous.status !== 'failed') throw Error('只有明确失败的任务才能使用 --retry-failed');
      priorFailedTaskIds.push(taskId); taskId = null;
    } else if (!resume) throw Error('已存在ChatGenV2任务，使用 --resume 查询');
  } else {
    if (resume) throw Error('没有可恢复的产品图分析任务');
    if (retryFailed) throw Error('没有明确失败的产品图分析任务可重试');
  }
  const c = api || await client();
  if (taskId === null) {
    const images = [];
    for (const source of sources) {
      if (typeof source !== 'string') {images.push(source); continue;}
      images.push({...await c.upload(source), mimeType: mime[extname(source).toLowerCase()]});
    }
    const instruction = '你是电商复刻视频商品图片分析器。分析这些图片是否为同一个商品，并仅提取可以可靠观察到的商品信息。' +
      '严格只返回JSON对象，字段为 productName(string),productType(string),usageMethod(string),' +
      'lockedFeatures(string[]，3到6项或信息不足时更少),isSameProduct(boolean)。' +
      '无法确认的字段用空字符串。不能编造使用功效、卖点、价格、医学或认证信息；' +
      '禁止推断不可见包装细节。多个不同商品时isSameProduct=false。';
    const input = buildChatgenInput(instruction, images);
    await save(join(root, 'request.json'), input);
    await saveReceipt('submission_unknown', null);
    taskId = (await c.submit('ChatGenV2', input)).id;
    await saveReceipt('submitted', taskId);
  }
  let result;
  try {result = await pollTask(id => c.task(id), taskId, {intervalMs, timeoutMs});}
  catch (error) {
    if (error instanceof TaskFailedError) {
      await saveReceipt('failed', taskId);
      throw Error('产品图识别远端失败；需人工决定是否重新付费');
    }
    throw error;
  }
  let brief;
  try {
    const data = parseAnalysis(extractText(result));
    if (data.isSameProduct === false) throw Error('多张图片疑似不同商品，需用户确认后再继续');
    let userClaims = manifest.product?.userSellingPoints ?? [];
    if (typeof userClaims === 'string') userClaims = [userClaims];
    if (!Array.isArray(userClaims) || userClaims.some(x => typeof x !== 'string')) throw Error('用户卖点格式错误');
    brief = buildFastProductBrief({productName: data.productName || '', productType: data.productType || '',
      usage: data.usageMethod || '', lockedFeatures: data.lockedFeatures || [], userClaims,
      otherRequirements: manifest.product?.otherRequirements || '无'});
    const [valid, errors] = validateFastProductBrief(brief);
    if (!valid) throw Error(errors.join('; '));
  } catch (error) {await saveReceipt('invalid_output', taskId); throw error;}
  await save(join(root, 'product-brief.json'), brief);
  await update(path, current => {
    const product = current.product ??= {};
    product.brief = brief; product.briefSource = 'ChatGenV2';
    product.analysisTaskId = taskId; product.analysisImageFingerprint = fingerprint;
  });
  await saveReceipt('completed', taskId);
  return {ok: true, taskId, productBrief: brief};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), opt = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
    const manifest = opt('--manifest'); if (!manifest) throw Error('需要 --manifest');
    console.log(JSON.stringify(await analyze(manifest, {resume: args.includes('--resume'),
      retryFailed: args.includes('--retry-failed'), intervalMs: Number(opt('--poll-interval') || 5) * 1000,
      timeoutMs: Number(opt('--poll-timeout') || 600) * 1000})));
  } catch (error) {console.error(error.message); process.exitCode = 1;}
}
