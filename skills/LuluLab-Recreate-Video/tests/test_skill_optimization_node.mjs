import test from 'node:test';
import assert from 'node:assert/strict';
import {validateSkillOptimizationProposal} from '../scripts/generation_manifest.mjs';

test('skill proposal requires exact quality finding coverage and allows JS source paths', () => {
  const report = {status: 'failed', passed: false, findings: [{message:'bad timing'}], hardFailures: ['timing']};
  const proposal = {proposalVersion: '1.0', candidateId: 'candidate-01', targetSkill: 'LuluLab-Recreate-Video',
    confirmationPhrase: '确认优化 skill', issues: [{issueId:'issue-1', classification:'skill_actionable',
      evidence:'report', reason:'timing', sourceFindingIndices:[0], hardFailureCodes:['timing']}],
    changes: [{changeId:'change-1', path:'scripts/storyboard_cells.mjs', section:'timing', change:'adjust',
      expectedEffect:'correct timing', risks:[], tests:[], addresses:['issue-1']}],
    exclusions:[], acceptanceTests:[]};
  const valid = validateSkillOptimizationProposal(proposal, report, 'candidate-01');
  assert.equal(valid.status, 'proposed');
  assert.deepEqual(valid.paths, ['scripts/storyboard_cells.mjs']);
  assert.throws(() => validateSkillOptimizationProposal({...proposal, issues: [{...proposal.issues[0],
    sourceFindingIndices: []}]}, report, 'candidate-01'), /finding/);
});
