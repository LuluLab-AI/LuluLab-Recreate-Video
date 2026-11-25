/** LuluLab host entry point. The website provides all authenticated operations. */
import { buildTask, https, recreationEditAspectRatio, recreationSegmentLimitMs, reference, resolveAudioMode, validateVideoSettings, WORKFLOWS } from './recreation_task.mjs';

function prepare(config) {
  if (!['deep', 'storyboard'].includes(config.mode)) throw Error('当前画布支持深度复刻和分镜复刻。');
  const { workflowId, input, editorSnapshot } = buildTask({ ...config, outputAudioMode: config.outputAudioMode ?? undefined });
  const { model, resolution, aspectRatio, duration, generateAudio } = editorSnapshot;
  return { workflowId, input, editorSnapshot, settings: { model, resolution, aspectRatio, duration, generateAudio,
    outputAudioMode: input.outputAudioMode ?? (generateAudio ? 'generate' : 'mute') } };
}

function resume(checkpoint) {
  const { workflowId, input } = checkpoint;
  if (![WORKFLOWS.deep, WORKFLOWS.storyboard].includes(workflowId) ||
      WORKFLOWS[input?.recreateMode] !== workflowId) {
    throw Error('复刻方案已失效，请重新准备。');
  }
  // Resume the quoted input verbatim, including after a package update.
  return { workflowId, input };
}

function revise({ workflowId, input, settings, editorSnapshot }) {
  resume({ workflowId, input });
  const { model, resolution, aspectRatio } = settings;
  const mode = input.recreateMode;
  const previous = input.outputAudioMode ?? ((input.generateAudio ?? input.settings?.generateAudio) ? 'generate' : 'mute');
  if (settings.outputAudioMode === undefined && typeof settings.generateAudio !== 'boolean') throw Error('Choose an audio setting for recreation.');
  const savedAudio = editorSnapshot?.audioModes?.[mode];
  const preferredAudio = previous === 'mute' ? (savedAudio ?? (mode === 'deep' ? 'source' : 'generate')) : previous;
  const choice = settings.outputAudioMode ?? (settings.generateAudio ? preferredAudio : 'mute');
  const outputAudioMode = resolveAudioMode(mode, { outputAudioMode: choice });
  const generateAudio = outputAudioMode === 'generate';
  validateVideoSettings(mode, { ...settings, generateAudio });
  const voices = generateAudio ? (editorSnapshot?.selected?.voice ?? input.referenceAudios ?? input.assets?.referenceAudios ?? [])
    .map(file => reference(file, 'audio')) : [];
  if (model === 'grok-imagine-1-5-preview' && voices.length) throw Error('Grok storyboard recreation does not support voice references.');
  if (input.recreateMode === 'storyboard') {
    input.userConfig.model = model;
    input.assets.referenceAudios = voices;
    Object.assign(input.settings, { videoModel: model, resolution, aspectRatio, generateAudio });
  } else {
    Object.assign(input, { model, resolution, aspectRatio: recreationEditAspectRatio(model, aspectRatio),
      sourceAspectRatio: aspectRatio, generateAudio, outputAudioMode, modelDurationLimitMs: recreationSegmentLimitMs(model) });
    if (voices.length) input.referenceAudios = voices;
    else delete input.referenceAudios;
  }
  if (editorSnapshot) {
    Object.assign(editorSnapshot, { model, resolution, aspectRatio, generateAudio });
    editorSnapshot.audioModes = { ...editorSnapshot.audioModes, [mode]: outputAudioMode === 'mute' ? preferredAudio : outputAudioMode };
    editorSnapshot.recreationMuted = { ...editorSnapshot.recreationMuted, [mode]: outputAudioMode === 'mute' };
  }
  return { input, editorSnapshot };
}

function complete(task) {
  const { status, output, errorMessage } = task;
  if (status !== 'Succeeded') {
    const fallback = status === 'Cancelled' ? '复刻已取消。' : '复刻未成功，请查看任务详情。';
    return { status, error: errorMessage || fallback };
  }
  const video = output?.video;
  try {
    if (!video?.url || (video.mimeType && !video.mimeType.startsWith('video/'))) throw Error();
    https(video.url);
  } catch {
    return { status: 'Failed', error: '复刻已结束，但没有找到可播放的成片。' };
  }
  return { status, video };
}

let request = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) request += chunk;

try {
  const { stage, data } = JSON.parse(request);
  const stages = { prepare, revise, resume, complete };
  if (!Object.hasOwn(stages, stage)) throw Error('Unknown recreation skill stage.');
  process.stdout.write(JSON.stringify({ result: stages[stage](data) }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error.message }));
}
