#!/usr/bin/env node
/** Detect whether the bundled LuluLab video CLI is usable. */
import { readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const bundled = resolve(dirname(fileURLToPath(import.meta.url)), 'lululab_cli.mjs');

export async function resolveLululabCli() {
  const path = resolve(process.env.LULULAB_CLI?.trim() || bundled);
  if (extname(path) !== '.mjs' || !(await stat(path).catch(() => null))?.size)
    throw new Error('未发现 Node.js LuluLab CLI：scripts/lululab_cli.mjs');
  return path;
}

export async function cliAvailable() {
  try {
    const cli = await resolveLululabCli();
    const node = process.env.LULULAB_NODE?.trim() || process.execPath;
    for (const [command, required] of [['submit', ['--workflow-id', '--input']], ['fetch', ['--id']]]) {
      const run = spawnSync(node, [cli, 'task', command, '--help'], { encoding: 'utf8', timeout: 30_000 });
      const output = (run.stdout || '') + (run.stderr || '');
      if (run.status !== 0 || !required.every(flag => output.includes(flag))) return false;
    }
    return true;
  } catch { return false; }
}

export async function inspect(manifestPath) {
  const start = performance.now();
  const manifest = JSON.parse(await readFile(resolve(manifestPath), 'utf8'));
  if (String(manifest.version) !== '4') throw new Error('Unsupported manifest version');
  const model = String(manifest.userConfig?.videoModel ?? 'seedance-2-fast');
  const available = await cliAvailable();
  return { ok: true, model, priority: ['lululab_cli'], availability: { lululab_cli: available },
    selected: available ? 'lululab_cli' : null,
    executable: available ? await resolveLululabCli() : '',
    lowerPriorityChecksSkipped: true, elapsedSeconds: Math.round((performance.now() - start)) / 1000 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--manifest');
  if (process.argv.includes('--help')) console.log('usage: node scripts/video_cli_preflight.mjs --manifest <path>');
  else if (index < 0 || !process.argv[index + 1]) {
    console.error('usage: node scripts/video_cli_preflight.mjs --manifest <path>'); process.exitCode = 2;
  } else {
    try { console.log(JSON.stringify(await inspect(process.argv[index + 1]))); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
