import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProductBrief, buildProductBriefString, buildFastProductBriefString,
  parseProductBrief, validateProductBrief, validateFastProductBrief } from '../core/product_builder.mjs';
import { build, parseArgs } from '../scripts/build_product_brief.mjs';

test('product brief preserves claim priority and exact schema', () => {
  const options = { productName: '杯子', userSellingPoints: ['保温', '保温'],
    productMaterialFacts: ['保温', '蓝色外观'], aiSupplements: ['轻便'], forbiddenChanges: ['Logo', 'Logo'] };
  const brief = buildProductBrief(options);
  assert.deepEqual(brief.产品卡.产品卖点, [
    { text: '保温', source: 'user', authority: 3 },
    { text: '蓝色外观', source: 'product_material', authority: 2 },
    { text: '轻便', source: 'ai_supplement', authority: 1 },
  ]);
  assert.deepEqual(brief.产品卡.禁止变化项, ['Logo']);
  const serialized = buildProductBriefString(options);
  assert.deepEqual(parseProductBrief(serialized), brief);
  assert.equal(serialized, JSON.stringify(brief));
});

test('product brief rejects missing image-grounded fact and private paths', () => {
  const brief = buildProductBrief({ productName: '杯子', userSellingPoints: ['保温'] });
  assert.match(validateProductBrief(brief)[1].join('; '), /product-material fact/);
  brief.产品卡.外观 = '/Users/someone/private.jpg';
  assert.match(validateProductBrief(brief)[1].join('; '), /local paths/);
  assert.throws(() => buildProductBriefString({ productName: '杯子', userSellingPoints: ['保温'] }), /product-material fact/);
});

test('fast brief matches CLI flags and rejects duplicates', () => {
  const args = parseArgs(['--fast-brief', '--compact', '--product-name', '杯子',
    '--locked-feature', '蓝色', '--user-selling-point', '保温']);
  const output = build(args);
  assert.deepEqual(JSON.parse(output).产品卡, {
    产品名称: '杯子', 产品类型: '', 使用方式: '', 锁定特征: ['蓝色'], 用户卖点锁定: ['保温'], 其他要求: '无',
  });
  assert.equal(validateFastProductBrief(JSON.parse(buildFastProductBriefString({ productName: '杯子' })))[0], true);
  const bad = JSON.parse(output); bad.产品卡.锁定特征.push('蓝色');
  assert.equal(validateFastProductBrief(bad)[0], false);
});
