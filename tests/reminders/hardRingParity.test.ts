/**
 * Postponed Must commitments, server side (council verdict B, #198).
 *
 * Reads the same table the phone's Jest test reads
 * (`mobile/src/features/reminders/__fixtures__/hardRingParity.json`), through
 * both places the server decides: the index (`hardFireAtFor`) and the job's
 * send-time recheck (`decideHardReminder`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deadlineOfTimeSpec, isTimedWindow, type Commitment } from '../../src/domain/stateMachine.ts';
import { phoneReminderEngine } from '../support/phoneReminderEngine.ts';
import { hardFireAtFor, type HardReminderEntry } from '../../lib/services/reminders/hardReminderIndex.ts';
import { decideHardReminder } from '../../lib/services/reminders/hardReminderJob.ts';
import { hardSettingsOfUser } from '../../lib/services/mobile/reminderSettingsService.ts';
import { buildRoutineProfile } from '../../src/contracts/v1/routineContracts.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const table = JSON.parse(readFileSync(
  join(repoRoot, 'mobile/src/features/reminders/__fixtures__/hardRingParity.json'), 'utf8',
)) as { cases: Case[] };

interface Case {
  name: string; startsAt: string; allDay: boolean; postponedUntil: string | null; rings: boolean; fireAt: string | null;
  softEnabled?: boolean; intensity?: string; hardEnabled?: boolean; escalationCeiling?: string;
}

/**
 * The settings as a stored user document, resolved through the server's own
 * reader — so the table checks the resolution as well as the predicate.
 */
function settingsFor(c: Case) {
  return hardSettingsOfUser({
    reminderSettings: {
      softEnabled: c.softEnabled ?? true,
      softLeadMinutes: 60,
      hardEnabled: c.hardEnabled ?? true,
      escalationCeiling: c.escalationCeiling ?? 'hard',
      mustThroughQuietHours: false,
      updatedAt: '2026-09-01T00:00:00.000Z',
    },
    profile: {
      routine: buildRoutineProfile({
        timezone: 'UTC', sleepWindow: null, focusWindows: [], fixedCommitmentWindows: [],
        preferredReminderIntensity: (c.intensity ?? 'softAwareness') as 'softAwareness',
        quietHours: null, surveySkipped: false,
      }, '2026-09-01T00:00:00.000Z'),
    },
  });
}

function commitmentFor(c: Case): Commitment {
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
  assert.ok(table.cases.length >= 18);
  assert.ok(table.cases.some((c) => c.rings) && table.cases.some((c) => !c.rings));
});

for (const c of table.cases) {
  test(`index: ${c.name}`, () => {
    assert.equal(hardFireAtFor(commitmentFor(c), settingsFor(c)), c.fireAt);
  });
}

test('send-time recheck: a postponement or a setting that lands after the row was written cancels the backup', () => {
  for (const c of table.cases.filter((row) => !row.rings && !row.allDay)) {
    // The row the index held before the postpone.
    const fireAt = new Date(Date.parse(c.startsAt) - 10 * 60_000).toISOString();
    const entry: HardReminderEntry = {
      commitmentId: 'm1', fireAt, startFingerprint: c.startsAt, status: 'pending', updatedAt: '', expiresAt: '',
    };
    const decision = decideHardReminder({
      entry, commitment: commitmentFor(c), settings: settingsFor(c), receiptDevice: null, now: new Date(Date.parse(fireAt)),
    });
    assert.equal(decision.kind, 'cancel', c.name);
  }
});

test('a meeting\'s prep step made a Must counts its ring back from the meeting, as the phone does (FX1)', () => {
  // Shown at 14:00, done by the 15:00 start: the phone's `startOf` anchors at
  // the end, so the server's backup must too, or it would fire an hour early.
  const prep = commitmentFor({ name: 'prep', startsAt: '2026-09-28T11:00:00.000Z', allDay: false, postponedUntil: null, rings: true, fireAt: null });
  prep.timeSpec = { ...prep.timeSpec, kind: 'due_by', endAt: '2026-09-28T12:00:00.000Z' };
  assert.equal(hardFireAtFor(prep, settingsFor({ name: 'prep', startsAt: '', allDay: false, postponedUntil: null, rings: true, fireAt: null })), '2026-09-28T11:50:00.000Z');
  // An event's end is not a deadline: a two-hour event still rings before it starts.
  const event = commitmentFor({ name: 'event', startsAt: '2026-09-28T11:00:00.000Z', allDay: false, postponedUntil: null, rings: true, fireAt: null });
  event.timeSpec = { ...event.timeSpec, endAt: '2026-09-28T13:00:00.000Z' };
  assert.equal(hardFireAtFor(event, settingsFor({ name: 'event', startsAt: '', allDay: false, postponedUntil: null, rings: true, fireAt: null })), '2026-09-28T10:50:00.000Z');
});

/**
 * One rule on each side, run on the same stored commitments (FX1, ruling R1).
 *
 * The server's `deadlineOfTimeSpec` / `isTimedWindow` / `hardFireAtFor` and the
 * phone's `startOf` / `opensAtOf` / `planFor` (through `desiredRequests`, as it
 * ships — pure modules only, see `phoneReminderEngine.ts`) must agree on what a
 * commitment is counted back from, where a window opens, and when a Must
 * rings, or the phone and its server backup ring at different moments.
 */
test('parity: the server and the phone read the same deadline, opening and Must ring off one stored commitment', async () => {
  const phone = await phoneReminderEngine();
  const base = commitmentFor({ name: 'x', startsAt: '2026-09-28T12:00:00.000Z', allDay: false, postponedUntil: null, rings: true, fireAt: null });
  const at = (timeSpec: Partial<Commitment['timeSpec']>, level: 'high' | 'normal' = 'high'): Commitment => ({
    ...base, priority: { ...base.priority, level }, timeSpec: { ...base.timeSpec, ...timeSpec },
  });
  const rows: Array<[string, Commitment]> = [
    ['a prep window, Must', at({ kind: 'due_by', dueAt: '2026-09-28T11:00:00.000Z', endAt: '2026-09-28T12:00:00.000Z' })],
    ['a window opening five minutes before its deadline, Must', at({ kind: 'due_by', dueAt: '2026-09-28T11:55:00.000Z', endAt: '2026-09-28T12:00:00.000Z' })],
    ['a prep window, Should', at({ kind: 'due_by', dueAt: '2026-09-28T11:00:00.000Z', endAt: '2026-09-28T12:00:00.000Z' }, 'normal')],
    ['an ordinary deadline, Must', at({ kind: 'due_by', dueAt: '2026-09-28T12:00:00.000Z', endAt: null })],
    ['an event with an end, Must', at({ kind: 'scheduled_event', dueAt: '2026-09-28T11:00:00.000Z', endAt: '2026-09-28T13:00:00.000Z' })],
    ['an all-day entry, Must', at({ kind: 'due_by', dueAt: '2026-09-27T21:00:00.000Z', endAt: '2026-09-28T21:00:00.000Z', allDay: true, timezone: 'Asia/Jerusalem' })],
  ];
  const settings = { softEnabled: true, softLeadMinutes: 60, intensity: 'strongReminder' as const, escalationCeiling: 'hard' as const, hardEnabled: true, mustThroughQuietHours: false };
  const serverSettings = settingsFor({ name: '', startsAt: '', allDay: false, postponedUntil: null, rings: true, fireAt: null });
  for (const [name, commitment] of rows) {
    const anchors = phone.anchorsOf(commitment);
    assert.equal(anchors.startsAt, deadlineOfTimeSpec(commitment.timeSpec), `${name}: deadline`);
    assert.equal(anchors.opensAt, isTimedWindow(commitment.timeSpec) ? commitment.timeSpec.dueAt : null, `${name}: opening`);
    const strong = phone.requestsFor({
      commitments: phone.toReminderCommitments([commitment]),
      now: new Date('2026-09-26T00:00:00.000Z'), settings, quietHours: null, timeZone: 'UTC',
    }).find((request) => request.stage === 'strong');
    assert.equal(strong ? new Date(strong.plannedAt).toISOString() : null, hardFireAtFor(commitment, serverSettings), `${name}: Must ring`);
  }
});
