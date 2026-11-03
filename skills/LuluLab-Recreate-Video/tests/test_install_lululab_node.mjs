import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultInstallDir, replaceManagedBlock, bundledCliPath} from '../scripts/install_lululab.mjs';

test('legacy installer chooses user directory and replaces managed PATH block once', async () => {
  assert.equal(defaultInstallDir({system: 'Darwin', home: '/tmp/demo'}), '/tmp/demo/Applications/LuluLab/bin');
  const block = '# >>> lululab managed path >>>\nexport PATH=/x:"$PATH"\n# <<< lululab managed path <<<';
  assert.equal(replaceManagedBlock('before\n', block), `before\n\n${block}\n`);
  assert.equal(replaceManagedBlock(`before\n\n${block}\n\nafter\n`, block), `before\n\n${block}\n\nafter\n`);
  await assert.rejects(() => bundledCliPath({system: 'Linux', machine: 'x64'}), /不支持/);
});
