import test from 'node:test';
import assert from 'node:assert/strict';
import { recordDisagreement, disagreementRate, type DisagreementRecord } from '../../src/extraction/disagreementLog.ts';

const NOW = new Date('2026-08-21T09:00:00.000Z');

function record(id: string): DisagreementRecord {
  return {
    id, recordedAt: NOW.toISOString(), language: 'ar',
    reasons: ['multiple_commitments'], localSplit: 1, remoteSplit: 2, reviewed: false,
  };
}

test('agreement records nothing', () => {
  const result = recordDisagreement({
    id: 'c1', language: 'ar', reasons: ['multiple_commitments'], localSplit: 2,
    verdict: { agrees: true, outcome: 'agreed', correctedSplit: null, correctedTimes: [], note: null },
    now: NOW,
  });
  assert.equal(result, null);
});

test('disagreement is recorded with both splits', () => {
  const result = recordDisagreement({
    id: 'c2', language: 'ar', reasons: ['multiple_commitments'], localSplit: 1,
    verdict: { agrees: false, outcome: 'disagreed', correctedSplit: 3, correctedTimes: ['05:00'], note: 'three' },
    now: NOW,
  });
  assert.equal(result?.localSplit, 1);
  assert.equal(result?.remoteSplit, 3);
  assert.equal(result?.reviewed, false);
  assert.equal(result?.recordedAt, '2026-08-21T09:00:00.000Z');
});

test('a call that never happened is not a disagreement', () => {
  // A timeout, a throw or a refused call leaves agrees true so the local
  // proposal stands -- but it is not a labelled example and must not inflate
  // the disagreement rate the thresholds are tuned against.
  const result = recordDisagreement({
    id: 'c3', language: 'ar', reasons: ['low_time_confidence'], localSplit: 1,
    verdict: { agrees: true, outcome: 'unavailable', correctedSplit: null, correctedTimes: [], note: null },
    now: NOW,
  });
  assert.equal(result, null);
});

test('the record carries neither the sentence nor the note that quotes it', () => {
  // The arbiter writes the note in free text and routinely quotes the sentence
  // back into it. Distinctive sentinels make a leak unambiguous.
  const result = recordDisagreement({
    id: 'c4', language: 'ar', reasons: ['unresolved_reference'], localSplit: 1,
    verdict: {
      agrees: false, outcome: 'disagreed', correctedSplit: 2, correctedTimes: [],
      note: 'SENTINEL_NOTE_9f2a the user meant موعد المستشفى SENTINEL_TITLE_4c7b',
    },
    now: NOW,
  });

  const serialised = JSON.stringify(result);
  assert.ok(!serialised.includes('SENTINEL_NOTE_9f2a'), 'the arbiter note must not be stored');
  assert.ok(!serialised.includes('SENTINEL_TITLE_4c7b'), 'quoted text must not be stored');
  assert.ok(!serialised.includes('موعد المستشفى'), 'the sentence must not be stored');
  assert.ok(!('note' in (result as object)), 'no note field at all');
  // The id is how the sentence is retrieved later, with consent.
  assert.equal(result?.id, 'c4');
});

test('the rate is disagreements over total captures', () => {
  assert.equal(disagreementRate([record('a'), record('b')], 10), 0.2);
});

test('a zero-capture window reports zero, not a division error', () => {
  assert.equal(disagreementRate([], 0), 0);
});

test('the rate never reports more disagreements than captures', () => {
  // A miscounted window would otherwise produce a rate above 1 and quietly
  // corrupt any threshold tuned against it.
  assert.throws(() => disagreementRate([record('a'), record('b')], 1), /captures/);
});
