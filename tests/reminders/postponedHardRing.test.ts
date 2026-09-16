/**
 * Postponed Must commitments, server side (council verdict B, #198).
 *
 * Reads the same table the phone's Jest test reads
 * (`mobile/src/features/reminders/__fixtures__/postponedHardRing.json`), through
 * both places the server decides: the index (`hardFireAtFor`) and the job's
 * send-time recheck (`decideHardReminder`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Commitment } from '../../src/domain/stateMachine.ts';
import { hardFireAtFor, type HardReminderEntry } from '../../lib/services/reminders/hardReminderIndex.ts';
import { decideHardReminder } from '../../lib/services/reminders/hardReminderJob.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const table = JSON.parse(readFileSync(
  join(repoRoot, 'mobile/src/features/reminders/__fixtures__/postponedHardRing.json'), 'utf8',
)) as { cases: Array<{ name: string; startsAt: string; allDay: boolean; postponedUntil: string | null; rings: boolean; fireAt: string | null }> };

const SETTINGS = { hardEnabled: true, escalationCeiling: 'hard' as const, mustThroughQuietHours: false };

function commitmentFor(c: (typeof table.cases)[number]): Commitment {
  return {
    id: 'm1', kind: 'task', title: 'x', description: null, person: null, status: 'active',
    priority: { level: 'high', source: 'user_explicit', pressureAllowed: true, pressureLevel: 'none' },
    category: null, categorySource: 'inferred',
    timeSpec: { kind: 'scheduled_event', dueAt: c.startsAt, endAt: null, remindAt: null, allDay: c.allDay, timezone: 'UTC' },
    currentAckState: c.postponedUntil ? 'postponed' : 'not_seen', postponedUntil: c.postponedUntil,
    createdAt: '', updatedAt: '', confirmedAt: '', completedAt: null, droppedAt: null,
  } as Commitment;
}

test('the shared table has both outcomes', () => {
  assert.ok(table.cases.length >= 10);
  assert.ok(table.cases.some((c) => c.rings) && table.cases.some((c) => !c.rings));
});

for (const c of table.cases) {
  test(`index: ${c.name}`, () => {
    assert.equal(hardFireAtFor(commitmentFor(c), SETTINGS), c.fireAt);
  });
}

test('send-time recheck: a postponement that lands after the row was written cancels the backup', () => {
  for (const c of table.cases.filter((row) => !row.rings && !row.allDay)) {
    // The row the index held before the postpone.
    const fireAt = new Date(Date.parse(c.startsAt) - 10 * 60_000).toISOString();
    const entry: HardReminderEntry = {
      commitmentId: 'm1', fireAt, startFingerprint: c.startsAt, status: 'pending', updatedAt: '', expiresAt: '',
    };
    const decision = decideHardReminder({
      entry, commitment: commitmentFor(c), settings: SETTINGS, receiptDevice: null, now: new Date(Date.parse(fireAt)),
    });
    assert.equal(decision.kind, 'cancel', c.name);
  }
});
