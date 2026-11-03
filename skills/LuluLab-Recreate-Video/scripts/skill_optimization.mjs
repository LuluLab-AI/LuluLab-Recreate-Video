#!/usr/bin/env node
/** Transactional snapshot and rollback for approved Skill optimizations. */
import {copyFile, mkdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {SKILL_ROOT, fileSha256, loadManifest, saveManifest, skillFileFingerprints, optimizationRelativePath, now} from './generation_manifest.mjs';

const expand = p => resolve(String(p).replace(/^~(?=\/|$)/, homedir()));
const same = (a, b) => Object.keys(a).length === Object.keys(b).length &&
  Object.keys(a).every(key => b[key] === a[key]);
async function matchingRecord(manifest, candidateId, proposal) {
  const manifestPath = expand(manifest), proposalPath = expand(proposal), digest = await fileSha256(proposalPath);
  const data = await loadManifest(manifestPath);
  const record = (data.skillOptimizations ?? []).findLast(item => item.candidateId === candidateId && item.proposalSha256 === digest);
  if (!record || record.status !== 'proposed') throw Error('没有可应用的匹配技能优化方案，或方案已失效。');
  return {data, record, manifestPath, digest};
}
async function currentFingerprints(record) {
  return skillFileFingerprints(Object.keys(record.sourceFileFingerprints ?? {}));
}
export async function snapshot(manifest, candidateId, proposal) {
  const {data, record, manifestPath, digest} = await matchingRecord(manifest, candidateId, proposal);
  const expected = record.sourceFileFingerprints ?? {};
  if (!same(await currentFingerprints(record), expected)) {
    record.status = 'stale'; record.resultAt = now(); await saveManifest(manifestPath, data);
    throw Error('目标技能文件已变化，旧的优化确认失效；方案已标记 stale。');
  }
  const root = join(dirname(manifestPath), 'review', 'skill-optimization', String(record.proposalId));
  const backup = join(root, 'backup'); await mkdir(backup, {recursive: true});
  const missing = [];
  for (const [relative, digestValue] of Object.entries(expected)) {
    const name = optimizationRelativePath(relative);
    if (digestValue === 'missing') {missing.push(name); continue;}
    const destination = join(backup, name);
    await mkdir(dirname(destination), {recursive: true}); await copyFile(join(SKILL_ROOT, name), destination);
  }
  const transaction = join(root, 'transaction.json');
  await writeFile(transaction, JSON.stringify({proposalSha256: digest, candidateId, skillRoot: SKILL_ROOT,
    sourceFileFingerprints: expected, missingFiles: missing, backupRoot: backup}, null, 2) + '\n');
  record.transactionFile = transaction; record.snapshotAt = now(); await saveManifest(manifestPath, data);
  return transaction;
}
export async function rollback(manifest, candidateId, proposal) {
  const {data, record, manifestPath} = await matchingRecord(manifest, candidateId, proposal);
  if (!record.transactionFile) throw Error('技能优化方案没有事务快照。');
  const transaction = expand(record.transactionFile), details = JSON.parse(await readFile(transaction, 'utf8'));
  const expected = details.sourceFileFingerprints, backup = expand(details.backupRoot), missing = new Set(details.missingFiles ?? []);
  for (const [relative, digestValue] of Object.entries(expected)) {
    const name = optimizationRelativePath(relative), target = join(SKILL_ROOT, name);
    if (missing.has(name) || digestValue === 'missing') {
      const info = await stat(target).catch(() => null);
      if (info && !info.isFile()) throw Error(`无法安全回滚非文件路径：${target}`);
      if (info) await rm(target);
      continue;
    }
    const source = join(backup, name), info = await stat(source).catch(() => null);
    if (!info?.isFile() || await fileSha256(source) !== digestValue) throw Error(`技能优化备份缺失或摘要错误：${name}`);
    await mkdir(dirname(target), {recursive: true}); await copyFile(source, target);
  }
  const restored = await skillFileFingerprints(Object.keys(expected));
  if (!same(restored, expected)) throw Error('技能优化自动回滚后文件摘要仍不一致。');
  record.rollbackVerifiedAt = now(); await saveManifest(manifestPath, data);
  return transaction;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [command, ...args] = process.argv.slice(2), opts = {};
  for (let i = 0; i < args.length; i += 2) opts[args[i]?.replace(/^--/, '')] = args[i + 1];
  try {
    if (!opts.manifest || !opts['candidate-id'] || !opts.proposal) throw Error('--manifest、--candidate-id、--proposal 必填');
    const transaction = command === 'snapshot' ? await snapshot(opts.manifest, opts['candidate-id'], opts.proposal) :
      command === 'rollback' ? await rollback(opts.manifest, opts['candidate-id'], opts.proposal) : (() => {throw Error('命令必须是 snapshot 或 rollback');})();
    console.log(JSON.stringify({ok: true, transaction}));
  } catch (error) {console.error(error.message); process.exitCode = 1;}
}
