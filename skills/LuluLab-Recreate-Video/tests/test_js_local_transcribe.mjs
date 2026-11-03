import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAudioReview, cleanSegments } from '../scripts/local_transcribe.mjs';

test('Whisper segments retain word timestamps and reject invalid spans', () => {
  const result = { language: 'th', segments: [
    { start: 0.1234, end: 1.5678, text: ' สวัสดี ', words: [
      { start: 0.1234, end: 0.75, word: ' สวัสดี ' }, { start: null, end: 1, word: 'invalid' },
    ] },
    { start: 2, end: 1, text: 'invalid' }, { start: 3, end: 4, text: ' ' },
  ] };
  assert.deepEqual(cleanSegments(result), [{ id: 1, start: 0.123, end: 1.568,
    text: 'สวัสดี', words: [{ start: 0.123, end: 0.75, text: 'สวัสดี' }] }]);
  const review = buildAudioReview(result, { video: '/tmp/source.mp4', backend: 'mlx', model: 'whisper-turbo' }).audioReview;
  assert.equal(review.status, 'transcript_ready');
  assert.equal(review.language, 'th');
  assert.equal(review.audioUploaded, false);
  assert.equal(review.text, 'สวัสดี');
});

test('empty local transcription reports verified no speech', () => {
  const review = buildAudioReview({ segments: [] }, { video: '/tmp/source.mp4', backend: 'openai', model: 'small' }).audioReview;
  assert.equal(review.status, 'verified_no_speech');
  assert.equal(review.speechDetected, false);
  assert.deepEqual(review.segments, []);
});
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mediaHasAudio, transcribeNode, whisperChunksToSegments } from '../scripts/local_transcribe.mjs';

test('word timestamp chunks preserve segment and word structure', () => {
  const value = whisperChunksToSegments({ chunks: [{ text: ' Hello world', timestamp: [0, 2] }], language: 'en' },
    { chunks: [{ text: ' Hello', timestamp: [0, 0.8] }, { text: ' world', timestamp: [0.8, 1.9] }] });
  assert.deepEqual(value, { language: 'en', segments: [{ start: 0, end: 2, text: ' Hello world',
    words: [{ start: 0, end: 0.8, word: ' Hello' }, { start: 0.8, end: 1.9, word: ' world' }] }] });
  assert.throws(() => whisperChunksToSegments({ text: 'hello' }, {}), /没有分段时间戳/);
});

test('Node Whisper adapter decodes local audio and requests segment plus word timestamps', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lululab-asr-js-'));
  try {
    const video = join(dir, 'audio.mp4');
    const made = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
      '-i', 'sine=frequency=500:duration=2', '-c:a', 'aac', video], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    assert.equal(mediaHasAudio(video), true);
    const calls = [];
    const result = await transcribeNode(video, 'onnx-community/whisper-small', 'en', {
      pipelineFactory: async (_task, _model) => async (audio, options) => {
        assert.ok(audio instanceof Float32Array);
        assert.ok(audio.length > 30000);
        calls.push(options.return_timestamps);
        return { chunks: options.return_timestamps === true
          ? [{ text: ' hello', timestamp: [0, 1] }]
          : [{ text: ' hello', timestamp: [0, 1] }] };
      },
    });
    assert.deepEqual(calls, [true, 'word']);
    assert.equal(result.segments[0].words[0].word, ' hello');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
