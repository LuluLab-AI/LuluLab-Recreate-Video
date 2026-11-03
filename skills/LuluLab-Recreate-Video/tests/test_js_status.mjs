import test from 'node:test';import assert from 'node:assert/strict';import * as bindings from '../scripts/entity_bindings.mjs';import {summarize} from '../scripts/task_status.mjs';
test('status: initialized',()=>{const s=summarize({});assert.equal(s.status,'initialized');assert.deepEqual(s.readySegmentActions,[]);});
test('status: pending and failed',()=>{assert.equal(summarize({videos:[{segmentId:1,taskId:'t',status:'pending'}]}).status,'video_task_pending');assert.equal(summarize({videos:[{segmentId:1,status:'failed'}]}).status,'segment_terminal_failed');});
test('bindings roster duplicate',()=>{assert.throws(()=>bindings.roster([{characterId:'a'},{characterId:'a'}],'characterId'));});
