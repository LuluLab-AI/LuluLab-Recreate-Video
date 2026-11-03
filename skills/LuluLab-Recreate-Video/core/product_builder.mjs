/** Build, validate, and serialize a sourced product_brief product card. */
export const SOURCE_AUTHORITY = Object.freeze({ user: 3, product_material: 2, ai_supplement: 1 });
export const PRODUCT_CARD_FIELDS = ['产品名称', '产品类型', '外观', '产品颜色', '材质', 'Logo', '结构', '使用方式', '产品卖点', '用户卖点锁定', '禁止变化项', '其他要求'];
export const LEGACY_PRODUCT_CARD_FIELDS = ['产品名称', '外观', '产品颜色', '材质', 'Logo', '结构', '使用方式', '产品卖点', '用户卖点锁定', '禁止变化项'];
export const FAST_PRODUCT_CARD_FIELDS = ['产品名称', '产品类型', '使用方式', '锁定特征', '用户卖点锁定', '其他要求'];
const SCALAR_FIELDS = ['产品名称', '产品类型', '外观', '产品颜色', '材质', 'Logo', '结构', '使用方式', '其他要求'];
const LOCAL_PATH_PATTERN = /(?:file:\/\/|\/Users\/|\/home\/|[A-Za-z]:[\\/])/;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const cleanScalar = value => value == null ? '' : String(value).trim();
const cleanValues = values => [...new Set((values ?? []).map(value => String(value).trim()).filter(Boolean))];
const items = (values, source) => cleanValues(values).map(text => ({ text, source, authority: SOURCE_AUTHORITY[source] }));
const containsPrivateData = text => text.toLowerCase().includes('data:image') || LOCAL_PATH_PATTERN.test(text);

export function buildProductBrief({ userSellingPoints, productMaterialFacts, aiSupplements,
  productName = '', productType = '', appearance = '', productColor = '', material = '', logo = '',
  structure = '', usage = '', forbiddenChanges, otherRequirements = '无' } = {}) {
  const user = items(userSellingPoints, 'user');
  const image = items(productMaterialFacts, 'product_material');
  const ai = items(aiSupplements, 'ai_supplement');
  const retained = [], seen = new Set();
  for (const item of [...user, ...image, ...ai]) {
    if (!seen.has(item.text)) { retained.push(item); seen.add(item.text); }
  }
  return { 产品卡: {
    产品名称: cleanScalar(productName), 产品类型: cleanScalar(productType), 外观: cleanScalar(appearance),
    产品颜色: cleanScalar(productColor), 材质: cleanScalar(material), Logo: cleanScalar(logo),
    结构: cleanScalar(structure), 使用方式: cleanScalar(usage), 产品卖点: retained,
    用户卖点锁定: user.map(item => item.text), 禁止变化项: cleanValues(forbiddenChanges),
    其他要求: cleanScalar(otherRequirements) || '无',
  } };
}

export function buildFastProductBrief({ productName = '', productType = '', usage = '',
  lockedFeatures, userClaims, otherRequirements = '无' } = {}) {
  return { 产品卡: {
    产品名称: cleanScalar(productName), 产品类型: cleanScalar(productType), 使用方式: cleanScalar(usage),
    锁定特征: cleanValues(lockedFeatures), 用户卖点锁定: cleanValues(userClaims),
    其他要求: cleanScalar(otherRequirements) || '无',
  } };
}

export function validateFastProductBrief(brief) {
  const errors = [];
  if (!isObject(brief) || !same(Object.keys(brief), ['产品卡']) || !isObject(brief.产品卡))
    return [false, ['fast product_brief must contain only the 产品卡 object.']];
  const card = brief.产品卡;
  if (!same(Object.keys(card), FAST_PRODUCT_CARD_FIELDS))
    errors.push('轻量产品卡字段必须为：产品名称、产品类型、使用方式、锁定特征、用户卖点锁定、其他要求。');
  for (const field of ['产品名称', '产品类型', '使用方式', '其他要求']) {
    const value = card[field];
    if (typeof value !== 'string' || value !== value.trim() || containsPrivateData(value))
      errors.push(`产品卡.${field} 必须为不含本地路径的trim字符串。`);
  }
  for (const field of ['锁定特征', '用户卖点锁定']) {
    const value = card[field];
    if (!Array.isArray(value) || !same(value, cleanValues(value)) ||
        value.some(item => typeof item === 'string' && containsPrivateData(item)))
      errors.push(`产品卡.${field} 必须为去重后的字符串数组。`);
  }
  return [errors.length === 0, errors];
}

export function validateProductBrief(brief) {
  const errors = [];
  if (!isObject(brief)) return [false, ['product_brief must be a JSON object.']];
  if (!same(Object.keys(brief), ['产品卡'])) return [false, ['product_brief must contain only the 产品卡 object.']];
  const card = brief.产品卡;
  if (!isObject(card)) return [false, ['product_brief.产品卡 must be a JSON object.']];
  if (![PRODUCT_CARD_FIELDS, LEGACY_PRODUCT_CARD_FIELDS].some(fields => same(Object.keys(card), fields)))
    errors.push('产品卡字段必须采用当前schema，或使用可兼容读取的旧schema。');

  for (const field of SCALAR_FIELDS.filter(field => Object.hasOwn(card, field))) {
    const value = card[field];
    if (typeof value !== 'string') errors.push(`产品卡.${field} must be a string.`);
    else if (field === '产品名称' && !value.trim())
      errors.push('产品卡.产品名称 must be a non-empty image-grounded name or conservative category name.');
    else if (value !== value.trim()) errors.push(`产品卡.${field} must be trimmed.`);
    else if (containsPrivateData(value)) errors.push(`产品卡.${field} must not contain image data or local paths.`);
  }

  let sellingPoints = card.产品卖点;
  if (!Array.isArray(sellingPoints) || !sellingPoints.length) {
    errors.push('产品卡.产品卖点 must be a non-empty list.'); sellingPoints = [];
  }
  const seen = new Set(), userItems = [];
  let productMaterialCount = 0, previousAuthority = 4;
  for (const [index, item] of sellingPoints.entries()) {
    const prefix = `产品卡.产品卖点[${index}]`;
    if (!isObject(item)) { errors.push(`${prefix} must be an object.`); continue; }
    if (Object.keys(item).length !== 3 ||
        !['text', 'source', 'authority'].every(key => Object.hasOwn(item, key)))
      errors.push(`${prefix} keys must be text, source, and authority.`);
    const { text, source, authority } = item;
    if (typeof text !== 'string' || !text.trim()) { errors.push(`${prefix}.text must be non-empty text.`); continue; }
    if (text !== text.trim()) errors.push(`${prefix}.text must be trimmed.`);
    if (seen.has(text)) errors.push(`Duplicate product_brief text: ${text}`);
    seen.add(text);
    if (containsPrivateData(text)) errors.push(`${prefix} must not contain image data or local paths.`);
    if (!Object.hasOwn(SOURCE_AUTHORITY, source)) { errors.push(`${prefix}.source is unsupported: ${source}`); continue; }
    const expected = SOURCE_AUTHORITY[source];
    if (authority !== expected) errors.push(`${prefix}.authority must be ${expected} for ${source}.`);
    if (Number.isInteger(authority) && authority > previousAuthority)
      errors.push('产品卖点 must follow descending source authority.');
    if (Number.isInteger(authority)) previousAuthority = authority;
    if (source === 'user') userItems.push(text);
    if (source === 'product_material') productMaterialCount++;
  }
  if (sellingPoints.length && productMaterialCount === 0)
    errors.push('product_brief requires at least one visible product-material fact from the required product images.');

  const locked = card.用户卖点锁定;
  if (!Array.isArray(locked) || !locked.every(value => typeof value === 'string' && value.trim()))
    errors.push('产品卡.用户卖点锁定 must be a list of non-empty strings.');
  else if (!same(locked, userItems)) errors.push('产品卡.用户卖点锁定 must exactly match ordered user-source claims.');
  const forbidden = card.禁止变化项;
  if (!Array.isArray(forbidden) || !forbidden.every(value => typeof value === 'string' && value.trim()))
    errors.push('产品卡.禁止变化项 must be a list of non-empty strings.');
  else if (!same(forbidden, cleanValues(forbidden))) errors.push('产品卡.禁止变化项 must be trimmed and deduplicated.');
  else if (forbidden.some(containsPrivateData)) errors.push('产品卡.禁止变化项 must not contain image data or local paths.');
  return [errors.length === 0, errors];
}

export function serializeProductBrief(brief, { pretty = false } = {}) {
  const [ok, errors] = validateProductBrief(brief);
  if (!ok) throw new Error(errors.join('; '));
  return JSON.stringify(brief, null, pretty ? 2 : undefined);
}

export function parseProductBrief(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('product_brief string must be non-empty.');
  let brief;
  try { brief = JSON.parse(raw); }
  catch (error) { throw new Error(`product_brief is not valid JSON: ${error.message}`); }
  const [ok, errors] = validateProductBrief(brief);
  if (!ok) throw new Error(errors.join('; '));
  return brief;
}

export function buildProductBriefString(options = {}) {
  return serializeProductBrief(buildProductBrief(options), { pretty: options.pretty ?? false });
}

export function buildFastProductBriefString(options = {}) {
  const brief = buildFastProductBrief(options);
  const [ok, errors] = validateFastProductBrief(brief);
  if (!ok) throw new Error(errors.join('; '));
  return JSON.stringify(brief, null, options.pretty ? 2 : undefined);
}
