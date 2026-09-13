import test from 'node:test';
import assert from 'node:assert/strict';
import { evidenceLabel, evidenceLabels, NEXT_STEP_EVIDENCE_CODES } from '../../lib/services/nextStepEvidence';
import { selectBaselineNextStep, scoreBaselineCandidate, type BaselineCandidate } from '../../lib/services/nextStepBaseline';

/**
 * Evidence codes and the English labels derived from them (UC-2.R3, #173).
 *
 * The phone renders the codes in the user's own language; these labels are for
 * `alphaQualityHarness`, which greps them, and the trace recorder. They used
 * to be assembled by hand next to the codes, which is how the two drift.
 */

const NOW = new Date('2026-09-13T09:00:00.000Z');

function candidate(over: Partial<BaselineCandidate> = {}): BaselineCandidate {
  return {
    commitmentId: 'c1',
    title: 'Send the report',
    confirmed: true,
    status: 'active',
    dueAt: '2026-09-13T15:00:00.000Z',
    remindAt: null,
    importance: 'high', importanceIsStated: true,
    explicitEffortMinutes: null,
    ...over,
  };
}

test('every code has a label, and none of them is empty', () => {
  for (const code of NEXT_STEP_EVIDENCE_CODES) {
    const label = evidenceLabel({ code, params: { level: 'high', minutes: 30 } });
    assert.ok(label.length > 0, `${code} has no label`);
    assert.ok(!label.includes('undefined'), `${code} label leaks undefined: ${label}`);
  }
});

test('the label strings the quality harness greps are unchanged', () => {
  // These exact phrases are matched by `alphaQualityHarness`. Rewording one is
  // a behaviour change there, so it has to be a deliberate edit here.
  assert.deepEqual(evidenceLabels([
    { code: 'overdue' },
    { code: 'due_within_24h' },
    { code: 'due_within_7d' },
    { code: 'importance', params: { level: 'high' } },
    { code: 'effort', params: { minutes: 45 } },
    { code: 'outside_usual_hours' },
    { code: 'short_for_end_of_day' },
    { code: 'fits_before_due' },
    { code: 'usually_finishes' },
    { code: 'often_set_aside' },
    { code: 'usual_productive_time' },
  ]), [
    'overdue',
    'due within 24 hours',
    'due within 7 days',
    'importance: high',
    'effort: 45 minutes',
    'outside your usual hours',
    'short enough for the end of the day',
    'fits before it is due',
    'you usually finish these',
    'you often set these aside',
    'a time you usually get things done',
  ]);
});

test('a scored candidate carries codes and labels that describe the same evidence', () => {
  const score = scoreBaselineCandidate(
    candidate({ explicitEffortMinutes: 20 }),
    NOW,
  );
  assert.deepEqual(score.evidenceLabels, evidenceLabels(score.evidenceCodes));
  assert.deepEqual(score.evidenceCodes.map((item) => item.code), [
    'due_within_24h', 'importance', 'effort',
  ]);
});

test('a past due time reads as overdue, and only that', () => {
  const score = scoreBaselineCandidate(
    candidate({ dueAt: '2026-09-12T09:00:00.000Z', importance: null }),
    NOW,
  );
  assert.deepEqual(score.evidenceCodes, [{ code: 'overdue' }]);
});

test('the recommendation sends codes alongside the summary', () => {
  const selection = selectBaselineNextStep([candidate()], NOW, 'ar', 'p1');
  const explanation = selection.recommendation.explanation;
  assert.ok(explanation, 'expected a ready recommendation');
  assert.deepEqual(explanation.evidenceCodes.map((item) => item.code), ['due_within_24h', 'importance']);
  // The summary stays English on purpose: the phone reads the codes, and the
  // harness reads this.
  assert.equal(explanation.summary, 'Based on due within 24 hours and importance: high.');
  assert.deepEqual(explanation.evidenceLabels, evidenceLabels(explanation.evidenceCodes));
});

test('at most three reasons travel, codes and labels agreeing', () => {
  const score = scoreBaselineCandidate(candidate({ explicitEffortMinutes: 20 }), NOW);
  assert.ok(score.evidenceCodes.length <= 3);
  const selection = selectBaselineNextStep([candidate({ explicitEffortMinutes: 20 })], NOW, 'en', 'p2');
  const explanation = selection.recommendation.explanation!;
  assert.ok(explanation.evidenceCodes.length <= 3);
  assert.equal(explanation.evidenceCodes.length, explanation.evidenceLabels.length);
});
