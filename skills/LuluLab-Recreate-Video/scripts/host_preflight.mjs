#!/usr/bin/env node
/** Check the host capabilities required by this file-based Skill. */
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function executable(name) {
  const paths = (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':');
  const names = process.platform === 'win32' ? [name, `${name}.exe`, `${name}.cmd`] : [name];
  for (const directory of paths) for (const candidate of names) {
    const path = join(directory || '.', candidate);
    const result = spawnSync(path, ['-version'], { encoding: 'utf8', timeout: 10_000 });
    if (!result.error && result.status === 0) return path;
  }
  return null;
}

export async function inspect(skillRoot = root) {
  const checks = {
    node: Number(process.versions.node.split('.')[0]) >= 20,
    ffmpeg: Boolean(executable('ffmpeg')),
    ffprobe: Boolean(executable('ffprobe')),
    fileReadWrite: false,
    cliExecution: false,
  };
  let directory;
  try {
    directory = await mkdtemp(join(tmpdir(), 'lululab-preflight-'));
    const sample = join(directory, 'probe');
    await writeFile(sample, 'ok', 'utf8');
    checks.fileReadWrite = (await readFile(sample, 'utf8')) === 'ok';
  } catch { /* reported as a failed capability */ }
  finally { if (directory) await rm(directory, { recursive: true, force: true }); }

  if (checks.node) {
    try {
      const cli = join(skillRoot, 'scripts', 'lululab_cli.mjs');
      await access(cli, constants.R_OK);
      const run = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8', timeout: 15_000 });
      checks.cliExecution = run.status === 0;
    } catch { /* reported as a failed capability */ }
  }
  const missing = Object.keys(checks).filter(key => !checks[key]);
  return { ok: missing.length === 0, checks, missing,
    reason: missing.length ? `缺少必要宿主能力：${missing.join(', ')}` : '' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) { console.error('usage: node scripts/host_preflight.mjs'); process.exitCode = 2; }
  else {
    const result = await inspect();
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  }
}
