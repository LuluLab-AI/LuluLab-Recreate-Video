import test from 'node:test';
import assert from 'node:assert/strict';
import {extractMediaCandidates, isTikTokUrl, isDouyinUrl, resolveInput, resolvePageToUrl} from '../scripts/resolve_benchmark_video.mjs';

test('extracts play address before download address', () => {
  const html = '<script id="SIGI_STATE" type="application/json">' +
    JSON.stringify({video: {downloadAddr: {url_list: ['https://example.com/download.mp4']},
      playAddr: {url_list: ['https://example.com/play.mp4']}}}) + '</script>';
  assert.deepEqual(extractMediaCandidates(html), ['https://example.com/play.mp4', 'https://example.com/download.mp4']);
});
test('page resolver checks final host and returns media without requesting it', async () => {
  assert.equal(isTikTokUrl('https://www.tiktok.com/@a/video/123'), true);
  assert.equal(isDouyinUrl('https://www.douyin.com/video/123'), true);
  const source = 'https://www.tiktok.com/@a/video/123';
  const media = 'https://media.example.com/video.mp4';
  const fetchPage = async () => [`<script id="SIGI_STATE">${JSON.stringify({playAddr: media})}</script>`, source];
  assert.equal(await resolvePageToUrl(source, 100, fetchPage), media);
  assert.deepEqual(await resolveInput(source, {fetchPage}), {url: media,
    provider: 'media.example.com', resolution: 'page-extracted-unverified'});
  await assert.rejects(() => resolvePageToUrl(source, 100, async () => ['', 'https://evil.example/a']), /unsupported host/);
});
test('direct media URL stays unverified and local files are refused', async () => {
  const direct = await resolveInput('https://example.com/video.mp4');
  assert.equal(direct.resolution, 'direct-unverified');
  await assert.rejects(() => resolveInput(import.meta.filename), /local benchmark videos/);
});
