#!/usr/bin/env node
/** Produce ordered prompt and reference files for manual video generation. */
import {resolve, dirname} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {loadManifest} from './generation_manifest.mjs';
import {registeredSegments, exportPrompts} from './export_prompt_texts.mjs';
import {audit} from './reference_audit.mjs';
import {prepareReferences, storyboardFiles, creatorFiles} from './run_generation.mjs';

const expand = p => resolve(String(p).replace(/^~(?=\/|$)/, homedir()));
export async function build(manifestPath, outputDir = null) {
  manifestPath = expand(manifestPath);
  const data = await loadManifest(manifestPath), segments = await registeredSegments(data, manifestPath);
  audit(data, segments);
  const exported = await exportPrompts(manifestPath, outputDir);
  const promptFiles = Object.fromEntries(exported.segments.map(item => [String(item.segmentId), resolve(item.file)]));
  const model = String(data.userConfig?.videoModel ?? 'seedance-2-fast'), root = dirname(manifestPath);
  const records = [];
  for (const segment of segments) {
    const files = await prepareReferences(data, segment, root, model);
    const boards = new Set(storyboardFiles(data, segment).map(expand));
    const creators = new Set(creatorFiles(data, segment).map(expand));
    const references = files.map(file => {
      const resolved = expand(file);
      return {role: boards.has(resolved) ? 'storyboard' : creators.has(resolved) ? 'creator' : 'product', file: resolved};
    });
    records.push({segmentId: segment.segmentId, title: segment.title ?? '', duration: segment.duration,
      promptFile: promptFiles[String(segment.segmentId)], references, orderedFiles: references.map(x => x.file)});
  }
  return {ok: true, status: 'manual_handoff_ready', model, segments: records};
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2), opts = {};
  for (let i = 0; i < args.length; i += 2) opts[args[i]?.replace(/^--/, '')] = args[i + 1];
  if (!opts.manifest) {console.error('--manifest 必填'); process.exitCode = 1;}
  else build(opts.manifest, opts['output-dir']).then(x => console.log(JSON.stringify(x))).catch(e => {console.error(e.message); process.exitCode = 1;});
}
