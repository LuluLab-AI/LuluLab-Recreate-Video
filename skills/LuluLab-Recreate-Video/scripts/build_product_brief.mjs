#!/usr/bin/env node
/** Build a validated product_brief 产品卡 JSON string. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFastProductBriefString, buildProductBriefString } from '../core/product_builder.mjs';

const multi = new Map([
  ['--user-selling-point', 'userSellingPoints'], ['--product-material-fact', 'productMaterialFacts'],
  ['--ai-supplement', 'aiSupplements'], ['--forbidden-change', 'forbiddenChanges'],
  ['--locked-feature', 'lockedFeatures'],
]);
const scalar = new Map([
  ['--product-name', 'productName'], ['--product-type', 'productType'], ['--appearance', 'appearance'],
  ['--product-color', 'productColor'], ['--material', 'material'], ['--logo', 'logo'],
  ['--structure', 'structure'], ['--usage', 'usage'], ['--other-requirements', 'otherRequirements'],
]);

export function parseArgs(argv) {
  const options = { userSellingPoints: [], productMaterialFacts: [], aiSupplements: [],
    forbiddenChanges: [], lockedFeatures: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--fast-brief') options.fastBrief = true;
    else if (arg === '--compact') options.compact = true;
    else if (multi.has(arg) || scalar.has(arg)) {
      const value = argv[++i];
      if (value == null) throw new Error(`argument ${arg}: expected one argument`);
      if (multi.has(arg)) options[multi.get(arg)].push(value);
      else options[scalar.get(arg)] = value;
    } else throw new Error(`unrecognized argument: ${arg}`);
  }
  return options;
}

export function build(options) {
  if (options.fastBrief) return buildFastProductBriefString({
    productName: options.productName, productType: options.productType, usage: options.usage,
    lockedFeatures: options.lockedFeatures.length ? options.lockedFeatures : options.forbiddenChanges,
    userClaims: options.userSellingPoints, otherRequirements: options.otherRequirements,
    pretty: !options.compact,
  });
  return buildProductBriefString({ ...options, pretty: !options.compact });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(build(parseArgs(process.argv.slice(2)))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
