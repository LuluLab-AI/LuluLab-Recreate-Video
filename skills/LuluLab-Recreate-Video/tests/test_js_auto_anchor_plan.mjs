import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan } from '../scripts/auto_anchor_plan.mjs';

test('nine-anchor plan matches saved Python output for two segments', () => {
  const analysis = {
    recommendedSegments: [{ segmentId: 1, globalStart: 0, globalEnd: 8 },
      { segmentId: 2, globalStart: 8, globalEnd: 16 }],
    visualScan: { fps: 4, samples: Array.from({ length: 63 }, (_, i) => ({
      timestamp: (i + 1) / 4, qualityScore: (i % 7) / 7, changeScore: (i % 5) / 5,
    })) },
    visualCandidates: Array.from({ length: 47 }, (_, i) => ({
      timestamp: (i + 1) / 3, eventType: i % 3 === 0 ? 'cut' : 'visual_change',
      changeScore: (i % 7) / 7, qualityScore: (i % 5) / 5,
    })),
    candidateCuts: [0, 8, 12],
  };
  const plan = buildPlan(analysis);
  assert.deepEqual(plan.segments.map(segment => segment.anchors.map(anchor => anchor.timestamp)), [
    [0, 0.75, 1.75, 2.333, 3, 4.333, 5.25, 6.5, 7.92],
    [8, 9.333, 10.5, 11.333, 11.667, 13.333, 14, 15.25, 15.92],
  ]);
  assert.equal(plan.segments[0].anchors[0].eventType, 'first_frame');
  assert.equal(plan.segments[1].anchors[0].eventType, 'cut');
  assert.equal(plan.selectionMethod, 'single-pass-visual-hook-coverage-v1');
});

test('planner rejects invalid segment windows', () => {
  assert.throws(() => buildPlan({ recommendedSegments: [] }), /recommendedSegments/);
  assert.throws(() => buildPlan({ recommendedSegments: [{ globalStart: 1, globalEnd: 1 }] }), /globalEnd/);
});
