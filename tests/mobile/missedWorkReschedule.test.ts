/**
 * Lane E4 (spec 2026-11-12 item 4, owner answer of 2026-11-13): a missed piece
 * of work that is neither a deadline nor an appointment gets a real new plan,
 * proposed and never applied until the person accepts, and undoable for 24
 * hours after.
 *
 * Real routes in process, fake auth, memory storage; the clock is pinned to
 * Wednesday 2026-10-07 10:00 Jerusalem by the M4b harness.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  addCommitment,
  addEvent,
  addTimedDeadline,
  at,
  begin,
  call,
  commitment,
  allCommitments,
  currentStorage,
  end,
  TODAY,
  TZ,
} from '../acceptance/m4b/support.ts';
import { PLANS, userDoc, userCol, userSubDoc, RESCHEDULE_PROPOSALS } from '../../lib/storage/paths.ts';
import { applyParticipantCommands } from '../../lib/services/mobile/participantState.ts';
import { acceptReschedule, dismissReschedule, listRescheduleProposals, undoReschedule } from '../../lib/planning/missedWorkReschedule.ts';
import { uidFor } from '../support/fakeAuth.ts';
import { isEventCommitment } from '../../lib/services/commitments/eventEnded.ts';
import { setFreeSlotSourceFailureForTests, setScheduleDecisionHookForTests } from '../../lib/planning/freeSlots.ts';
import { AccountUnavailableError } from '../../lib/account/accountLiveness.ts';
import { seedLiveAccount } from '../support/liveAccount.ts';

const YESTERDAY = '2026-10-06';
const IDS = [
  '7e000000-0000-4000-8000-000000000001',
  '7e000000-0000-4000-8000-000000000002',
  '7e000000-0000-4000-8000-000000000003',
  '7e000000-0000-4000-8000-000000000004',
  '7e000000-0000-4000-8000-000000000005',
];

function on(): string {
  const uid = begin();
  process.env.MAYBESITTER_FEATURE_MISSED_RESCHEDULE = 'true';
  process.env.MAYBESITTER_KILL_SWITCH_MISSED_RESCHEDULE = 'false';
  return uid;
}
function off(): void {
  delete process.env.MAYBESITTER_FEATURE_MISSED_RESCHEDULE;
  delete process.env.MAYBESITTER_KILL_SWITCH_MISSED_RESCHEDULE;
  end();
}
async function withTimezone(uid: string): Promise<void> {
  await seedLiveAccount(uid);
  const user = await currentStorage().get<Record<string, unknown>>(userDoc(uid));
  await currentStorage().set(userDoc(uid), { ...user, timezone: TZ });
}
async function scenario(run: (uid: string) => Promise<void>): Promise<void> {
  const uid = on();
  try {
    await withTimezone(uid);
    await run(uid);
  } finally { off(); }
}

/** A study session at a stated hour: a task given an hour, not an appointment. */
function addStudy(uid: string, date: string, start: string, endTime: string, title = 'أدرس رياضيات'): Promise<string> {
  return addCommitment(uid, title, { kind: 'scheduled_event', dueAt: at(date, start), endAt: at(date, endTime), allDay: false, itemKind: 'task' });
}
const list = (uid: string) => call(uid, 'reschedule', 'GET');
const decide = (uid: string, id: string, body: Record<string, unknown>) => call(uid, 'reschedule/[commitmentId]', 'POST', { params: { commitmentId: id }, body });

test('a missed study session gets a proposal in real free time, and nothing changes before accepting', async () => {
  await scenario(async (uid) => {
    const id = await addStudy(uid, YESTERDAY, '18:00', '19:00');
    await addEvent(uid, 'تدريب', at(TODAY, '17:00'), at(TODAY, '18:30'));
    const before = await commitment(uid, id);
    const answer = await list(uid);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    const proposal = answer.body.proposal;
    assert.equal(proposal.commitmentId, id);
    assert.equal(proposal.reason, 'first_miss');
    assert.deepEqual(proposal.changes, ['new_time']);
    assert.equal(proposal.missCount, 1);
    assert.equal(proposal.missedAt, at(YESTERDAY, '18:00'));
    // The evening is kept (the person chose it); 17:00-18:30 is taken.
    assert.deepEqual(proposal.sessions.map((s: any) => [s.startsAt, s.endsAt]), [[at(TODAY, '18:30'), at(TODAY, '19:30')]]);
    assert.equal(proposal.sessions[0].localTime, '18:30');
    assert.equal(typeof proposal.proposalId, 'string');
    assert.deepEqual(await commitment(uid, id), before, 'a proposal must not change the commitment');
    assert.equal((await currentStorage().list(userCol(uid, RESCHEDULE_PROPOSALS))).length, 0, 'reading a proposal writes nothing');
  });
});

test('the stored day plan is busy time too', async () => {
  await scenario(async (uid) => {
    await addStudy(uid, YESTERDAY, '18:00', '19:00');
    // Today's plan placed other work at 17:00-19:00; a minimal stored plan.
    await currentStorage().set(userSubDoc(uid, PLANS, TODAY), {
      date: TODAY, timezone: TZ,
      plan: { scheduled: [{ itemId: 'other-work', interval: { startsAt: at(TODAY, '17:00'), endsAt: at(TODAY, '19:00') } }] },
    });
    const proposal = (await list(uid)).body.proposal;
    assert.deepEqual(proposal.sessions.map((s: any) => s.startsAt), [at(TODAY, '19:00')]);
  });
});

test('appointments, deadlines, unfinished-in-time work and done work get no proposal', async () => {
  await scenario(async (uid) => {
    await addEvent(uid, 'اجتماع مع سامي', at(YESTERDAY, '09:00'), at(YESTERDAY, '10:00'));
    await addTimedDeadline(uid, 'تسليم البحث', at(YESTERDAY, '12:00'));
    await addStudy(uid, TODAY, '15:00', '16:00');
    await addStudy(uid, TODAY, '09:30', '10:30', 'أكتب التقرير'); // under way at 10:00, not missed yet
    const done = await addStudy(uid, YESTERDAY, '18:00', '19:00');
    await applyParticipantCommands(uid, [{ type: 'Complete', commitmentId: done, now: new Date().toISOString() } as any]);
    const answer = await list(uid);
    assert.equal(answer.status, 200);
    assert.equal(answer.body.proposal, null);
  });
});

test('accept moves the work through the domain commands, once, and offers undo for 24 hours', async () => {
  await scenario(async (uid) => {
    const id = await addStudy(uid, YESTERDAY, '18:00', '19:00');
    const proposal = (await list(uid)).body.proposal;
    const accepted = await decide(uid, id, { action: 'accept', proposalId: proposal.proposalId, clientActionId: IDS[0] });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.state, 'accepted');
    assert.equal(accepted.body.undoUntil, new Date(Date.parse(new Date().toISOString()) + 24 * 3_600_000).toISOString());
    const moved = await commitment(uid, id);
    assert.equal(moved.timeSpec.dueAt, proposal.sessions[0].startsAt);
    assert.equal(moved.timeSpec.endAt, proposal.sessions[0].endsAt);
    assert.equal(moved.status, 'active');

    const replay = await decide(uid, id, { action: 'accept', proposalId: proposal.proposalId, clientActionId: IDS[0] });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    const reused = await decide(uid, id, { action: 'dismiss', clientActionId: IDS[0] });
    assert.equal(reused.status, 409);

    const after = (await list(uid)).body;
    assert.equal(after.proposal, null, 'an accepted plan is not proposed again');
    assert.equal(after.accepted.length, 1);
    assert.equal(after.accepted[0].commitmentId, id);
    assert.equal(after.accepted[0].undoUntil, accepted.body.undoUntil);
  });
});

test('a proposal that went stale is refused with the fresh one', async () => {
  await scenario(async (uid) => {
    const id = await addStudy(uid, YESTERDAY, '18:00', '19:00');
    const proposal = (await list(uid)).body.proposal;
    await addEvent(uid, 'عشا', proposal.sessions[0].startsAt, proposal.sessions[0].endsAt);
    const refused = await decide(uid, id, { action: 'accept', proposalId: proposal.proposalId, clientActionId: IDS[1] });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, 'proposal_stale');
    assert.notEqual(refused.body.proposal.proposalId, proposal.proposalId);
    assert.equal((await commitment(uid, id)).timeSpec.dueAt, at(YESTERDAY, '18:00'));
  });
});

test('a slot taken while accepting is caught inside the transaction', async () => {
  await scenario(async (uid) => {
    const id = await addStudy(uid, YESTERDAY, '18:00', '19:00');
    const proposal = (await list(uid)).body.proposal;
    const slot = proposal.sessions[0];
    let raced = false;
    setScheduleDecisionHookForTests(async (site) => {
      if (site !== 'reschedule' || raced) return;
      raced = true;
      await addEvent(uid, 'عشا', slot.startsAt, slot.endsAt);
    });
    try {
      const refused = await decide(uid, id, { action: 'accept', proposalId: proposal.proposalId, clientActionId: IDS[0] });
      assert.equal(raced, true);
      assert.equal(refused.status, 409, JSON.stringify(refused.body));
      assert.equal(refused.body.error, 'proposal_stale');
    } finally { setScheduleDecisionHookForTests(null); }
    assert.equal((await commitment(uid, id)).timeSpec.dueAt, at(YESTERDAY, '18:00'));
  });
});

test('undo puts the work back as it was and is not offered twice', async () => {
  await scenario(async (uid) => {
    const id = await addStudy(uid, YESTERDAY, '18:00', '19:00');
    const before = await commitment(uid, id);
    const proposal = (await list(uid)).body.proposal;
    await decide(uid, id, { action: 'accept', proposalId: proposal.proposalId, clientActionId: IDS[0] });
    const undone = await decide(uid, id, { action: 'undo', clientActionId: IDS[1] });
    assert.equal(undone.status, 200, JSON.stringify(undone.body));
    assert.equal(undone.body.state, 'undone');
    const back = await commitment(uid, id);
    assert.equal(back.timeSpec.dueAt, before.timeSpec.dueAt);
    assert.equal(back.timeSpec.endAt, before.timeSpec.endAt);
    assert.equal(back.postponedUntil, null);
    const again = await decide(uid, id, { action: 'undo', clientActionId: IDS[2] });
    assert.equal(again.status, 409);
    assert.equal(again.body.error, 'undo_unavailable');
    const after = (await list(uid)).body;
    assert.equal(after.proposal, null, 'an undone proposal does not come straight back');
    assert.deepEqual(after.accepted, []);
  });
});

test('undo is refused once 24 hours have passed', async () => {
  await scenario(async (uid) => {
    const id = await addStudy(uid, YESTERDAY, '18:00', '19:00');
    const proposal = (await list(uid)).body.proposal;
    await decide(uid, id, { action: 'accept', proposalId: proposal.proposalId, clientActionId: IDS[0] });
    const late = new Date(Date.now() + 24 * 3_600_000 + 1_000);
    await assert.rejects(undoReschedule(uid, id, { clientActionId: IDS[1], now: late }), /undo_unavailable/);
    const listed = await listRescheduleProposals(uid, { now: late });
    assert.deepEqual(listed.accepted, []);
  });
});

test('a second miss in the same part of the day moves the work to another part of the day', async () => {
  await scenario(async (uid) => {
    const id = await addStudy(uid, YESTERDAY, '18:00', '19:00');
    const first = (await list(uid)).body.proposal;
    await decide(uid, id, { action: 'accept', proposalId: first.proposalId, clientActionId: IDS[0] });
    // The new evening slot passes undone too.
    mock.timers.setTime(Date.parse(at('2026-10-08', '08:00')));
    const second = (await list(uid)).body.proposal;
    assert.equal(second.commitmentId, id);
    assert.equal(second.missCount, 2);
    assert.equal(second.reason, 'same_time_again');
    assert.ok(second.changes.includes('other_time_of_day'));
    assert.equal(second.fromDayPart, 'evening');
    assert.notEqual(second.toDayPart, 'evening');
    const records = await currentStorage().list<any>(userCol(uid, RESCHEDULE_PROPOSALS));
    assert.deepEqual(records[0]!.data.misses.map((m: any) => m.startsAt), [at(YESTERDAY, '18:00')], 'the first miss is in the history');
  });
});

test('a repeated miss splits long work into two smaller pieces; undo removes the added piece', async () => {
  await scenario(async (uid) => {
    const id = await addStudy(uid, YESTERDAY, '09:00', '10:30');
    const first = (await list(uid)).body.proposal;
    assert.equal(first.toDayPart, 'morning');
    await decide(uid, id, { action: 'accept', proposalId: first.proposalId, clientActionId: IDS[0] });
    mock.timers.setTime(Date.parse(at('2026-10-09', '07:00')));
    const second = (await list(uid)).body.proposal;
    assert.equal(second.missCount, 2);
    assert.ok(second.changes.includes('smaller_pieces'));
    assert.equal(second.sessions.length, 2);
    assert.equal(second.minutesEach, 45);
    assert.equal(second.minutesBefore, 90);
    assert.notEqual(second.sessions[0].localDate, second.sessions[1].localDate);
    const accepted = await decide(uid, id, { action: 'accept', proposalId: second.proposalId, clientActionId: IDS[1] });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    const active = (await allCommitments(uid)).filter((row) => row.status === 'active');
    assert.equal(active.length, 2);
    assert.ok(active.every((row) => row.title === 'أدرس رياضيات'));
    assert.deepEqual(active.map((row) => row.timeSpec.dueAt).sort(), second.sessions.map((s: any) => s.startsAt).sort());
    const undone = await decide(uid, id, { action: 'undo', clientActionId: IDS[2] });
    assert.equal(undone.status, 200, JSON.stringify(undone.body));
    const left = (await allCommitments(uid)).filter((row) => row.status === 'active');
    assert.deepEqual(left.map((row) => row.id), [id]);
  });
});

test('work that gains an end stays work, not an appointment that leaves Today', async () => {
  await scenario(async (uid) => {
    // An hour with no end and no stored kind: a task by its title (E1's fallback).
    const id = await addCommitment(uid, 'أدرس فيزيا', { kind: 'scheduled_event', dueAt: at(YESTERDAY, '18:00'), allDay: false });
    const first = (await list(uid)).body.proposal;
    await decide(uid, id, { action: 'accept', proposalId: first.proposalId, clientActionId: IDS[0] });
    assert.equal((await commitment(uid, id)).timeSpec.endAt, null, 'an unchanged length keeps no end');
    mock.timers.setTime(Date.parse(at('2026-10-09', '07:00')));
    const second = (await list(uid)).body.proposal;
    assert.equal(second.minutesEach, 15);
    await decide(uid, id, { action: 'accept', proposalId: second.proposalId, clientActionId: IDS[1] });
    const moved = await commitment(uid, id);
    assert.equal(moved.timeSpec.endAt, second.sessions[0].endsAt);
    assert.equal(moved.timeSpec.itemKind, 'task');
    assert.equal(isEventCommitment(moved), false);
  });
});

test('undo is not offered once the added piece was done', async () => {
  await scenario(async (uid) => {
    const id = await addStudy(uid, YESTERDAY, '09:00', '10:30');
    const first = (await list(uid)).body.proposal;
    await decide(uid, id, { action: 'accept', proposalId: first.proposalId, clientActionId: IDS[0] });
    mock.timers.setTime(Date.parse(at('2026-10-09', '07:00')));
    const second = (await list(uid)).body.proposal;
    await decide(uid, id, { action: 'accept', proposalId: second.proposalId, clientActionId: IDS[1] });
    const piece = (await allCommitments(uid)).find((row) => row.id !== id && row.status === 'active')!;
    await applyParticipantCommands(uid, [{ type: 'Complete', commitmentId: piece.id, now: new Date().toISOString() } as any]);
    const refused = await decide(uid, id, { action: 'undo', clientActionId: IDS[2] });
    assert.equal(refused.status, 409);
    assert.equal((await allCommitments(uid)).find((row) => row.id === piece.id)!.status, 'completed', 'done work is never undone');
  });
});

test('dismiss records the miss and hides the proposal without touching the work', async () => {
  await scenario(async (uid) => {
    const id = await addStudy(uid, YESTERDAY, '18:00', '19:00');
    const before = await commitment(uid, id);
    const dismissed = await decide(uid, id, { action: 'dismiss', clientActionId: IDS[0] });
    assert.equal(dismissed.status, 200, JSON.stringify(dismissed.body));
    assert.equal(dismissed.body.state, 'dismissed');
    assert.deepEqual(await commitment(uid, id), before);
    assert.equal((await list(uid)).body.proposal, null);
    const records = await currentStorage().list<any>(userCol(uid, RESCHEDULE_PROPOSALS));
    assert.equal(records[0]!.data.misses.length, 1);
  });
});

test('dismissed items do not crowd out older missed work', async () => {
  await scenario(async (uid) => {
    const oldest = await addStudy(uid, '2026-10-03', '18:00', '19:00', 'أقرا فصل');
    const newer = [
      await addStudy(uid, '2026-10-04', '18:00', '19:00', 'أحل تمارين'),
      await addStudy(uid, '2026-10-05', '18:00', '19:00', 'أراجع'),
      await addStudy(uid, YESTERDAY, '18:00', '19:00'),
    ];
    for (let index = 0; index < newer.length; index += 1) {
      assert.equal((await decide(uid, newer[index]!, { action: 'dismiss', clientActionId: IDS[index] })).status, 200);
    }
    assert.equal((await list(uid)).body.proposal?.commitmentId, oldest);
  });
});

test('a dismissed proposal cannot be accepted afterwards', async () => {
  await scenario(async (uid) => {
    const id = await addStudy(uid, YESTERDAY, '18:00', '19:00');
    const proposal = (await list(uid)).body.proposal;
    await decide(uid, id, { action: 'dismiss', clientActionId: IDS[0] });
    const refused = await decide(uid, id, { action: 'accept', proposalId: proposal.proposalId, clientActionId: IDS[1] });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, 'proposal_stale');
    assert.equal(refused.body.proposal, null);
    assert.equal((await commitment(uid, id)).timeSpec.dueAt, at(YESTERDAY, '18:00'));
  });
});

test('a busy-time source that cannot be read gives no proposal rather than a guess', async () => {
  await scenario(async (uid) => {
    await addStudy(uid, YESTERDAY, '18:00', '19:00');
    setFreeSlotSourceFailureForTests('busyBlocks');
    try {
      const answer = await list(uid);
      assert.equal(answer.status, 200);
      assert.equal(answer.body.proposal, null);
    } finally { setFreeSlotSourceFailureForTests(null); }
  });
});

test('another account neither sees nor decides the proposal', async () => {
  await scenario(async (uid) => {
    const id = await addStudy(uid, YESTERDAY, '18:00', '19:00');
    const proposal = (await list(uid)).body.proposal;
    const other = uidFor('RescheduleOther');
    await withTimezone(other);
    assert.equal((await list(other)).body.proposal, null);
    const refused = await decide(other, id, { action: 'accept', proposalId: proposal.proposalId, clientActionId: IDS[0] });
    assert.equal(refused.status, 404);
    assert.equal((await commitment(uid, id)).timeSpec.dueAt, at(YESTERDAY, '18:00'));
  });
});

test('a deleted account cannot accept (#772)', async () => {
  await scenario(async (uid) => {
    const id = await addStudy(uid, YESTERDAY, '18:00', '19:00');
    const proposal = (await list(uid)).body.proposal;
    const user = await currentStorage().get<any>(userDoc(uid));
    await currentStorage().set(userDoc(uid), { ...user, trust: { ...user.trust, deletedAt: new Date().toISOString() } });
    const refused = await decide(uid, id, { action: 'accept', proposalId: proposal.proposalId, clientActionId: IDS[0] });
    assert.equal(refused.status, 403);
    assert.equal((await commitment(uid, id)).timeSpec.dueAt, at(YESTERDAY, '18:00'));
  });
});

test('the write itself is fenced: a deletion between proposal and accept writes nothing (#772)', async () => {
  await scenario(async (uid) => {
    const id = await addStudy(uid, YESTERDAY, '18:00', '19:00');
    const proposal = (await list(uid)).body.proposal;
    const user = await currentStorage().get<any>(userDoc(uid));
    await currentStorage().set(userDoc(uid), { ...user, trust: { ...user.trust, deletedAt: new Date().toISOString() } });
    for (const run of [
      () => acceptReschedule(uid, id, { proposalId: proposal.proposalId, clientActionId: IDS[0] }),
      () => dismissReschedule(uid, id, { clientActionId: IDS[1] }),
    ]) await assert.rejects(run(), AccountUnavailableError);
    assert.equal((await commitment(uid, id)).timeSpec.dueAt, at(YESTERDAY, '18:00'));
    assert.equal((await currentStorage().list(userCol(uid, RESCHEDULE_PROPOSALS))).length, 0);
  });
});

test('bad bodies are 400 and the switch off is 404', async () => {
  await scenario(async (uid) => {
    const id = await addStudy(uid, YESTERDAY, '18:00', '19:00');
    assert.equal((await decide(uid, id, { action: 'later', clientActionId: IDS[0] })).status, 400);
    assert.equal((await decide(uid, id, { action: 'accept', clientActionId: IDS[0] })).status, 400);
    assert.equal((await decide(uid, id, { action: 'dismiss', clientActionId: 'not-a-uuid' })).status, 400);
    process.env.MAYBESITTER_FEATURE_MISSED_RESCHEDULE = 'false';
    assert.equal((await list(uid)).status, 404);
    assert.equal((await decide(uid, id, { action: 'dismiss', clientActionId: IDS[0] })).status, 404);
  });
});
