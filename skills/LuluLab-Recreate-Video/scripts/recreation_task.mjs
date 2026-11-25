/** Offline Dispatcher task builder shared by both Skill hosts. */
export const WORKFLOWS = { storyboard: 'StoryboardRecreationV1', deep: 'DeepRecreationV1', element_replace: 'ElementReplacementV1' };
const deepModels = ['seedance-2-mini', 'seedance-2-fast', 'seedance-2-5-flash', 'seedance-2', 'seedance-2-5', 'wan-3'];
const models = { storyboard: [...deepModels, 'grok-imagine-1-5-preview'], deep: deepModels, element_replace: ['seedance-2-5', 'wan-3'] };
export function validateVideoSettings(mode, { model, resolution, aspectRatio, generateAudio }) {
  if (!models[mode]?.includes(model)) throw Error('Unsupported model for the selected recreation mode.');
  const ratios = model === 'grok-imagine-1-5-preview' ? ['16:9', '9:16', '1:1'] : model === 'wan-3' ? ['9:16', '16:9', '1:1', '3:4', '4:3'] : ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
  const resolutions = model === 'wan-3' ? ['720p'] : model === 'seedance-2-5' ? ['480p', '720p', '1080p'] : ['480p', '720p'];
  if (!ratios.includes(aspectRatio) || !resolutions.includes(resolution)) throw Error('Unsupported model aspect ratio or resolution; use the frontend model settings.');
  if (typeof generateAudio !== 'boolean') throw Error('generateAudio must be boolean.');
}

export function recreationSegmentLimitMs(model) {
  return ['seedance-2-5', 'seedance-2-5-flash', 'wan-3'].includes(model) ? 30000 : 15000;
}
export function recreationEditAspectRatio(model, aspectRatio) {
  return ['seedance-2-5', 'seedance-2-5-flash'].includes(model) ? 'adaptive' : aspectRatio;
}
export const guid = value => typeof value === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value) && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value);
const imageMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
export function validateReferenceImage(mimeType, name = '') {
  if (!imageMimeTypes.has(String(mimeType ?? '').toLowerCase().split(';')[0].trim()) || /\.jfif(?:$|[?#])/i.test(name))
    throw Error(`参考图「${name || '未命名图片'}」格式不支持。请转换为 JPG、PNG 或 WebP 后重新上传；不支持 JFIF。`);
}
export function https(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw Error('Media must use HTTPS without embedded credentials.');
  return url.href;
}
export function reference(file, type) {
  if (!file || typeof file !== 'object') throw Error('Media requires an uploaded file object.');
  const mimeType = file.mimeType;
  if (type === 'image') validateReferenceImage(mimeType, file.fileName || file.attributes?.fileName || file.name || file.url || file.location);
  else if (typeof mimeType !== 'string' || !mimeType.startsWith(`${type}/`)) throw Error(`Expected ${type} media MIME type.`);
  const expiredAt = file.expiredAt || file.expiresAt;
  if (expiredAt && (!Number.isFinite(Date.parse(expiredAt)) || Date.parse(expiredAt) <= Date.now())) throw Error('Media is expired.');
  return { url: https(file.url || file.location), mimeType, ...(expiredAt ? { expiredAt } : {}) };
}

export function resolveAudioMode(mode, { outputAudioMode, generateAudio }, hasVoice = false) {
  if (generateAudio !== undefined && typeof generateAudio !== 'boolean') throw Error('generateAudio must be boolean.');
  if (outputAudioMode !== undefined) {
    if (!['source', 'generate', 'mute'].includes(outputAudioMode) || (outputAudioMode === 'source' && mode !== 'deep'))
      throw Error('Only motion-guided recreation supports keeping original audio. Choose an audio mode supported by the selected workflow.');
    return outputAudioMode;
  }
  if (generateAudio !== undefined) return generateAudio ? 'generate' : 'mute';
  return mode === 'deep' && !hasVoice ? 'source' : 'generate';
}

export function buildTask(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw Error('Request must be a JSON object.');
  if (config.promptOnly || config.executionMode === 'prompt-only') throw Error('Prompt-only requests must use the legacy export path, not a paid Dispatcher parent.');
  const mode = config.mode ?? 'deep';
  if (!Object.hasOwn(WORKFLOWS, mode)) throw Error('mode must be storyboard, deep or element_replace.');
  const model = config.model ?? (mode === 'element_replace' ? 'seedance-2-5' : 'seedance-2-5-flash');
  const duration = config.sourceDuration;
  if (!Number.isFinite(duration) || duration < 4 || duration > 60) throw Error('sourceDuration must be the measured source duration, 4–60 seconds.');
  if (!guid(config.source?.id)) throw Error('source.id must be an owned uploaded Asset file ID, not a public URL or asset-record ID.');
  const source = reference(config.source, 'video');
  const images = name => {
    const files = config[name] ?? [];
    if (!Array.isArray(files)) throw Error(`${name} must be an array.`);
    return files.map(file => reference(file, 'image'));
  };
  const productImages = images('productImages'), personImages = images('personImages'), backgroundImages = images('backgroundImages');
  const creatorMode = config.creatorMode ?? (personImages.length ? 'user_provided' : 'ai_generated');
  if (!['ai_generated', 'user_provided', 'keep_source'].includes(creatorMode)) throw Error('Invalid creatorMode.');
  if (mode !== 'element_replace' && ((creatorMode === 'user_provided') !== Boolean(personImages.length))) throw Error('Only user_provided creator mode accepts and requires person images.');
  const imageLimit = model === 'grok-imagine-1-5-preview' ? 6 : 10;
  if (productImages.length + personImages.length + backgroundImages.length > imageLimit) throw Error(`At most ${imageLimit} reference images are supported for this mode.`);
  if (config.referenceAudios !== undefined && !Array.isArray(config.referenceAudios)) throw Error('referenceAudios must be an array.');
  const voiceFiles = config.referenceAudios ?? [];
  if (voiceFiles.length > 1) throw Error('At most one voice reference is supported.');
  const outputAudioMode = resolveAudioMode(mode, config, voiceFiles.length > 0);
  const generateAudio = outputAudioMode === 'generate';
  const voiceReferences = voiceFiles.map(file => reference(file, 'audio'));
  const referenceAudios = generateAudio ? voiceReferences : [];
  if (model === 'grok-imagine-1-5-preview' && referenceAudios.length) throw Error('Grok storyboard recreation does not support voice references.');
  const aspectRatio = config.aspectRatio ?? '9:16';
  const resolution = config.resolution ?? (model === 'wan-3' || mode === 'element_replace' ? '720p' : '480p');
  validateVideoSettings(mode, { model, resolution, aspectRatio, generateAudio });
  if (config.requirement !== undefined && typeof config.requirement !== 'string') throw Error('requirement must be text.');
  const requirement = (config.requirement ?? '').trim();
  if (config.marketingText !== undefined && typeof config.marketingText !== 'string') throw Error('marketingText must be text.');
  const locale = config.interactionLocale ?? 'zh-CN';
  if (typeof locale !== 'string' || !locale.trim()) throw Error('interactionLocale must be nonempty text.');
  let input;
  if (mode === 'storyboard') {
    const shared = { interactionLocale: locale, targetCountry: config.targetCountry ?? '跟原视频一致',
      targetLanguage: config.targetLanguage ?? '跟原视频一致', customRequirement: requirement };
    input = { schemaVersion: 'lululab.recreate.video.v1', recreateMode: 'storyboard',
      storyboardPipelineVersion: 2, reviewBeforeGeneration: false,
      postproduction: { marketingText: (config.marketingText ?? requirement).trim(), marketingTextMode: config.marketingText === undefined ? 'creative_brief' : 'literal' },
      benchmarkVideo: { ...source, assetId: config.source.id, duration },
      userConfig: { model, sourceDuration: duration, targetDuration: Math.ceil(duration), targetDurationSource: 'source_nearest_integer', ...shared },
      product: { mode: productImages.length ? 'replace' : 'keep_source', images: productImages },
      creator: { mode: creatorMode, images: personImages },
      assets: { backgroundMode: backgroundImages.length ? 'replace' : 'keep_source', backgroundImages, referenceAudios },
      settings: { videoModel: model, durationMode: 'source', aspectRatio, resolution, generateAudio, ...shared } };
  } else {
    if (config.targetLanguage || config.targetCountry) throw Error('For deep/element_replace, include language/country instructions in requirement, as in the frontend.');
    input = { model, intentVersion: 'lululab.recreation.intent.v1', userRequirement: requirement,
      productImages, personImages, backgroundImages, aspectRatio: recreationEditAspectRatio(model, aspectRatio),
      resolution, duration: Math.ceil(duration), generateAudio, sourceAssetId: config.source.id,
      sourceDurationMs: Math.round(duration * 1000), modelDurationLimitMs: mode === 'element_replace' && model === 'wan-3' ? 15000 : recreationSegmentLimitMs(model),
      ...([...productImages, ...personImages, ...backgroundImages].length ? { referenceImages: [...productImages, ...personImages, ...backgroundImages] } : {}),
      ...(referenceAudios.length ? { referenceAudios } : {}) };
    if (mode === 'deep') Object.assign(input, { deepPipelineVersion: 2, deepPresentationVersion: 1, creator: { mode: creatorMode }, recreateMode: 'deep', benchmarkVideo: source,
      deepRequirement: requirement, sourceAspectRatio: aspectRatio, outputAudioMode });
  }
  const stored = (originals, normalized) => normalized.map((file, index) => ({ ...originals[index], ...file }));
  const selected = { product: stored(config.productImages ?? [], productImages), person: stored(config.personImages ?? [], personImages),
    background: stored(config.backgroundImages ?? [], backgroundImages), voice: stored(voiceFiles, voiceReferences) };
  const editorSnapshot = { cloneMode: mode, brief: requirement, selected, referenceVideo: { ...config.source, ...source },
    sourceVideoDuration: duration, model, aspectRatio, resolution, duration: Math.ceil(duration), generateAudio,
    personSource: creatorMode === 'user_provided' ? 'upload' : creatorMode === 'keep_source' ? 'original' : 'generate',
    personPhotos: selected.person, mentionBindings: [] };
  if (mode !== 'element_replace') {
    editorSnapshot.audioModes = { deep: 'source', storyboard: 'generate' };
    editorSnapshot.recreationMuted = { deep: false, storyboard: false };
    if (outputAudioMode === 'mute') editorSnapshot.recreationMuted[mode] = true;
    else editorSnapshot.audioModes[mode] = outputAudioMode;
  }
  return { workflowId: WORKFLOWS[mode], input, editorSnapshot };
}
