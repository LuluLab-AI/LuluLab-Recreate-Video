import test from 'node:test';
import assert from 'node:assert/strict';
import {bindPrompt, defaultLibtvModel, videoNodeArguments, extractTask,
  runNodesParallel, nodeIndex} from '../scripts/libtv_batch_generate.mjs';

test('LibTV binds image nodes in order and preserves model display names', () => {
  assert.equal(defaultLibtvModel('seedance-2-mini'), 'Seedance 2.0 Mini');
  assert.equal(bindPrompt('  镜头说明  ', ['board', 'product']),
    '参考图已按严格顺序绑定：{{Node board}}、{{Node product}}。\n\n镜头说明');
  const args = videoNodeArguments({projectUuid: 'p', name: 'S01', prompt: 'x', orderedNodeKeys: ['a','b'],
    model: 'Seedance 2.0 Mini', duration: 5, ratio: '9:16', resolution: '720p', x: 0, y: 0});
  assert.deepEqual(args.slice(-4), ['--left','a','--left','b']);
  assert.throws(() => nodeIndex({nodes: [{name:'a',id:'1'},{name:'a',id:'2'}]}), /重复/);
});
test('LibTV parallel node results separate terminal failure', async () => {
  const seen = [];
  const client = {async runVideoNode(_project, node) {
    seen.push(node); await new Promise(resolve => setTimeout(resolve, 10));
    return node === 'bad' ? {data: {taskInfo: {status: 3}}} :
      {data: {taskInfo: {status: 2, taskId: node}, url: [`https://example.com/${node}.mp4`]}};
  }};
  const result = await runNodesParallel(client, 'p', {1:'good', 2:'bad'}, {maxWorkers: 2});
  assert.deepEqual(seen, ['good','bad']);
  assert.equal(result.completed['1'].taskId, 'good');
  assert.match(result.errors['2'], /未成功完成/);
  assert.equal(extractTask({data: {taskInfo: {status: 2}, url: ['https://example.com/a']}}).remoteUrl,
    'https://example.com/a');
});
