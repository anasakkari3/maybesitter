/**
 * QA v3 V3-F35-08: «شو بيعرف عنك» said «التزامات أكّدتها: 4» while «أشيائي»
 * showed 3 — a commitment the person deleted («احذفها», status `archived`)
 * was still counted. A deleted commitment is not something MaybeSitter keeps
 * knowing about; finished and dropped ones were confirmed and still count.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyParticipantCommands } from '../../lib/services/mobile/participantState.ts';
import { NOW, TOMORROW, addCommitment, at, begin, call, end, show } from '../acceptance/m5b/support.ts';

test('the confirmed-commitment count leaves out a deleted commitment and keeps finished and dropped ones', async () => {
  const uid = await begin();
  try {
    const kept = await addCommitment(uid, 'Call the bank', { kind: 'due_by', dueAt: at(TOMORROW, '12:00') });
    const done = await addCommitment(uid, 'Pay rent', { kind: 'due_by', dueAt: at(TOMORROW, '13:00') });
    const dropped = await addCommitment(uid, 'Buy a lamp', { kind: 'due_by', dueAt: at(TOMORROW, '14:00') });
    const deleted = await addCommitment(uid, 'Typo item', { kind: 'due_by', dueAt: at(TOMORROW, '15:00') });
    void kept;
    await applyParticipantCommands(uid, [
      { type: 'Complete', commitmentId: done, now: NOW() } as any,
      { type: 'Drop', commitmentId: dropped, now: NOW() } as any,
      { type: 'Delete', commitmentId: deleted, now: NOW() } as any,
    ]);
    const trust = await call(uid, 'pilot/trust', 'GET');
    assert.equal(trust.status, 200, show(trust.body));
    assert.equal(trust.body.whatKnows?.confirmedCommitmentCount, 3, show(trust.body.whatKnows));
  } finally {
    end();
  }
});
