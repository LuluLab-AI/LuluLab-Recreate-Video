import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, stat, rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {analysisWindow, publicEndpoint, probeVideo, withPreparedAnalysisVideo} from '../scripts/benchmark_preprocessing.mjs';

test('analysis window uses exact source or user chosen prefix', () => {
  assert.equal(analysisWindow({durationMode: 'source', duration: 29}, 28.6), 28.6);
  assert.equal(analysisWindow({durationMode: 'custom', requestedDuration: 15, duration: 15}, 29), 15);
  for (const config of [{durationMode: 'custom', duration: 30},
    {durationMode: 'custom', requestedDuration: 15, duration: 10}, {durationMode: 'other'},
    {durationMode: 'source', duration: 15}, {durationMode: 'custom', duration: true}])
    assert.throws(() => analysisWindow(config, 29));
});
test('direct video URLs reject credentials and private addresses', async () => {
  for (const url of ['file:///etc/passwd', 'http://user:pass@example.com/a', 'http://127.0.0.1/a',
    'http://10.0.0.1/a', 'http://169.254.169.254/a', 'http://[::1]/a'])
    await assert.rejects(() => publicEndpoint(url));
});
test('local prefix is validated and temporary upload is removed', async t => {
  if (spawnSync('ffmpeg', ['-version']).status || spawnSync('ffprobe', ['-version']).status) return t.skip('requires FFmpeg');
  const root = await mkdtemp(join(tmpdir(), 'lululab-preprocess-'));
  try {
    const source = join(root, 'source.mp4');
    const made = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i',
      'testsrc2=size=160x240:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', source]);
    assert.equal(made.status, 0);
    const original = await probeVideo(source);
    assert.ok(Math.abs(original.duration - 3) < 0.1);
    let preparedPath;
    await withPreparedAnalysisVideo({durationMode: 'custom', duration: 2}, join(root, 'upload'),
      {benchmark: source}, async result => {
        preparedPath = result.filePath;
        assert.equal(result.trimmed, true);
        assert.equal(result.directUrl, null);
        assert.ok(Math.abs((await probeVideo(preparedPath)).duration - 2) < 0.2);
      });
    await assert.rejects(() => stat(preparedPath));
    assert.ok((await stat(source)).isFile());
  } finally {await rm(root, {recursive: true, force: true});}
});
