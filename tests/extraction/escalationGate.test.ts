import test from 'node:test';
import assert from 'node:assert/strict';
import { decideEscalation } from '../../src/extraction/escalationGate.ts';
import type { ExtractionResult } from '../../src/extraction/extractionTypes.ts';

function baseResult(over: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    type: 'task',
    action: 'call',
    title: 'call Ahmad',
    person: null,
    dueAt: '2026-08-22T15:00:00.000Z',
    remindAt: '2026-08-22T14:00:00.000Z',
    priority: { level: 'normal', source: 'inferred', pressureAllowed: true, pressureImplied: false },
    flexibility: 'movable',
    confidence: { overall: 0.9, type: 0.9, action: 0.9, time: 0.9, priority: 0.8 },
    missingFields: [],
    ambiguityFlags: [],
    ...over,
  } as ExtractionResult;
}

test('a confident single commitment does not escalate', () => {
  assert.equal(decideEscalation(baseResult(), 'call Ahmad tomorrow at 3pm').escalate, false);
});

test('multiple_commitments always escalates — splitting is what we cannot get wrong', () => {
  const d = decideEscalation(
    baseResult({ ambiguityFlags: ['multiple_commitments'] }),
    'work at five then gym at seven',
  );
  assert.equal(d.escalate, true);
  assert.ok(d.reasons.includes('multiple_commitments'));
});

test('low time confidence escalates', () => {
  const d = decideEscalation(
    baseResult({ confidence: { overall: 0.9, type: 0.9, action: 0.9, time: 0.4, priority: 0.8 } }),
    'sometime after work',
  );
  assert.equal(d.escalate, true);
  assert.ok(d.reasons.includes('low_time_confidence'));
});

test('low overall confidence escalates', () => {
  const d = decideEscalation(
    baseResult({ confidence: { overall: 0.5, type: 0.5, action: 0.5, time: 0.9, priority: 0.8 } }),
    'whatever that thing was',
  );
  assert.ok(d.reasons.includes('low_overall_confidence'));
});

test('an unresolved Arabic pronoun escalates even at high confidence', () => {
  const d = decideEscalation(baseResult(), 'بعد ما أخلص شغل بمرّ عليها');
  assert.equal(d.escalate, true);
  assert.ok(d.reasons.includes('unresolved_reference'));
});

test('all firing reasons are reported, not just the first', () => {
  const d = decideEscalation(
    baseResult({
      ambiguityFlags: ['multiple_commitments'],
      confidence: { overall: 0.4, type: 0.4, action: 0.4, time: 0.3, priority: 0.8 },
    }),
    'بمرّ عليها بعدين',
  );
  assert.ok(d.reasons.length >= 3, `expected several reasons, got ${d.reasons.join(',')}`);
});
