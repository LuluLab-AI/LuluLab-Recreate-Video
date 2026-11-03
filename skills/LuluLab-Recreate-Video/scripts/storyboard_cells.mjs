#!/usr/bin/env node
/** Split 3×3 boards and restore generated layouts using Node.js and FFmpeg. */
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir, homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {findFfmpeg, findOnPath} from '../utils/ffmpeg.mjs';
import {geometry, validateCanvasAspectRatio, validateRegions} from './storyboard_regions.mjs';

const expand = p => resolve(String(p).replace(/^~(?=\/|$)/, homedir()));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hashFile = async p => sha(await readFile(p));
const nonempty = async p => {const s = await stat(p).catch(() => null); return Boolean(s?.isFile() && s.size);};
function run(command, {bytes = false, input} = {}) {
  const r = spawnSync(command[0], command.slice(1), {encoding: bytes ? null : 'utf8', input, maxBuffer: 512 * 1024 * 1024});
  if (r.error || r.status !== 0) throw Error(String(r.error?.message ?? r.stderr ?? '画格处理失败。').slice(-2000));
  return r.stdout;
}
export function dimensions(ffprobe, image, ffmpeg) {
  if (ffprobe) {
    const [w, h] = run([ffprobe, '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', image]).trim().split('x').map(Number);
    if (w > 0 && h > 0) return [w, h];
  }
  const r = spawnSync(ffmpeg, ['-hide_banner', '-i', image], {encoding: 'utf8'});
  const m = /Video:.*?,\s*(\d{2,5})x(\d{2,5})/.exec(r.stderr ?? '');
  if (!m) throw Error('无法读取Storyboard尺寸。');
  return [Number(m[1]), Number(m[2])];
}
function grayscale(ffmpeg, image, width, height) {
  const pixels = run([ffmpeg, '-v', 'error', '-i', image, '-frames:v', '1', '-vf', 'format=gray', '-pix_fmt', 'gray', '-f', 'rawvideo', '-'], {bytes: true});
  if (pixels.length !== width * height) throw Error(`画格像素数量异常：期望${width * height}，实际${pixels.length}。`);
  return pixels;
}
function edgeScore(pixels, width, height, position, axis) {
  let sum = 0, count = 0;
  if (axis === 'x') for (let y = 0; y < height; y += Math.max(1, Math.floor(height / 512))) {
    sum += Math.abs(pixels[y * width + position] - pixels[y * width + position - 1]); count++;
  } else for (let x = 0; x < width; x += Math.max(1, Math.floor(width / 512))) {
    sum += Math.abs(pixels[position * width + x] - pixels[(position - 1) * width + x]); count++;
  }
  return sum / Math.max(1, count);
}
function detectAxis(pixels, width, height, axis) {
  const length = axis === 'x' ? width : height, step = length / 3;
  const radius = Math.max(4, Math.round(step * .12)), boundaries = [0], scores = [], expected = [0];
  for (let index = 1; index < 3; index++) {
    const ideal = Math.round(step * index); expected.push(ideal);
    let bestScore = -1, bestPosition = -1;
    for (let pos = Math.max(1, ideal - radius); pos <= Math.min(length - 1, ideal + radius); pos++) {
      const score = edgeScore(pixels, width, height, pos, axis);
      if (score > bestScore || (score === bestScore && Math.abs(pos - ideal) < Math.abs(bestPosition - ideal))) {
        bestScore = score; bestPosition = pos;
      }
    }
    boundaries.push(bestPosition); scores.push(Math.round(bestScore * 1000) / 1000);
  }
  boundaries.push(length); expected.push(length);
  const sizes = [0, 1, 2].map(i => boundaries[i + 1] - boundaries[i]);
  const valid = Math.min(...scores) >= 6 && sizes.every(size => size >= step * .62 && size <= step * 1.38) && new Set(boundaries).size === 4;
  return {boundaries, expected, scores, sizes, valid, maxDriftPx: Math.max(...[1, 2].map(i => Math.abs(boundaries[i] - expected[i])))};
}
export function detectGridBoundaries(ffmpeg, ffprobe, image) {
  const [width, height] = dimensions(ffprobe, image, ffmpeg), pixels = grayscale(ffmpeg, image, width, height);
  const columns = detectAxis(pixels, width, height, 'x'), rows = detectAxis(pixels, width, height, 'y');
  return {sourceWidth: width, sourceHeight: height, columns, rows, valid: columns.valid && rows.valid, pixels};
}
export function detectLabelStart(pixels, width, left, right, top, bottom) {
  const cellHeight = bottom - top, searchStart = top + Math.round(cellHeight * .68);
  const sampleStep = Math.max(1, Math.floor((right - left) / 256)), dark = [];
  for (let row = searchStart; row < bottom; row++) {
    let count = 0, darkCount = 0, sum = 0;
    for (let col = left; col < right; col += sampleStep) {
      const value = pixels[row * width + col]; count++; sum += value; if (value < 58) darkCount++;
    }
    dark.push(count > 0 && darkCount / count >= .72 && sum / count < 72);
  }
  const gapLimit = Math.max(3, Math.round(cellHeight * .025));
  for (let cursor = 0; cursor < dark.length;) {
    if (dark[cursor]) {cursor++; continue;}
    const start = cursor; while (cursor < dark.length && !dark[cursor]) cursor++;
    if (start > 0 && cursor < dark.length && cursor - start <= gapLimit) dark.fill(true, start, cursor);
  }
  const runs = [];
  for (let i = 0, start = -1; i <= dark.length; i++) {
    if (dark[i] && start < 0) start = i;
    if (!dark[i] && start >= 0) {runs.push([start, i]); start = -1;}
  }
  const minimum = Math.max(4, Math.round(cellHeight * .025));
  const candidate = runs.find(([start, end]) => end - start >= minimum && end >= dark.length - Math.max(3, Math.round(cellHeight * .18)));
  return candidate ? searchStart + candidate[0] : bottom;
}
export async function splitBoard(ffmpeg, ffprobe, board, outputDir) {
  const [width, height] = dimensions(ffprobe, board, ffmpeg);
  if (width % 3 || height % 3) throw Error('Storyboard 宽高必须能被 3 整除。');
  const cellWidth = width / 3, cellHeight = height / 3, cells = [];
  await mkdir(outputDir, {recursive: true});
  for (let i = 0; i < 9; i++) {
    const output = join(outputDir, `cell-${String(i + 1).padStart(2, '0')}.png`);
    run([ffmpeg, '-v', 'error', '-y', '-i', board, '-vf', `crop=${cellWidth}:${cellHeight}:${(i % 3) * cellWidth}:${Math.floor(i / 3) * cellHeight}`, '-frames:v', '1', output]);
    cells.push({index: i + 1, file: output, sha256: await hashFile(output)});
  }
  const manifest = {source: board, cellWidth, cellHeight, cells};
  await writeFile(join(outputDir, 'cells.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
export async function normalizeCell(ffmpeg, ffprobe, source, output, width, height, cropX = .5, cropY = .5) {
  if (!(width > 0 && height > 0) || cropX < 0 || cropX > 1 || cropY < 0 || cropY > 1) throw Error('目标宽高或裁剪位置无效。');
  const [sw, sh] = dimensions(ffprobe, source, ffmpeg), targetRatio = width / height;
  const cropWidth = sw / sh > targetRatio ? Math.round(sh * targetRatio) : sw;
  const cropHeight = sw / sh > targetRatio ? sh : Math.round(sw / targetRatio);
  const x = Math.round((sw - cropWidth) * cropX), y = Math.round((sh - cropHeight) * cropY);
  await mkdir(dirname(output), {recursive: true});
  run([ffmpeg, '-v', 'error', '-y', '-i', source, '-vf', `crop=${cropWidth}:${cropHeight}:${x}:${y},scale=${width}:${height}`, '-frames:v', '1', output]);
  return {output, sourceWidth: sw, sourceHeight: sh, crop: {x, y, width: cropWidth, height: cropHeight}, targetWidth: width, targetHeight: height};
}
export async function compose(ffmpeg, cellsDir, output, changed = {}) {
  const meta = JSON.parse(await readFile(join(cellsDir, 'cells.json'), 'utf8'));
  const {cellWidth: width, cellHeight: height} = meta;
  const inputs = Array.from({length: 9}, (_, i) => changed[i + 1] ?? join(cellsDir, `cell-${String(i + 1).padStart(2, '0')}.png`));
  const args = ['-v', 'error', '-y']; for (const path of inputs) args.push('-i', path);
  const filters = inputs.map((_, i) => `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black[c${i}]`);
  const labels = inputs.map((_, i) => `[c${i}]`).join('');
  const layout = Array.from({length: 9}, (_, i) => `${(i % 3) * width}_${Math.floor(i / 3) * height}`).join('|');
  filters.push(`${labels}xstack=inputs=9:layout=${layout}[out]`);
  await mkdir(dirname(output), {recursive: true});
  run([ffmpeg, ...args, '-filter_complex', filters.join(';'), '-map', '[out]', '-frames:v', '1', output]);
  return {output, changedCells: Object.keys(changed).map(Number).sort((a, b) => a - b), unchangedCells: Array.from({length: 9}, (_, i) => i + 1).filter(i => !(i in changed))};
}
async function adaptiveCells(ffmpeg, ffprobe, edited, originalCells, root, detection, indexes, cw, ch, labelHeight) {
  await mkdir(root, {recursive: true});
  const changes = {}, aiLabelPixelsRemoved = {}, detectedCellCrops = {};
  const columns = detection.columns.boundaries, rows = detection.rows.boundaries;
  for (const index of indexes) {
    const row = Math.floor((index - 1) / 3), col = (index - 1) % 3;
    let left = columns[col] + (col > 0 ? 1 : 0), right = columns[col + 1] - 1;
    let top = rows[row] + (row > 0 ? 1 : 0), bottom = rows[row + 1] - 1;
    if (right - left < 8 || bottom - top < 8) throw Error(`Storyboard第${String(index).padStart(2, '0')}格检测区域过小。`);
    let contentBottom = detectLabelStart(detection.pixels, detection.sourceWidth, left, right, top, bottom);
    if (contentBottom - top < Math.round((bottom - top) * .55)) contentBottom = bottom;
    aiLabelPixelsRemoved[index] = Math.max(0, bottom - contentBottom);
    detectedCellCrops[index] = {x: left, y: top, width: right - left, height: contentBottom - top};
    const raw = join(root, `cell-${String(index).padStart(2, '0')}-raw.png`), visual = join(root, `cell-${String(index).padStart(2, '0')}-visual.png`);
    const final = join(root, `cell-${String(index).padStart(2, '0')}.png`);
    run([ffmpeg, '-v', 'error', '-y', '-i', edited, '-vf', `crop=${right - left}:${contentBottom - top}:${left}:${top}`, '-frames:v', '1', raw]);
    await normalizeCell(ffmpeg, ffprobe, raw, visual, cw, ch - labelHeight);
    const originalCell = join(originalCells, `cell-${String(index).padStart(2, '0')}.png`);
    run([ffmpeg, '-v', 'error', '-y', '-i', visual, '-i', originalCell, '-filter_complex', `[1:v]crop=${cw}:${labelHeight}:0:${ch - labelHeight}[label];[0:v][label]vstack=inputs=2[out]`, '-map', '[out]', '-frames:v', '1', final]);
    changes[index] = final;
  }
  return {changes, aiLabelPixelsRemoved, detectedCellCrops};
}
export async function restoreBoardLayout(ffmpeg, ffprobe, source, original, output, labelHeight = 38) {
  const [width, height] = dimensions(ffprobe, original, ffmpeg), [sw, sh] = dimensions(ffprobe, source, ffmpeg);
  if (width % 3 || height % 3) throw Error('原Storyboard宽高必须能被3整除。');
  const cw = width / 3, ch = height / 3;
  if (!Number.isInteger(labelHeight) || labelHeight < 1 || labelHeight >= ch) throw Error('label-height必须小于单格高度。');
  const detection = detectGridBoundaries(ffmpeg, ffprobe, source);
  await mkdir(dirname(output), {recursive: true});
  if (detection.valid) {
    const root = await mkdtemp(join(tmpdir(), 'storyboard-layout-restore-'));
    try {
      const originals = join(root, 'original-cells'); await splitBoard(ffmpeg, ffprobe, original, originals);
      const adaptive = await adaptiveCells(ffmpeg, ffprobe, source, originals, join(root, 'restored-cells'), detection, [1,2,3,4,5,6,7,8,9], cw, ch, labelHeight);
      await compose(ffmpeg, originals, output, adaptive.changes);
      return {output, width, height, labelHeight, layoutRestoredFrom: original, alignmentMode: 'detected-grid-per-cell',
        detectedGrid: {valid: true, columns: detection.columns, rows: detection.rows},
        aiLabelPixelsRemoved: adaptive.aiLabelPixelsRemoved, detectedCellCrops: adaptive.detectedCellCrops};
    } finally {await rm(root, {recursive: true, force: true});}
  }
  const ratio = width / height, cropWidth = sw / sh > ratio ? Math.round(sh * ratio) : sw;
  const cropHeight = sw / sh > ratio ? sh : Math.round(sw / ratio);
  const x = Math.round((sw - cropWidth) / 2), y = Math.round((sh - cropHeight) / 2);
  const filters = [`[0:v]crop=${cropWidth}:${cropHeight}:${x}:${y},scale=${width}:${height}[base]`];
  let previous = 'base';
  for (let i = 0; i < 9; i++) {
    const lx = (i % 3) * cw, ly = Math.floor(i / 3) * ch + ch - labelHeight;
    filters.push(`[1:v]crop=${cw}:${labelHeight}:${lx}:${ly}[label${i}]`);
    filters.push(`[${previous}][label${i}]overlay=${lx}:${ly}[stage${i}]`); previous = `stage${i}`;
  }
  filters.push(`[${previous}]drawgrid=w=${cw}:h=${ch}:t=1:c=white@0.55[out]`);
  run([ffmpeg, '-v', 'error', '-y', '-i', source, '-i', original, '-filter_complex', filters.join(';'), '-map', '[out]', '-frames:v', '1', output]);
  return {output, width, height, labelHeight, layoutRestoredFrom: original, alignmentMode: 'whole-board-fallback', detectedGrid: {valid: false}};
}
export async function fastPrepare(ffmpeg, ffprobe, original, edited, output, labelHeight = 38) {
  for (const [role, path] of [['原Storyboard', original], ['候选Storyboard', edited]])
    if (!await nonempty(path)) throw Error(`${role}不存在或为空：${path}`);
  if (await stat(output).catch(() => null)) throw Error(`输出已存在，请使用新文件名：${output}`);
  const [width, height] = dimensions(ffprobe, original, ffmpeg), [ew, eh] = dimensions(ffprobe, edited, ffmpeg);
  if (width % 3 || height % 3) throw Error('原Storyboard宽高必须能被3整除。');
  const canvas = geometry(width, height), drift = validateCanvasAspectRatio(ew, eh, canvas.width, canvas.height);
  const detection = detectGridBoundaries(ffmpeg, ffprobe, edited);
  if (!detection.valid) throw Error('候选Storyboard无法可靠识别3×3网格。');
  const layout = await restoreBoardLayout(ffmpeg, ffprobe, edited, original, output, labelHeight);
  const [fw, fh] = dimensions(ffprobe, output, ffmpeg);
  if (fw !== width || fh !== height) throw Error('快速Storyboard输出尺寸与原板不一致。');
  const metadata = {method: 'whole-board-fast-v1', validationLevel: 'mechanical', visualReviewRequired: false,
    layoutRestored: true, labelsRestored: true, canvasAspectRatioDrift: Math.round(drift * 1e6) / 1e6,
    maxCanvasAspectRatioDrift: .15, originalFile: resolve(original), editedImageFile: resolve(edited), finalImageFile: resolve(output),
    originalSha256: await hashFile(original), editedSha256: await hashFile(edited), finalSha256: await hashFile(output),
    width: fw, height: fh, detectedGrid: {valid: detection.valid, columns: detection.columns, rows: detection.rows}, layoutRestore: layout};
  const metadataPath = output.replace(/\.[^.\/]+$/, '') + '.fast.json';
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + '\n');
  return {...metadata, metadata: resolve(metadataPath)};
}
export function normalizeReplacementMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Replacement Map 必须是JSON对象。');
  if (!Array.isArray(value.cells) || value.cells.length !== 9) throw Error('Replacement Map 必须且只能包含9格。');
  const replaceProduct = Boolean(value.replaceProduct), replaceCreator = Boolean(value.replaceCreator);
  const groups = {productFullCells: [], productPartialCells: [], creatorFullCells: [], creatorPartialCells: [],
    editableCells: [], frozenCells: []}, seen = new Set(), cells = [];
  for (const raw of value.cells) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Replacement Map cells 每项必须是对象。');
    const index = Number(raw.index);
    if (!Number.isInteger(index) || index < 1 || index > 9 || seen.has(index)) throw Error('Replacement Map 格号必须是唯一的1-9。');
    seen.add(index);
    const cell = {index, interactionState: String(raw.interactionState ?? '')};
    if (raw.regions !== undefined) cell.regions = raw.regions;
    let editable = false;
    for (const [kind, enabled, full, partial] of [
      ['product', replaceProduct, 'productFullCells', 'productPartialCells'],
      ['creator', replaceCreator, 'creatorFullCells', 'creatorPartialCells']]) {
      const source = raw[kind] ?? {};
      if (!source || typeof source !== 'object' || Array.isArray(source)) throw Error(`Replacement Map cell ${index} ${kind} 必须是对象。`);
      const state = String(source.state ?? 'none'), count = source.count ?? 0, replace = Boolean(source.replace);
      if (!['none','partial','full'].includes(state)) throw Error(`Replacement Map cell ${index} ${kind}.state 无效。`);
      if (!Number.isInteger(count) || count < 0) throw Error(`Replacement Map cell ${index} ${kind}.count 必须是非负整数。`);
      if (state === 'none' && (count !== 0 || replace)) throw Error(`Replacement Map cell ${index} ${kind}=none 时 count=0 且 replace=false。`);
      if (state !== 'none' && count < 1) throw Error(`Replacement Map cell ${index} ${kind}存在时 count 必须大于0。`);
      if (replace && !enabled) throw Error(`Replacement Map cell ${index} 要求替换${kind}，但Segment未开启该替换。`);
      cell[kind] = {state, count, replace};
      if (replace) {editable = true; groups[state === 'partial' ? partial : full].push(index);}
    }
    groups[editable ? 'editableCells' : 'frozenCells'].push(index); cells.push(cell);
  }
  cells.sort((a, b) => a.index - b.index);
  if (seen.size !== 9) throw Error('Replacement Map 必须正好覆盖格号01-9。');
  const result = {segmentId: Number(value.segmentId ?? 0), replaceProduct, replaceCreator, cells, ...groups};
  if (value.mergeMode != null) {
    if (value.mergeMode === 'whole-board-direct-v1') {
      if (typeof value.editRule !== 'string' || !value.editRule.trim()) throw Error('完整板编辑必须提供明确的editRule。');
      Object.assign(result, {mergeMode: value.mergeMode, compositionMode: 'whole-board-direct-v1',
        labelHeight: Number(value.labelHeight ?? 38), editRule: value.editRule});
      return result;
    }
    if (value.mergeMode !== 'object-regions-v1') throw Error('未知mergeMode。');
    for (const key of ['mergeMode','coordinateSpace','labelHeight','editRule','compositionMode'])
      if (key in value) result[key] = value[key];
    validateRegions(result);
  }
  return result;
}
export async function lockMerge(ffmpeg, ffprobe, original, edited, planPath, output, labelHeight = 38) {
  for (const [role, path] of [['原Storyboard', original], ['编辑后Storyboard', edited], ['Replacement Map', planPath]])
    if (!await nonempty(path)) throw Error(`${role}不存在或为空：${path}`);
  const plan = normalizeReplacementMap(JSON.parse(await readFile(planPath, 'utf8')));
  if (plan.mergeMode === 'object-regions-v1') {
    const {merge} = await import('./storyboard_regions.mjs');
    return merge(ffmpeg, ffprobe, original, edited, planPath, output);
  }
  const [width, height] = dimensions(ffprobe, original, ffmpeg), [ew, eh] = dimensions(ffprobe, edited, ffmpeg);
  if (width % 3 || height % 3) throw Error('原Storyboard宽高必须能被3整除。');
  const detection = detectGridBoundaries(ffmpeg, ffprobe, edited);
  const gridDrift = ew !== width || eh !== height || detection.columns.maxDriftPx > 2 || detection.rows.maxDriftPx > 2;
  if (gridDrift && !detection.valid) throw Error('AI返回Storyboard尺寸或网格已漂移，且无法可靠识别3×3边界；已停止lock-merge。');
  const root = await mkdtemp(join(tmpdir(), 'storyboard-lock-merge-'));
  let adaptive = {}, alignmentMode = gridDrift ? 'adaptive-grid' : 'uniform-grid-fast-path';
  try {
    const originals = join(root, 'original-cells'); await splitBoard(ffmpeg, ffprobe, original, originals);
    let changes;
    if (gridDrift) {
      const result = await adaptiveCells(ffmpeg, ffprobe, edited, originals, join(root, 'adaptive-cells'), detection,
        plan.editableCells, width / 3, height / 3, labelHeight);
      changes = result.changes;
      adaptive = {aiLabelPixelsRemoved: result.aiLabelPixelsRemoved, detectedCellCrops: result.detectedCellCrops};
    } else {
      const editedCells = join(root, 'edited-cells'); await splitBoard(ffmpeg, ffprobe, edited, editedCells);
      changes = Object.fromEntries(plan.editableCells.map(i => [i, join(editedCells, `cell-${String(i).padStart(2, '0')}.png`)]));
    }
    const selected = join(root, 'selected.png'); await compose(ffmpeg, originals, selected, changes);
    const restored = join(root, 'layout-restored.png');
    await restoreBoardLayout(ffmpeg, ffprobe, selected, original, restored, labelHeight);
    const restoredCells = join(root, 'restored-cells'); await splitBoard(ffmpeg, ffprobe, restored, restoredCells);
    const finalChanges = Object.fromEntries(plan.editableCells.map(i => [i, join(restoredCells, `cell-${String(i).padStart(2, '0')}.png`)]));
    await compose(ffmpeg, originals, output, finalChanges);
  } finally {await rm(root, {recursive: true, force: true});}
  const [fw, fh] = dimensions(ffprobe, output, ffmpeg);
  if (fw !== width || fh !== height) throw Error('lock-merge输出尺寸与原Storyboard不一致。');
  const direct = plan.mergeMode === 'whole-board-direct-v1';
  const metadataPath = output.replace(/\.[^.\/]+$/, '') + (direct ? '.lock.json' : '.lock-merge.json');
  const metadata = {output, metadata: metadataPath, method: direct ? 'whole-board-visual-review' : 'whole-board-lock-merge',
    segmentId: plan.segmentId, width, height, layout: '3x3', cellCount: 9, mapFile: planPath, mapValid: true,
    lockMergeSucceeded: true, frozenCellsRestored: true, alignmentMode, gridDriftDetected: gridDrift,
    editedSourceDimensions: {width: ew, height: eh}, detectedGrid: {valid: detection.valid, columns: detection.columns, rows: detection.rows},
    editableCells: plan.editableCells, frozenCells: plan.frozenCells, productFullCells: plan.productFullCells,
    productPartialCells: plan.productPartialCells, creatorFullCells: plan.creatorFullCells,
    creatorPartialCells: plan.creatorPartialCells, ...adaptive};
  if (direct) Object.assign(metadata, {mergeMode: 'whole-board-direct-v1', compositionMode: 'whole-board-direct-v1',
    layoutRestored: true, labelsRestored: true, fullBoardVisualReviewRequired: true,
    originalFile: resolve(original), originalSha256: await hashFile(original), editedSha256: await hashFile(edited),
    mapSha256: await hashFile(planPath), finalSha256: await hashFile(output)});
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + '\n');
  return metadata;
}
async function main(argv) {
  const [command, ...args] = argv, opts = {}, replacements = [];
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]; if (!key?.startsWith('--') || args[i + 1] == null) throw Error(`无效参数：${key}`);
    if (key === '--replacement') replacements.push(args[i + 1]); else opts[key.slice(2)] = args[i + 1];
  }
  const ffmpeg = opts.ffmpeg ?? await findFfmpeg(), ffprobe = opts.ffprobe ?? await findOnPath('ffprobe');
  if (!ffmpeg) throw Error('当前环境缺少 ffmpeg。');
  const path = key => opts[key] == null ? null : expand(opts[key]);
  let result;
  if (command === 'split') result = await splitBoard(ffmpeg, ffprobe, path('board'), path('output-dir'));
  else if (command === 'normalize') result = await normalizeCell(ffmpeg, ffprobe, path('input'), path('output'), Number(opts.width), Number(opts.height), Number(opts['crop-x'] ?? .5), Number(opts['crop-y'] ?? .5));
  else if (command === 'restore-layout') result = await restoreBoardLayout(ffmpeg, ffprobe, path('input'), path('original'), path('output'), Number(opts['label-height'] ?? 38));
  else if (command === 'fast-prepare') result = await fastPrepare(ffmpeg, ffprobe, path('original'), path('edited'), path('output'), Number(opts['label-height'] ?? 38));
  else if (command === 'lock-merge') result = await lockMerge(ffmpeg, ffprobe, path('original'), path('edited'), path('plan'), path('output'), Number(opts['label-height'] ?? 38));
  else if (command === 'compose') {
    const changed = {};
    for (const value of replacements) {
      const index = value.indexOf('='); if (index < 1) throw Error('replacement 应为编号=文件');
      const cell = Number(value.slice(0, index)), file = expand(value.slice(index + 1));
      if (!Number.isInteger(cell) || cell < 1 || cell > 9 || !await nonempty(file)) throw Error('替换画格无效。');
      changed[cell] = file;
    }
    result = await compose(ffmpeg, path('cells-dir'), path('output'), changed);
  } else throw Error(`未知或尚未迁移的命令：${command}`);
  process.stdout.write(JSON.stringify({ok: true, ...result}) + '\n');
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  main(process.argv.slice(2)).catch(e => {console.error(e.message); process.exitCode = 1;});
