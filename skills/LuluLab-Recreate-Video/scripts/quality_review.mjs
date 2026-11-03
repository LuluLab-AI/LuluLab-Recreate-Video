/** Non-blocking quality reports for generated videos. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyze, probe } from './benchmark_analysis.mjs';

export const WEIGHTS = { firstFrameHook: 15, shotOrderCuts: 20,
  productIdentityGeometryInteraction: 25, keyStatesRewardDensity: 20,
  motionContinuity: 10, audioVoiceRhythm: 10 };
const expand = value => path.resolve(String(value).replace(/^~(?=\/|$)/, os.homedir()));
export function resolve(name, value = null) {
  const local = path.join(os.homedir(), '.local', 'bin', name);
  const found = (process.env.PATH || '').split(path.delimiter).map(dir => path.resolve(dir || '.', name))
    .find(candidate => { try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; } });
  const candidates = [value, fs.existsSync(local) && fs.statSync(local).isFile() ? local : null, found];
  for (const candidate of new Set(candidates.filter(Boolean))) {
    if (name === 'ffmpeg') {
      const result = spawnSync(candidate, ['-hide_banner', '-filters'], { encoding: 'utf8' });
      if (result.status || !(result.stdout || '').split('\n').some(line => line.trim().split(/\s+/)[1] === 'drawtext')) continue;
    }
    return candidate;
  }
  throw new Error(`当前环境缺少 ${name}${name === 'ffmpeg' ? '（需要 drawtext 滤镜）' : ''}。`);
}
export function resolveOptional(name, value = null) { try { return resolve(name, value); } catch { return null; } }
export function run(command) {
  const result = spawnSync(command[0], command.slice(1), { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status) throw new Error(result.stderr?.slice(-2000) || '视频质量分析失败。');
}
export function comparisonSheet(ffmpeg, benchmark, candidate, duration, output) {
  const timestamps = [0, .1, .2, .3, .4, .5, .6, .7, .8, .95].map(value => Math.round(duration * value * 1000) / 1000);
  const command = [ffmpeg, '-y'];
  for (const timestamp of timestamps) command.push('-ss', String(timestamp), '-i', String(benchmark), '-ss', String(timestamp), '-i', String(candidate));
  const filters = [], pairs = [];
  for (const [index, timestamp] of timestamps.entries()) {
    const left = `o${index}`, right = `n${index}`, pair = `p${index}`, label = `${timestamp.toFixed(2)}s`;
    filters.push(`[${index * 2}:v]scale=240:426:force_original_aspect_ratio=decrease,pad=240:426:(ow-iw)/2:(oh-ih)/2:black,drawtext=text='原片 ${label}':x=8:y=8:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.6[${left}]`);
    filters.push(`[${index * 2 + 1}:v]scale=240:426:force_original_aspect_ratio=decrease,pad=240:426:(ow-iw)/2:(oh-ih)/2:black,drawtext=text='复刻 ${label}':x=8:y=8:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.6[${right}]`);
    filters.push(`[${left}][${right}]hstack=inputs=2[${pair}]`);
    pairs.push(`[${pair}]`);
  }
  filters.push(`${pairs.join('')}xstack=inputs=10:layout=0_0|480_0|0_426|480_426|0_852|480_852|0_1278|480_1278|0_1704|480_1704[out]`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  command.push('-filter_complex', filters.join(';'), '-map', '[out]', '-frames:v', '1', String(output));
  run(command);
}

export async function buildReview(ffmpeg, ffprobe, benchmark, candidate, outputDir,
  { targetDuration = null, profile = 'fast' } = {}) {
  profile = String(profile || 'fast').trim().toLowerCase();
  if (!['fast', 'full'].includes(profile)) throw new Error('quality profile 必须是 fast 或 full。');
  const original = profile === 'full' ? await analyze(ffmpeg, ffprobe, benchmark) : { media: probe(ffprobe, benchmark, ffmpeg) };
  const generated = profile === 'full' ? await analyze(ffmpeg, ffprobe, candidate) : { media: probe(ffprobe, candidate, ffmpeg) };
  const originalMedia = original.media, generatedMedia = generated.media, sourceDuration = Number(originalMedia.duration);
  const target = targetDuration === null ? sourceDuration : Number(targetDuration);
  if (target <= 0 || target > sourceDuration + .5) throw new Error('质检目标时长必须大于0且不得超过原片可用范围。');
  const duration = Math.min(target, sourceDuration, Number(generatedMedia.duration));
  const actual = Number(generatedMedia.duration), tolerance = Math.max(.25, target * .03), failures = [];
  if (Math.abs(target - actual) > tolerance) failures.push('duration_out_of_tolerance');
  if (originalMedia.width * generatedMedia.height !== originalMedia.height * generatedMedia.width) failures.push('aspect_ratio_mismatch');
  if (originalMedia.hasAudio && !generatedMedia.hasAudio) failures.push('missing_audio');
  let sheet = null, pacing;
  if (profile === 'full') {
    sheet = path.join(outputDir, 'aligned-comparison.jpg');
    comparisonSheet(ffmpeg, benchmark, candidate, duration, sheet);
    const originalCuts = (original.candidateCuts || []).filter(t => t < target);
    const generatedCuts = (generated.candidateCuts || []).filter(t => t < duration);
    const ratio = originalCuts.length ? generatedCuts.length / originalCuts.length : null;
    pacing = { status: 'reviewed', sourceCandidateCuts: originalCuts.length,
      candidateCuts: generatedCuts.length, retentionRatio: ratio,
      warnings: ratio !== null && ratio < .8 ? ['pacing_collapse_requires_review'] : [],
      meaning: '候选数量差异仅提示复核，不证明真实丢镜头' };
  } else pacing = { status: 'not_scanned_fast_profile', warnings: [],
    meaning: '默认快速质检仅检查媒体技术指标；需要镜头节奏对齐时显式运行full模式。' };
  return { status: 'reported', qualityProfile: profile, threshold: 85, benchmark: original,
    candidate: generated, targetDuration: target, replicationWindow: { start: 0, end: target },
    technical: { passed: !failures.length, failures, durationTolerance: tolerance },
    comparisonSheet: sheet, weights: WEIGHTS, scores: {}, totalScore: null,
    hardFailures: failures, passed: false, technicalPassed: !failures.length,
    semanticStatus: 'not_reviewed', pacing, deliveryBlocked: false,
    requiresVisualReview: false, mayAutoRegenerate: false };
}

export function finalize(report, assessment) {
  const scores = assessment.scores || {};
  for (const [key, maximum] of Object.entries(WEIGHTS)) {
    const value = scores[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum)
      throw new Error(`评分 ${key} 必须在 0-${maximum} 之间。`);
  }
  const hard = [...new Set([...(report.technical?.failures || []), ...(assessment.hardFailures || [])])];
  const total = Object.keys(WEIGHTS).reduce((sum, key) => sum + scores[key], 0), passed = total >= 85 && !hard.length;
  Object.assign(report, { status: passed ? 'passed' : 'failed', scores, totalScore: total,
    hardFailures: hard, passed, findings: assessment.findings || [],
    recommendedRepairLayer: assessment.recommendedRepairLayer || (passed ? 'none' : 'step4'),
    requiresUserApprovalForNewCandidate: !passed, deliveryBlocked: false,
    requiresVisualReview: false, mayAutoRegenerate: false });
  return report;
}

export async function main(argv = process.argv.slice(2)) {
  const command = argv.shift();
  if (!['analyze', 'score'].includes(command)) throw new Error('必须提供 analyze 或 score。');
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error(`未知参数：${argv[i]}`);
    options[argv[i].slice(2)] = argv[++i];
  }
  let result, output;
  if (command === 'analyze') {
    if (!options.benchmark || !options.candidate || !options['output-dir']) throw new Error('缺少 --benchmark、--candidate 或 --output-dir。');
    const outputDir = expand(options['output-dir']);
    fs.mkdirSync(outputDir, { recursive: true });
    result = await buildReview(resolve('ffmpeg', options.ffmpeg), resolveOptional('ffprobe', options.ffprobe),
      expand(options.benchmark), expand(options.candidate), outputDir,
      { targetDuration: options['target-duration'] === undefined ? null : Number(options['target-duration']),
        profile: options.profile || 'fast' });
    output = path.join(outputDir, 'quality-report.json');
  } else {
    if (!options.report || !options.assessment) throw new Error('缺少 --report 或 --assessment。');
    const source = expand(options.report);
    result = finalize(JSON.parse(fs.readFileSync(source, 'utf8')),
      JSON.parse(fs.readFileSync(expand(options.assessment), 'utf8')));
    output = options.output ? expand(options.output) : source;
  }
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, output, ...result }));
  return 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
