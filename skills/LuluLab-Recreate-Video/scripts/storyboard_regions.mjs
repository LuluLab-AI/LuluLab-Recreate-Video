#!/usr/bin/env node
/** Conservative geometry and polygon validation for storyboard region edits. */
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, readFile, stat, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {findFfmpeg, findOnPath} from '../utils/ffmpeg.mjs';
const RATIOS = [[1, 1], [3, 4], [4, 3], [9, 16], [16, 9]];
export const MAX_CANVAS_ASPECT_RATIO_DRIFT = 0.15;

export function geometry(width, height) {
  if (![width, height].every(x => Number.isInteger(x) && x > 0)) throw Error('画布宽高必须为正整数。');
  const [a, b] = RATIOS.reduce((best, ratio) =>
    Math.abs(Math.log(width / height / (ratio[0] / ratio[1]))) <
    Math.abs(Math.log(width / height / (best[0] / best[1]))) ? ratio : best);
  const scale = Math.max(Math.ceil(width / a), Math.ceil(height / b));
  const w = a * scale, h = b * scale;
  return {width: w, height: h, x: Math.floor((w - width) / 2), y: Math.floor((h - height) / 2), aspectRatio: `${a}:${b}`};
}

export function validateCanvasAspectRatio(editedWidth, editedHeight, canvasWidth, canvasHeight) {
  if (Math.min(editedWidth, editedHeight, canvasWidth, canvasHeight) <= 0) throw Error('画布宽高必须为正数。');
  const drift = Math.abs((editedWidth / editedHeight) / (canvasWidth / canvasHeight) - 1);
  if (drift > MAX_CANVAS_ASPECT_RATIO_DRIFT) throw Error('生成画布比例偏移超过15%；停止合成，不做中心裁切补救。');
  return drift;
}

export function polygons(value, role) {
  if (!Array.isArray(value)) throw Error(`${role} 必须是多边形数组。`);
  for (const poly of value) {
    if (!Array.isArray(poly) || poly.length < 3) throw Error(`${role} 每个多边形至少3点。`);
    for (const point of poly) if (!Array.isArray(point) || point.length !== 2 ||
      point.some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1))
      throw Error(`${role} 坐标必须为0～1的有限数字。`);
    const area = Math.abs(poly.reduce((sum, [x, y], i) => {
      const [nx, ny] = poly[(i + 1) % poly.length]; return sum + x * ny - nx * y;
    }, 0)) / 2;
    if (area < .00001) throw Error(`${role} 多边形面积为零或过小。`);
  }
  return value;
}

export function validateRegions(plan) {
  if (plan.compositionMode != null && plan.compositionMode !== 'region-lock-v1') throw Error('未知compositionMode。');
  if (plan.compositionMode && (typeof plan.editRule !== 'string' || !plan.editRule.trim()))
    throw Error('局部替换必须提供明确的editRule。');
  if (plan.mergeMode !== 'object-regions-v1') throw Error('新图片任务必须使用 mergeMode=object-regions-v1。');
  if (plan.coordinateSpace !== 'original-cell-visual-normalized') throw Error('区域坐标必须以原始单格画面区为准，排除标签。');
  const label = plan.labelHeight ?? 38;
  if (!Number.isInteger(label) || label < 1) throw Error('labelHeight 必须为正整数。');
  for (const cell of plan.cells) {
    if (!cell.regions || Object.keys(cell.regions).sort().join(',') !== 'creator,product,protect')
      throw Error('每格regions必须含product、creator、protect。');
    for (const kind of ['product', 'creator', 'protect']) {
      polygons(cell.regions[kind], kind);
      if (kind !== 'protect' && Boolean(cell.regions[kind].length) !== Boolean(cell[kind].replace))
        throw Error(`第${cell.index}格 ${kind}区域必须与replace选择一致。`);
    }
  }
  return plan;
}

export function raster(polys, width, height) {
  const mask = Buffer.alloc(width * height);
  for (const poly of polys) {
    const points = poly.map(([x, y]) => [x * width, y * height]);
    for (let y = 0; y < height; y++) {
      const xs = [];
      for (let i = 0; i < points.length; i++) {
        const [x1, y1] = points[i], [x2, y2] = points[(i + 1) % points.length], scan = y + .5;
        if ((y1 <= scan && scan < y2) || (y2 <= scan && scan < y1)) xs.push(x1 + (scan - y1) * (x2 - x1) / (y2 - y1));
      }
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2)
        mask.fill(255, y * width + Math.max(0, Math.ceil(xs[i] - .5)), y * width + Math.min(width, Math.ceil(xs[i + 1] - .5)));
    }
  }
  return mask;
}

export function boardMask(plan, width, height) {
  validateRegions(plan);
  if (width % 3 || height % 3) throw Error('原板尺寸必须能被3整除。');
  const cw = width / 3, ch = height / 3, vh = ch - (plan.labelHeight ?? 38);
  if (vh < 2) throw Error('标签高度超出单格。');
  const mask = Buffer.alloc(width * height);
  for (const cell of plan.cells) {
    const edit = raster([...cell.regions.product, ...cell.regions.creator], cw, vh);
    const protect = raster(cell.regions.protect, cw, vh);
    const row = Math.floor((cell.index - 1) / 3), col = (cell.index - 1) % 3;
    let count = 0;
    for (let y = 1; y < vh; y++) for (let x = 1; x < cw - 1; x++) {
      if (edit[y * cw + x] && !protect[y * cw + x]) { mask[(row * ch + y) * width + col * cw + x] = 255; count++; }
    }
    if ((cell.product.replace || cell.creator.replace) && !count) throw Error(`第${cell.index}格有效编辑区域为空。`);
    if (count >= (cw - 2) * (vh - 1)) throw Error('不能用整格蒙版绕过对象区域保护。');
  }
  return mask;
}

const expand = p => resolve(String(p).replace(/^~(?=\/|$)/, homedir()));
const hashFile = async p => createHash('sha256').update(await readFile(p)).digest('hex');
function run(command, input = null) {
  const r = spawnSync(command[0], command.slice(1), {input, maxBuffer: 512 * 1024 * 1024});
  if (r.error || r.status !== 0) throw Error(String(r.error?.message ?? r.stderr ?? '区域图像处理失败。').slice(-2000));
  return r.stdout;
}
export function rgb(ffmpeg, path, filters = 'format=rgb24') {
  return run([ffmpeg, '-v', 'error', '-i', path, '-vf', filters, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']);
}
export async function writeRgb(ffmpeg, path, pixels, width, height) {
  await mkdir(dirname(path), {recursive: true});
  run([ffmpeg, '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${width}x${height}`,
    '-i', '-', '-frames:v', '1', path], pixels);
}
export function validateAnchors(plan, anchors) {
  if (!Array.isArray(anchors) || anchors.length !== 9) throw Error('区域编辑前需要9个完整原始anchors。');
  if (anchors.every(x => String(x.semanticSource ?? 'observed') === 'unobserved')) return;
  for (let i = 0; i < 9; i++) {
    const cell = plan.cells[i], anchor = anchors[i];
    for (const [kind, present, extent, count] of [
      ['product','productPresent','productVisibility','productCount'], ['creator','personPresent','personExtent','personCount']]) {
      if (![present, extent, count].every(key => key in anchor)) throw Error('原始anchors缺少存在、可见范围或数量字段。');
      if (cell[kind].state !== anchor[extent] || cell[kind].count !== anchor[count] ||
        Boolean(anchor[present]) !== (cell[kind].state !== 'none')) throw Error(`第${cell.index}格 ${kind} 与原始anchor不一致。`);
    }
    if (cell.interactionState !== (anchor.interactionState ?? '')) throw Error('interactionState必须逐格原样保留。');
  }
}
export function mapTemplate(board, replaceProduct = false, replaceCreator = false) {
  const anchors = board.anchors ?? [];
  if (anchors.length !== 9) throw Error('需要9个原始anchors。');
  return {segmentId: board.segmentId ?? board.storyboardId, mergeMode: 'object-regions-v1',
    coordinateSpace: 'original-cell-visual-normalized', labelHeight: 38, replaceProduct, replaceCreator,
    cells: anchors.map((a, i) => ({index: i + 1,
      product: {state: a.productVisibility, count: a.productCount, replace: Boolean(replaceProduct && a.productPresent)},
      creator: {state: a.personExtent, count: a.personCount, replace: Boolean(replaceCreator && a.personPresent)},
      interactionState: a.interactionState ?? '', regions: {product: [], creator: [], protect: []}}))};
}
export async function merge(ffmpeg, ffprobe, original, edited, planPath, output) {
  const {normalizeReplacementMap, dimensions, restoreBoardLayout} = await import('./storyboard_cells.mjs');
  const plan = normalizeReplacementMap(JSON.parse(await readFile(planPath, 'utf8')));
  const [width, height] = dimensions(ffprobe, original, ffmpeg), [ew, eh] = dimensions(ffprobe, edited, ffmpeg);
  const mask = boardMask(plan, width, height), canvas = geometry(width, height);
  const drift = validateCanvasAspectRatio(ew, eh, canvas.width, canvas.height);
  const originalPixels = rgb(ffmpeg, original);
  if (originalPixels.length !== width * height * 3) throw Error('像素解码尺寸错误。');
  const layout = await restoreBoardLayout(ffmpeg, ffprobe, edited, original, output, plan.labelHeight ?? 38);
  let actual = rgb(ffmpeg, output);
  if (actual.length !== originalPixels.length) throw Error('最终Storyboard像素解码尺寸错误。');
  const locked = plan.compositionMode === 'region-lock-v1';
  const maskFile = output.replace(/\.[^.\/]+$/, '') + '.mask.png';
  let outsideChanged = null;
  if (locked) {
    const composite = Buffer.from(originalPixels);
    for (let i = 0; i < mask.length; i++) if (mask[i]) actual.copy(composite, 3 * i, 3 * i, 3 * i + 3);
    await writeRgb(ffmpeg, output, composite, width, height);
    const maskPixels = Buffer.alloc(mask.length * 3);
    for (let i = 0; i < mask.length; i++) maskPixels.fill(mask[i], 3 * i, 3 * i + 3);
    await writeRgb(ffmpeg, maskFile, maskPixels, width, height);
    actual = rgb(ffmpeg, output); outsideChanged = 0;
    for (let i = 0; i < mask.length; i++) if (!mask[i] && !actual.subarray(3*i, 3*i+3).equals(originalPixels.subarray(3*i, 3*i+3))) outsideChanged++;
    if (outsideChanged) throw Error('区域外像素发生变化，禁止登记为合格结果。');
  }
  const result = {method: locked ? 'whole-board-lock-merge' : 'whole-board-user-review',
    mergeMode: 'object-regions-v1', mapValid: true, layoutRestored: true, labelsRestored: true,
    alignmentMode: layout.alignmentMode, canvas, canvasAspectRatioDrift: Math.round(drift * 1e6) / 1e6,
    maxCanvasAspectRatioDrift: MAX_CANVAS_ASPECT_RATIO_DRIFT, layoutRestore: layout,
    originalFile: resolve(original), originalSha256: await hashFile(original), editedSha256: await hashFile(edited),
    mapSha256: await hashFile(planPath), finalSha256: await hashFile(output), width, height, output,
    editableCells: plan.editableCells, frozenCells: plan.frozenCells};
  if (locked) Object.assign(result, {compositionMode: 'region-lock-v1', editRule: plan.editRule,
    lockMergeSucceeded: true, frozenCellsRestored: true, protectedPixelsRestored: true,
    outsideMaskChangedPixels: outsideChanged, maskFile: resolve(maskFile), maskSha256: await hashFile(maskFile)});
  else result.fullBoardUserReviewRequired = true;
  await writeFile(output.replace(/\.[^.\/]+$/, '') + '.lock.json', JSON.stringify(result, null, 2) + '\n');
  return result;
}
async function main(args) {
  const [command, ...rest] = args, opts = {};
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i]; if (['--replace-product','--replace-creator'].includes(key)) opts[key.slice(2)] = true;
    else opts[key.slice(2)] = rest[++i];
  }
  const {normalizeReplacementMap, dimensions} = await import('./storyboard_cells.mjs');
  const ffmpeg = await findFfmpeg(), ffprobe = await findOnPath('ffprobe');
  if (!ffmpeg) throw Error('当前环境缺少 ffmpeg。');
  if (opts.output && await stat(expand(opts.output)).catch(() => null)) throw Error('输出已存在，请选择新文件。');
  if (command === 'map-template') {
    const payload = JSON.parse(await readFile(expand(opts.metadata), 'utf8'));
    const board = payload.boards.find(x => Number(x.segmentId ?? x.storyboardId) === Number(opts['segment-id']));
    if (!board) throw Error('metadata中找不到Segment。');
    const result = mapTemplate(board, Boolean(opts['replace-product']), Boolean(opts['replace-creator']));
    await mkdir(dirname(expand(opts.output)), {recursive: true}); await writeFile(expand(opts.output), JSON.stringify(result, null, 2) + '\n');
    return {ok: true, output: expand(opts.output)};
  }
  const original = expand(opts.original), [width, height] = dimensions(ffprobe, original, ffmpeg);
  const plan = normalizeReplacementMap(JSON.parse(await readFile(expand(opts.plan), 'utf8')));
  if (opts.metadata) {
    const payload = JSON.parse(await readFile(expand(opts.metadata), 'utf8'));
    const id = Number(opts['segment-id'] ?? plan.segmentId);
    const board = payload.boards?.find(x => Number(x.segmentId ?? x.storyboardId) === id);
    if (!board) throw Error(`metadata中找不到Segment ${id}。`);
    validateAnchors(plan, board.anchors ?? []);
  }
  const mask = boardMask(plan, width, height), editable = mask.reduce((n, v) => n + Boolean(v), 0);
  if (command === 'validate-map') {
    if (!editable && (plan.replaceProduct || plan.replaceCreator)) throw Error('Replacement Map没有有效可编辑像素。');
    return {ok: true, mapValid: true, segmentId: plan.segmentId, editablePixels: editable,
      editableRatio: Math.round(editable / (width * height) * 1e6) / 1e6,
      editableCells: plan.editableCells, frozenCells: plan.frozenCells, previewRequired: false};
  }
  if (command === 'preview-mask') {
    const pixels = Buffer.from(rgb(ffmpeg, original));
    for (let i = 0; i < mask.length; i++) if (mask[i]) {
      pixels[3*i] = Math.floor((pixels[3*i] + 255) / 2);
      pixels[3*i+1] = Math.floor(pixels[3*i+1] / 2);
      pixels[3*i+2] = Math.floor(pixels[3*i+2] / 2);
    }
    await writeRgb(ffmpeg, expand(opts.output), pixels, width, height);
    return {output: expand(opts.output), redArea: 'editable; all other pixels protected'};
  }
  throw Error(`未知命令：${command}`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  main(process.argv.slice(2)).then(x => console.log(JSON.stringify(x))).catch(e => {console.error(e.message); process.exitCode = 1;});
