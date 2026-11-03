#!/usr/bin/env node
/** Resolve TikTok/Douyin pages to declared media URLs without downloading video. */
import {stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';

const TIKTOK_HOSTS = new Set(['tiktok.com', 'www.tiktok.com', 'm.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com']);
const DOUYIN_HOSTS = new Set(['douyin.com', 'www.douyin.com', 'm.douyin.com', 'v.douyin.com',
  'iesdouyin.com', 'www.iesdouyin.com']);
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const DOUYIN_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
export const HTML_LIMIT = 12 * 1024 * 1024;
export class ResolveError extends Error {}
const parsed = value => {try {return new URL(String(value).trim());} catch {return null;}};
export const isTikTokUrl = value => {
  const u = parsed(value); return !!u && ['http:', 'https:'].includes(u.protocol) &&
    (TIKTOK_HOSTS.has(u.hostname.toLowerCase()) || u.hostname.toLowerCase().endsWith('.tiktok.com'));
};
export const isDouyinUrl = value => {
  const u = parsed(value); return !!u && ['http:', 'https:'].includes(u.protocol) &&
    (DOUYIN_HOSTS.has(u.hostname.toLowerCase()) || u.hostname.toLowerCase().endsWith('.douyin.com') ||
    u.hostname.toLowerCase().endsWith('.iesdouyin.com'));
};
export const isSupportedPageUrl = value => isTikTokUrl(value) || isDouyinUrl(value);
export const isDirectVideoUrl = value => {
  const u = parsed(value); return !!u && ['http:', 'https:'].includes(u.protocol) &&
    /\.(mp4|mov|ogg)$/i.test(u.pathname);
};
export const isPublicHttpUrl = value => {
  const u = parsed(value); return !!u && ['http:', 'https:'].includes(u.protocol) && !!u.hostname;
};
function* collectHttpStrings(value) {
  if (typeof value === 'string') {if (/^https?:\/\//.test(value)) yield value;}
  else if (value && typeof value === 'object') for (const nested of Object.values(value)) yield* collectHttpStrings(nested);
}
function* walkMediaFields(value) {
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      const normalized = key.toLowerCase().replaceAll('_', '');
      if (['playaddr', 'playurl', 'playapi'].includes(normalized))
        for (const url of collectHttpStrings(nested)) yield [0, url];
      else if (['downloadaddr', 'downloadurl'].includes(normalized))
        for (const url of collectHttpStrings(nested)) yield [1, url];
      yield* walkMediaFields(nested);
    }
  }
}
function scriptPayloads(html) {
  const payloads = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = Object.fromEntries([...match[1].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)]
      .map(m => [m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? '']));
    if (['SIGI_STATE', '__UNIVERSAL_DATA_FOR_REHYDRATION__', '__NEXT_DATA__', 'RENDER_DATA'].includes(attrs.id) ||
      attrs.type === 'application/json') payloads.push(match[2].trim());
  }
  return payloads.filter(Boolean);
}
export function extractMediaCandidates(html) {
  const ranked = [];
  for (const payload of scriptPayloads(html)) {
    const variants = [payload];
    try {const decoded = decodeURIComponent(payload); if (decoded !== payload) variants.push(decoded);} catch {}
    for (const variant of variants) {
      try {ranked.push(...walkMediaFields(JSON.parse(variant))); break;} catch {}
    }
  }
  const pattern = /"(playAddr|play_addr|playApi|play_api|downloadAddr|download_addr)"\s*:\s*"((?:\\.|[^"\\])+)"/g;
  for (const match of html.matchAll(pattern)) {
    try {
      const url = JSON.parse(`"${match[2]}"`), normalized = match[1].toLowerCase().replaceAll('_', '');
      if (typeof url === 'string' && /^https?:\/\//.test(url))
        ranked.push([['playaddr', 'playapi'].includes(normalized) ? 0 : 1, url]);
    } catch {}
  }
  for (const match of html.matchAll(/"play_addr"\s*:\s*\{(.*?)\}\s*(?:,|\})/gs)) {
    const list = /"url_list"\s*:\s*(\[[^\]]*\])/.exec(match[1]);
    if (!list) continue;
    try {for (const url of JSON.parse(list[1])) if (typeof url === 'string' && /^https?:\/\//.test(url)) ranked.push([0, url]);}
    catch {}
  }
  return [...new Set(ranked.sort((a, b) => a[0] - b[0]).map(([, url]) => url))];
}
export async function fetchHtml(url, timeoutMs = 120000, fetchImpl = globalThis.fetch) {
  let response;
  try {response = await fetchImpl(url, {headers: {
    'User-Agent': isDouyinUrl(url) ? DOUYIN_USER_AGENT : USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.8'}, signal: AbortSignal.timeout(timeoutMs)});}
  catch (error) {throw new ResolveError(`could not read video page: ${error.message}`);}
  if (!response.ok) throw new ResolveError(`could not read video page: HTTP ${response.status}`);
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > HTML_LIMIT) throw new ResolveError('video page exceeded the safe response-size limit');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > HTML_LIMIT) {await response.body.cancel().catch(() => {}); throw new ResolveError('video page exceeded the safe response-size limit');}
    chunks.push(chunk);
  }
  const charset = /charset=([^;]+)/i.exec(response.headers.get('content-type') || '')?.[1] || 'utf-8';
  let html;
  try {html = new TextDecoder(charset, {fatal: false}).decode(Buffer.concat(chunks));}
  catch {html = Buffer.concat(chunks).toString('utf8');}
  return [html, response.url];
}
function pageVariants(url) {
  const variants = [url], path = parsed(url)?.pathname || '';
  const match = isTikTokUrl(url) ? /\/video\/(\d+)/.exec(path) : /\/(?:video|share\/video)\/(\d+)/.exec(path);
  if (match) variants.push(isTikTokUrl(url) ? `https://www.tiktok.com/embed/v2/${match[1]}` :
    `https://www.iesdouyin.com/share/video/${match[1]}/`);
  return variants;
}
export async function resolvePageToUrl(url, timeoutMs = 120000, fetchPage = fetchHtml) {
  const errors = [], checked = new Set(), queue = pageVariants(url);
  while (queue.length) {
    const page = queue.shift();
    if (checked.has(page)) continue;
    checked.add(page);
    try {
      const [html, finalUrl] = await fetchPage(page, timeoutMs);
      if (!isSupportedPageUrl(finalUrl)) {errors.push('page redirected to an unsupported host'); continue;}
      for (const variant of pageVariants(finalUrl)) if (!checked.has(variant) && !queue.includes(variant)) queue.push(variant);
      const candidates = extractMediaCandidates(html);
      if (candidates.length) return candidates[0];
      errors.push('page contained no media address');
    } catch (error) {if (error instanceof ResolveError) errors.push(error.message); else throw error;}
  }
  const platform = isTikTokUrl(url) ? 'TikTok' : 'Douyin';
  throw new ResolveError(`could not extract ${platform} media URL (${errors.at(-1) || `unknown ${platform} response`})`);
}
export async function resolveInput(source, {timeoutMs = 120000, fetchPage = fetchHtml} = {}) {
  const local = resolve(String(source).replace(/^~(?=\/|$)/, homedir()));
  if ((await stat(local).catch(() => null)) != null)
    throw new ResolveError('local benchmark videos are no longer uploaded; provide a public HTTP(S) URL');
  if (isPublicHttpUrl(source) && !isSupportedPageUrl(source))
    return {url: source, provider: parsed(source).hostname, resolution: 'direct-unverified'};
  if (!isSupportedPageUrl(source))
    throw new ResolveError('web-page URLs are unsupported; provide a TikTok or Douyin link, or a public HTTP(S) video URL');
  const mediaUrl = await resolvePageToUrl(source, timeoutMs, fetchPage);
  return {url: mediaUrl, provider: parsed(mediaUrl).hostname, resolution: 'page-extracted-unverified'};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), source = args.find(x => !x.startsWith('--')),
      timeout = args.includes('--timeout') ? Number(args[args.indexOf('--timeout') + 1]) * 1000 : 120000;
    if (!source) throw new ResolveError('source URL is required');
    const result = await resolveInput(source, {timeoutMs: timeout});
    console.log(args.includes('--json') ? JSON.stringify(result) : result.url);
  } catch (error) {console.error(`error: ${error.message}`); process.exitCode = 1;}
}
