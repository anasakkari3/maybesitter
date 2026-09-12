import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  countDistinctInstances,
  finalStateFrom,
  finalStatusFromCommitmentStatus,
  jobRanExactlyOnce,
  latestByUpdatedAt,
  possibleFinalStatuses,
  revisionChanged,
  summaryExitCode,
  tallyIdempotency,
} from '../../lib/durability/checks';

// The durability run itself needs a deployed service. These cover the part
// that decides pass or fail, so a red run means the data was wrong rather than
// the script misreading it.

test('counts only real, distinct instance ids', () => {
  assert.equal(countDistinctInstances(['a', 'b', 'a', 'b', 'a']), 2);
  // A staging response without the header is evidence of nothing, not of a
  // third instance.
  assert.equal(countDistinctInstances(['a', null, undefined, '', 'a']), 1);
  assert.equal(countDistinctInstances([]), 0);
});

test('one idempotency key records exactly one decision', () => {
  const responses = [
    { status: 200 },
    ...Array.from({ length: 19 }, () => ({ status: 200, replayed: true })),
  ];
  const tally = tallyIdempotency(responses);
  assert.equal(tally.accepted, 1);
  assert.equal(tally.replayed, 19);
  assert.ok(tally.ok);
});

test('a lost race reported as 409 is acceptable; a second write is not', () => {
  assert.ok(tallyIdempotency([{ status: 200 }, { status: 409 }, { status: 409 }]).ok);
  // Two servers both claiming to have recorded the decision is the failure
  // this whole exercise exists to catch.
  assert.equal(tallyIdempotency([{ status: 200 }, { status: 200 }]).ok, false);
  assert.equal(tallyIdempotency([{ status: 200 }, { status: 500 }]).ok, false);
  assert.equal(tallyIdempotency([{ status: 200, replayed: true }]).ok, false, 'nothing was recorded');
});

test('the commitment ends in the state of the last accepted action', () => {
  const state = finalStateFrom([
    { kind: 'complete', accepted: true, at: '2026-09-11T10:00:00.000Z' },
    { kind: 'postpone', accepted: true, at: '2026-09-11T10:00:02.000Z' },
    { kind: 'complete', accepted: false, at: '2026-09-11T10:00:03.000Z' },
  ]);
  assert.equal(state.status, 'postponed');
  // The event count the script compares against must not include rejections.
  assert.equal(state.acceptedCount, 2);
});

test('server order decides, not the order the client sent', () => {
  const state = finalStateFrom([
    { kind: 'postpone', accepted: true, at: '2026-09-11T10:00:05.000Z' },
    { kind: 'complete', accepted: true, at: '2026-09-11T10:00:01.000Z' },
  ]);
  assert.equal(state.status, 'postponed');
});

test('no accepted action leaves the commitment untouched', () => {
  const state = finalStateFrom([{ kind: 'cancel', accepted: false, at: '2026-09-11T10:00:00.000Z' }]);
  assert.deepEqual(state, { status: 'unchanged', acceptedCount: 0 });
});

test('the surviving consent value is the one stamped last', () => {
  const winner = latestByUpdatedAt([
    { updatedAt: '2026-09-11T10:00:00.000Z', granted: true },
    { updatedAt: '2026-09-11T10:00:09.000Z', granted: false },
    { updatedAt: '2026-09-11T10:00:04.000Z', granted: true },
  ]);
  assert.equal(winner?.granted, false);
  assert.equal(latestByUpdatedAt([]), null);
});

test('a redeploy that did not change the revision proves nothing', () => {
  assert.ok(revisionChanged({ before: 'rev-1', after: 'rev-2' }));
  assert.equal(revisionChanged({ before: 'rev-1', after: 'rev-1' }), false);
  assert.equal(revisionChanged({ before: null, after: 'rev-2' }), false);
});

test('any failed check fails the run', () => {
  assert.equal(summaryExitCode({ checks: { a: 'pass', b: 'pass' } }), 0);
  assert.equal(summaryExitCode({ checks: { a: 'pass', b: 'fail' } }), 1);
});

test('the domain status words are translated, not compared directly', () => {
  // `deferred`/`dropped` are what the domain says; `postponed`/`cancelled` are
  // what finalStateFrom answers. Comparing them raw would pass while wrong.
  assert.equal(finalStatusFromCommitmentStatus('completed'), 'completed');
  assert.equal(finalStatusFromCommitmentStatus('deferred'), 'postponed');
  assert.equal(finalStatusFromCommitmentStatus('dropped'), 'cancelled');
  for (const untouched of ['active', 'draft', 'missed', 'pending_confirmation', '']) {
    assert.equal(finalStatusFromCommitmentStatus(untouched), 'unchanged', untouched);
  }
});

test('a job counts as run exactly once only when one attempt reached a terminal state', () => {
  assert.equal(jobRanExactlyOnce({ status: 'completed', attempts: 1 }), true);
  // A rejected command is still exactly one execution.
  assert.equal(jobRanExactlyOnce({ status: 'failed', attempts: 1 }), true);
  assert.equal(jobRanExactlyOnce({ status: 'completed', attempts: 2 }), false, 'ran twice');
  assert.equal(jobRanExactlyOnce({ status: 'claimed', attempts: 1 }), false, 'never finished');
  assert.equal(jobRanExactlyOnce({ status: 'pending', attempts: 0 }), false, 'never started');
  assert.equal(jobRanExactlyOnce(null), false);
});

test('a tie in the action timestamps admits every tied outcome, and nothing else', () => {
  const at = '2026-09-11T23:28:25.256Z';
  const tied = possibleFinalStatuses([
    { kind: 'complete', accepted: true, at },
    { kind: 'postpone', accepted: true, at },
  ]);
  assert.deepEqual(tied.sort(), ['completed', 'postponed']);

  // No tie: only the genuinely last action is admissible.
  assert.deepEqual(possibleFinalStatuses([
    { kind: 'complete', accepted: true, at: '2026-09-11T23:28:25.100Z' },
    { kind: 'postpone', accepted: true, at: '2026-09-11T23:28:25.200Z' },
  ]), ['postponed']);

  // A rejected action cannot explain a state change.
  assert.deepEqual(possibleFinalStatuses([
    { kind: 'cancel', accepted: false, at },
  ]), ['unchanged']);
  assert.deepEqual(possibleFinalStatuses([]), ['unchanged']);
});
