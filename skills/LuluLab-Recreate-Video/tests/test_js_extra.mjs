import test from 'node:test';import assert from 'node:assert/strict';
import * as p from '../scripts/service_privacy.mjs';import * as m from '../scripts/model_capabilities.mjs';
test('model aliases and boundaries',()=>{assert.equal(m.normalizeModel('seedance 2 mini'),'seedance-2-mini');assert.equal(m.validateGeneration('seedance-2-mini',15).duration,15);assert.throws(()=>m.validateGeneration('seedance-2-mini',16));assert.equal(m.minimumSegmentCount('seedance-2-mini',31),3);});
test('privacy output filtering',()=>{assert.equal(p.isAuthorizationUnavailable({errorCode:402}),true);assert.equal(p.publicError('insufficient credits'),p.SUPPORT_MESSAGE);assert.deepEqual(p.sanitizePayload({creditBalance:8,task:{status:'ok',积分:100}}),{task:{status:'ok'}});});
