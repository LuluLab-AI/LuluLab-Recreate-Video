#!/usr/bin/env node
/** Validate the Skill source tree without contacting paid services. */
import { readFile, readdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const expectedName = 'LuluLab-Recreate-Video';
const repositoryUrl = 'https://github.com/lululabai/lululab-skill/tree/main/LuluLab-Recreate-Video';
const required = ['SKILL.md', 'README.md', 'README.zh-CN.md', 'LICENSE', '.gitignore', 'scripts/lululab_cli.mjs'];
const forbiddenParts = new Set(['.venv', '.pytest_cache', '__pycache__', 'jobs', 'output', 'outputs', 'dist', 'node_modules']);
const forbiddenFiles = new Set(['.env', '.DS_Store']);
const binaryExtensions = new Set(['.mp4', '.mov', '.exe', '.pth', '.pyc', '.png', '.jpg', '.jpeg', '.webp', '.mp3', '.wav']);
const secret = /-----BEGIN (?:RSA|OPENSSH|EC) PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bsk-[A-Za-z0-9_-]{20,}\b|\bAKIA[0-9A-Z]{16}\b/;
const textExtensions = new Set(['.md', '.mjs', '.js', '.json', '.yaml', '.yml', '.sh', '.ps1']);

async function* files(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.isFile()) yield path;
  }
}

export async function validate(skillRoot = root) {
  if (basename(skillRoot) !== expectedName) throw new Error('Skill directory does not match frontmatter name');
  for (const name of required) {
    if (!(await stat(join(skillRoot, name)).catch(() => null))?.isFile()) throw new Error(`missing ${name}`);
  }
  const source = await readFile(join(skillRoot, 'SKILL.md'), 'utf8');
  const match = source.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error('SKILL.md needs YAML frontmatter');
  if (!/^name:\s*LuluLab-Recreate-Video\s*$/m.test(match[1])) throw new Error('Skill name does not match root');
  if (!/^description:\s*\S/m.test(match[1])) throw new Error('missing description');
  for (const name of ['README.md', 'README.zh-CN.md']) {
    const readme = await readFile(join(skillRoot, name), 'utf8');
    if (!readme.includes(repositoryUrl) || !readme.includes('SKILL.md'))
      throw new Error(`wrong repository URL or missing Skill entry in ${name}`);
  }
  for await (const path of files(skillRoot)) {
    const name = relative(skillRoot, path);
    if (name.split(sep).some(part => forbiddenParts.has(part))) throw new Error(`runtime file: ${name}`);
    if (forbiddenFiles.has(basename(path))) throw new Error(`private file: ${name}`);
    const extension = extname(path).toLowerCase();
    if (extension === '.py' || extension === '.pyi') throw new Error(`Python source remains in JavaScript Skill: ${name}`);
    if (binaryExtensions.has(extension) && name !== join('assets', 'lululab-logo.png'))
      throw new Error(`binary/media file: ${name}`);
    if (textExtensions.has(extension)) {
      const content = await readFile(path, 'utf8');
      if (secret.test(content)) throw new Error(`suspected credential in ${name}`);
      if (content.includes('/Users/' + 'matthew/') || content.includes('C:/Users/' + 'Administrator/'))
        throw new Error(`developer path in ${name}`);
    }
    if (extension === '.mjs') {
      const check = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
      if (check.status !== 0) throw new Error(`invalid JavaScript in ${name}: ${check.stderr}`);
    }
  }
  return `validated ${expectedName}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(await validate()); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
