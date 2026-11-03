#!/usr/bin/env node
/** Export one copy-ready UTF-8 text file per registered video prompt. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const expand = path => path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
async function loadJson(path) {
  const data = JSON.parse(await readFile(path, 'utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new Error(`JSON根节点必须是对象：${path}`);
  return data;
}

export async function registeredSegments(manifest, manifestPath) {
  const videoPrompts = manifest.videoPrompts;
  if (!videoPrompts || typeof videoPrompts !== 'object' || Array.isArray(videoPrompts))
    throw new Error('manifest.videoPrompts必须是对象。');
  let segments = videoPrompts.segments;
  if (!segments?.length) {
    const promptFile = videoPrompts.file;
    if (typeof promptFile !== 'string' || !promptFile.trim())
      throw new Error('manifest尚未登记Video Prompt。');
    const source = await loadJson(resolve(dirname(manifestPath), expand(promptFile)));
    const wrapped = source.videoPrompts ?? source;
    if (!wrapped || typeof wrapped !== 'object' || Array.isArray(wrapped))
      throw new Error('Prompt文件中的videoPrompts必须是对象。');
    segments = wrapped.segments;
  }
  if (!Array.isArray(segments) || !segments.length)
    throw new Error('videoPrompts.segments必须是非空数组。');
  segments.forEach((segment, index) => {
    if (!segment || typeof segment !== 'object' || Array.isArray(segment))
      throw new Error(`Segment ${index + 1}必须是对象。`);
    if (typeof segment.prompt !== 'string' || !segment.prompt)
      throw new Error(`Segment ${index + 1}缺少非空prompt。`);
  });
  return segments;
}

export async function exportPrompts(manifestPath, outputDir) {
  manifestPath = resolve(expand(manifestPath));
  const segments = await registeredSegments(await loadJson(manifestPath), manifestPath);
  const destination = resolve(expand(outputDir ?? join(dirname(manifestPath), 'prompts')));
  await mkdir(destination, { recursive: true });
  const outputs = [];
  for (const [index, segment] of segments.entries()) {
    const segmentId = segment.segmentId ?? index + 1;
    const number = Number.parseInt(String(segmentId), 10);
    const safeNumber = Number.isFinite(number) ? number : index + 1;
    const target = join(destination, `segment-${String(safeNumber).padStart(2, '0')}-prompt.txt`);
    await writeFile(target, segment.prompt, 'utf8');
    outputs.push({ segmentId, title: segment.title ?? '', duration: segment.duration ?? null,
      file: target, characters: [...segment.prompt].length });
  }
  return { ok: true, outputDir: destination, segments: outputs };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const value = flag => {
    const index = process.argv.indexOf(flag);
    return index < 0 ? null : process.argv[index + 1];
  };
  const manifest = value('--manifest');
  if (!manifest || (process.argv.includes('--output-dir') && !value('--output-dir'))) {
    console.error('usage: node scripts/export_prompt_texts.mjs --manifest <path> [--output-dir <path>]');
    process.exitCode = 2;
  } else {
    try { console.log(JSON.stringify(await exportPrompts(manifest, value('--output-dir')))); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
