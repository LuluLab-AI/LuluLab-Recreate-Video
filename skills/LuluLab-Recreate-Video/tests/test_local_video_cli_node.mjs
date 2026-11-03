import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveGenerationProvider, resolveVideoProvider, submitVideo, detectVideoProviders} from '../scripts/local_video_cli.mjs';

test('provider selection keeps the legacy order and rejects unavailable explicit providers', () => {
  const available = {libtv_cli: true, xiaoyunque_cli: true, dreamina_cli: true, lululab_cli: true};
  assert.equal(resolveGenerationProvider(available), 'libtv_cli');
  assert.equal(resolveVideoProvider('auto', available), 'xiaoyunque_cli');
  assert.equal(resolveVideoProvider('auto', {dreamina_cli: true}), 'dreamina_cli');
  assert.throws(() => resolveVideoProvider('dreamina_cli', {}), /不可用/);
});
test('provider detection and input validation do not submit paid tasks', async () => {
  const found = await detectVideoProviders('seedance-2-mini');
  assert.equal(typeof found.lululab_cli, 'boolean');
  await assert.rejects(() => submitVideo('unknown', 'seedance-2-mini', 'x', 5), /未知/);
  await assert.rejects(() => submitVideo('lululab_cli', 'seedance-2-mini', '', 5), /不能为空/);
});
