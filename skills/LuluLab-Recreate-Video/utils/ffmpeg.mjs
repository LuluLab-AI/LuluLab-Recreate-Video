/** Cross-platform FFmpeg discovery without hard-coded paths. */
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, resolve } from 'node:path';

export async function findOnPath(names, env = process.env) {
  if (!Array.isArray(names)) names = [names];
  for (const name of names) for (const directory of (env.PATH ?? '').split(delimiter)) {
    const candidate = resolve(directory || '.', name);
    try { await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return candidate; }
    catch { /* try the next PATH entry */ }
  }
  return null;
}

export async function findFfmpeg(env = process.env) {
  return findOnPath(process.platform === 'win32' ? ['ffmpeg.exe', 'ffmpeg'] : ['ffmpeg', 'ffmpeg.exe'], env);
}

export async function requireFfmpeg(env = process.env) {
  const executable = await findFfmpeg(env);
  if (!executable) throw new Error('FFmpeg was not found on PATH. Install FFmpeg and try again.');
  return executable;
}
