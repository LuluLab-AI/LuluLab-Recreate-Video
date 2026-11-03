#!/usr/bin/env node
/** Legacy installer for the retired bundled LuluLab executable. */
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {copyFile, chmod, mkdir, readFile, rename, stat, writeFile, rm} from 'node:fs/promises';
import {homedir, platform, arch, tmpdir} from 'node:os';
import {dirname, join, resolve, delimiter} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const start = '# >>> lululab managed path >>>', end = '# <<< lululab managed path <<<';
const expected = { 'Darwin:arm64': '4689fa8d5f69c2acebba8d78056692b027ce77730712709d5f9a359e2a0a2f3e',
  'Windows:amd64': '9ef8120990fff7b3fdc88c62119c385080945f834401227adcc712f176a27926',
  'Windows:x86_64': '9ef8120990fff7b3fdc88c62119c385080945f834401227adcc712f176a27926',
  'Windows:x64': '9ef8120990fff7b3fdc88c62119c385080945f834401227adcc712f176a27926'};
const osName = () => process.platform === 'darwin' ? 'Darwin' : process.platform === 'win32' ? 'Windows' : platform();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function bundledCliPath({system = osName(), machine = arch(), skillRoot = root} = {}) {
  const architecture = machine.toLowerCase(), file = system === 'Darwin' && ['arm64','aarch64'].includes(architecture) ?
    join(skillRoot, 'cli', 'macos-arm64', 'lululab') : system === 'Windows' && ['amd64','x86_64','x64'].includes(architecture) ?
      join(skillRoot, 'cli', 'windows-x64', 'lululab.exe') : null;
  if (!file) throw Error('当前平台不支持，请使用 macOS Apple Silicon 或 Windows x64。');
  const info = await stat(file).catch(() => null);
  if (!info?.isFile() || !info.size) throw Error(`技能内置 LuluLab CLI 缺失：${file}`);
  if (hash(await readFile(file)) !== expected[`${system}:${architecture}`]) throw Error(`技能内置 LuluLab CLI 校验失败：${file}`);
  return file;
}
export function defaultInstallDir({system = osName(), home = homedir(), environ = process.env} = {}) {
  if (system === 'Darwin') return resolve(home, 'Applications', 'LuluLab', 'bin');
  if (system === 'Windows') return resolve(environ.LOCALAPPDATA?.trim() || join(home, 'AppData', 'Local'), 'Programs', 'LuluLab', 'bin');
  throw Error('当前平台不支持，请使用 macOS Apple Silicon 或 Windows x64。');
}
export function replaceManagedBlock(text, block) {
  const s = text.indexOf(start), e = text.indexOf(end);
  if (s >= 0 && e >= s) return [text.slice(0, s).replace(/\n+$/, ''), block, text.slice(e + end.length).replace(/^\n+|\n+$/g, '')]
    .filter(Boolean).join('\n\n') + '\n';
  return `${text.replace(/\n+$/, '')}${text.trim() ? '\n\n' : ''}${block}\n`;
}
const shellQuote = s => /^[A-Za-z0-9_/@%+=:,.-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;
export async function persistUserPath(binDir, {system = osName(), home = homedir(), profiles = null} = {}) {
  const current = process.env.PATH?.split(delimiter).filter(Boolean) ?? [];
  if (!current.includes(binDir)) process.env.PATH = [binDir, ...current].join(delimiter);
  if (system === 'Darwin') {
    const block = `${start}\nexport PATH=${shellQuote(binDir)}:"$PATH"\n${end}`, updates = [];
    for (const profile of profiles ?? [join(home, '.zprofile'), join(home, '.bash_profile')]) {
      await mkdir(dirname(profile), {recursive: true});
      const old = await readFile(profile, 'utf8').catch(e => {if (e.code === 'ENOENT') return ''; throw e;});
      const next = replaceManagedBlock(old, block);
      if (next !== old) {await writeFile(profile, next); updates.push(profile);}
    }
    return updates;
  }
  if (system === 'Windows') {
    const command = `$old=[Environment]::GetEnvironmentVariable('Path','User'); $dir=${JSON.stringify(binDir)}; if (($old -split ';') -notcontains $dir) {[Environment]::SetEnvironmentVariable('Path',($old.TrimEnd(';')+';'+$dir),'User')}`;
    const result = spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command',command], {encoding: 'utf8'});
    if (result.error || result.status !== 0) throw Error(`无法更新 Windows 用户 PATH：${result.stderr || result.error?.message}`);
    return ['HKCU\\Environment\\Path'];
  }
  throw Error('当前平台不支持，无法配置 PATH。');
}
export function verifyVersion(executable, {timeout = 30000} = {}) {
  const version = spawnSync(executable, ['--version'], {encoding: 'utf8', timeout});
  const output = (version.stdout?.trim() || version.stderr?.trim() || '').trim();
  if (version.error || version.status !== 0 || !output) throw Error(`验收命令 lululab --version 失败：${version.error?.message ?? output}`);
  const contract = spawnSync(executable, ['task','submit','--help'], {encoding: 'utf8', timeout});
  const help = `${contract.stdout ?? ''}${contract.stderr ?? ''}`;
  if (contract.error || contract.status !== 0 || !help.includes('workflow-id') || !help.includes('--input'))
    throw Error('内置CLI不支持必需的 task submit --workflow-id --input 契约。');
  return output;
}
export async function ensureInstalled({system = osName(), machine = arch(), skillRoot = root,
  installDir = null, home = homedir(), profiles = null, persistPath = true, verify = true} = {}) {
  const source = await bundledCliPath({system, machine, skillRoot});
  const destinationDir = installDir ? resolve(installDir) : defaultInstallDir({system, home});
  const target = join(destinationDir, system === 'Windows' ? 'lululab.exe' : 'lululab');
  await mkdir(destinationDir, {recursive: true});
  if (hash(await readFile(target).catch(() => Buffer.alloc(0))) !== hash(await readFile(source))) {
    const temporary = join(destinationDir, `.lululab-install-${process.pid}-${Date.now()}`);
    try {await copyFile(source, temporary); if (system !== 'Windows') await chmod(temporary, 0o755); await rename(temporary, target);}
    finally {await rm(temporary, {force: true});}
  } else if (system !== 'Windows') await chmod(target, 0o755);
  const pathUpdates = persistPath ? await persistUserPath(destinationDir, {system, home, profiles}) : [];
  if (!persistPath && !(process.env.PATH ?? '').split(delimiter).includes(destinationDir))
    process.env.PATH = [destinationDir, process.env.PATH ?? ''].filter(Boolean).join(delimiter);
  return {installedPath: target, pathUpdates, acceptanceCommand: 'lululab --version', version: verify ? verifyVersion(target) : ''};
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const index = process.argv.indexOf('--install-dir'), installDir = index >= 0 ? process.argv[index + 1] : null;
  ensureInstalled({installDir}).then(x => console.log(JSON.stringify(x))).catch(e => {console.error(e.message); process.exitCode = 1;});
}
