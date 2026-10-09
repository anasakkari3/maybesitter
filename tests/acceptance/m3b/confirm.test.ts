/**
 * M3b Gate B: what the one confirm saves, and how it fails (PLAN-M3b R001,
 * R002, R005, R007, R008, R2-009, R2-015, R3-002, R3-007, R4-001, R5-001,
 * R5-002, R6-001; WIRE-M3b). Gate author: Claude. Every test must fail on
 * 80eea528 for the reason it names.
 *
 * Test seam this gate requires of the builder (named here so it is contract,
 * not a guess): `setCaptureFinalizeFaultForTests(fault)` exported from
 * `lib/services/mobile/mobileCaptureService.ts`, where `fault(step)` returns
 * true to make `finalizeConfirmedCapture` throw just before that step, with
 * `step ∈ 'activate' | 'weeklyBlocks' | 'goalLinks' | 'response'`, and `null`
 * clears it. It stands for "the process died after the transaction".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getAnalyticsEventsFor } from '../../../lib/analytics/eventStore.ts';
import { applyTrustAction, getOrCreateTrust } from '../../../lib/pilot/pilotTrustStore.ts';
import { deleteAccount } from '../../../lib/account/accountDeletion.ts';
import { uidFor } from '../../support/fakeAuth.ts';
import {
  beginRules,
  confirm,
  confirmKey,
  confirmRaw,
  currentStorage,
  editPoint,
  end,
  goalsOf,
  habitsOf,
  keptSeeds,
  savedCommitments,
  savedGoals,
  savedHabits,
  say,
  setSwitches,
  show,
  type Answer,
} from './support.ts';

const WALK = 'بدي أمشي نص ساعة كل يوم الصبح';
const GOAL = 'بدي أنزل بالوزن';
// A clock with its half of the day: an ambiguous «الساعة 4» rightly asks AM/PM (M2) and is not confirmable.
const DOCTOR = 'موعد الدكتور بكرا الساعة 4 المسا';

async function finalizeSeam(): Promise<(fault: ((step: string) => boolean) | null) => void> {
  const module = await import('../../../lib/services/mobile/mobileCaptureService.ts') as Record<string, unknown>;
  const seam = module.setCaptureFinalizeFaultForTests;
  assert.equal(typeof seam, 'function', 'setCaptureFinalizeFaultForTests is not exported (the gate\'s named seam)');
  return seam as (fault: ((step: string) => boolean) | null) => void;
}

/* ── what one confirm saves (R001, R005, R2-015, R002) ───────────────── */

test('R001 R005 a habit-only proposal is confirmable and saves a capture_chat habit with the agreed defaults', async () => {
  const uid = beginRules();
  try {
    const answer = await say(uid, WALK, { locale: 'ar' });
    const habit = habitsOf(answer)[0]!;
    const result = await confirm(uid, answer.proposal!, { habits: [habit.habitItemId] });
    assert.equal(result.status, 200, show(result.body));
    assert.equal(result.body.habitsPersisted?.length, 1, show(result.body));
    const [saved] = await savedHabits(uid);
    assert.ok(saved, 'no habit stored');
    assert.equal(saved!.source, 'capture_chat');
    assert.equal(saved!.durationMinutes, 30);
    assert.equal(saved!.minimumOccurrences, 7);
    assert.equal(saved!.maximumOccurrences, 7);
    assert.equal(saved!.flexibility, 'flexible');
    assert.equal(saved!.recoveryPolicy, 'skip');
    assert.deepEqual(saved!.preferredWindows, [{ start: '06:00', end: '12:00' }]);
    assert.equal(saved!.confirmation.sourceRef, answer.proposal!.proposalId);
    assert.equal(saved!.confirmation.acceptedSuggestedValues, true);
    assert.deepEqual(await savedCommitments(uid), [], 'a habit save wrote a commitment');
  } finally { end(); }
});

test('R005 an edited cadence is saved with acceptedSuggestedValues false', async () => {
  const uid = beginRules();
  try {
    const answer = await say(uid, WALK, { locale: 'ar' });
    const habit = habitsOf(answer)[0]!;
    const edited = await editPoint(uid, answer, { habitItemId: habit.habitItemId }, { cadence: { kind: 'weekly_count', count: 3 } });
    assert.equal(edited.status, 200, show(edited.body));
    const after = edited.body as Answer;
    const result = await confirm(uid, after.proposal!, { habits: [habitsOf(after)[0]!.habitItemId] });
    assert.equal(result.status, 200, show(result.body));
    const [saved] = await savedHabits(uid);
    assert.equal(saved!.confirmation.acceptedSuggestedValues, false);
    assert.equal(saved!.minimumOccurrences, 3);
  } finally { end(); }
});

test('R4-002 an incomplete habit cannot be confirmed: 400 habit_invalid, nothing written', async () => {
  const uid = beginRules();
  try {
    const answer = await say(uid, 'بدي أتعوّد أقرا', { entry: 'habit', locale: 'ar' });
    const habit = habitsOf(answer)[0]!;
    const result = await confirm(uid, answer.proposal!, { habits: [habit.habitItemId] });
    assert.equal(result.status, 400, show(result.body));
    assert.equal(result.body.failureCode, 'habit_invalid');
    assert.deepEqual(await savedHabits(uid), []);
  } finally { end(); }
});

test('R2-015 a goal from the goal entry is saved with capture provenance pointing at the proposal', async () => {
  const uid = beginRules();
  try {
    const answer = await say(uid, GOAL, { entry: 'goal', locale: 'ar' });
    const goal = goalsOf(answer)[0]!;
    const result = await confirm(uid, answer.proposal!, { goals: [goal.goalItemId] });
    assert.equal(result.status, 200, show(result.body));
    assert.equal(result.body.goalsPersisted?.length, 1, show(result.body));
    const goals = await savedGoals(uid);
    assert.equal(goals.length, 1, show(goals));
    assert.ok(goals[0]!.content.includes('أنزل بالوزن'));
    assert.equal(goals[0]!.provenance?.origin, 'capture', show(goals[0]!.provenance));
    assert.equal(goals[0]!.provenance?.originRef, answer.proposal!.proposalId);
    assert.equal(result.body.goalsPersisted[0].goalId, goals[0]!.id);
  } finally { end(); }
});

test('R002 from the thought entry, seeds are saved by the confirm itself, with the proposal as their source', async () => {
  const uid = beginRules();
  try {
    const answer = await say(uid, 'عم بفكر أسافر الصيف الجاي', { entry: 'thought', locale: 'ar' });
    const seed = answer.proposal!.seeds[0]!;
    const result = await confirm(uid, answer.proposal!, { seeds: [seed.seedItemId] });
    assert.equal(result.status, 200, show(result.body));
    assert.equal(result.body.seedsPersisted?.length, 1, show(result.body));
    const kept = await keptSeeds(uid);
    assert.equal(kept.length, 1);
    assert.equal(kept[0]!.sourceRef, answer.proposal!.proposalId);
  } finally { end(); }
});

test('R002 from the generic entry, a seed in the confirm is refused 400 invalid_selection («خلّيه» stays its path)', async () => {
  const uid = beginRules();
  try {
    const answer = await say(uid, 'عم بفكر أسافر الصيف الجاي', { locale: 'ar' });
    const result = await confirm(uid, answer.proposal!, { seeds: [answer.proposal!.seeds[0]!.seedItemId] });
    assert.equal(result.status, 400, show(result.body));
    assert.equal(result.body.failureCode, 'invalid_selection');
    assert.deepEqual(await keptSeeds(uid), []);
  } finally { end(); }
});

/* ── atomicity (R2-009, R007) ────────────────────────────────────────── */

test('R2-009 a mixed commitment + habit confirm is all or nothing: a failing commit writes neither', async () => {
  const uid = beginRules();
  try {
    const answer = await say(uid, `${DOCTOR}، و${WALK}`, { locale: 'ar' });
    const habit = habitsOf(answer)[0];
    const item = answer.proposal!.items[0];
    assert.ok(habit && item, `the mixed message did not give a habit and a commitment: ${show(answer.proposal)}`);
    currentStorage().setBeforeCommitHookForTests(() => { throw new Error('injected commit failure'); });
    const result = await confirm(uid, answer.proposal!, { items: [item!.itemId], habits: [habit!.habitItemId] });
    currentStorage().setBeforeCommitHookForTests(null);
    assert.notEqual(result.status, 200, `a failed commit answered 200: ${show(result.body)}`);
    assert.deepEqual(await savedHabits(uid), [], 'a habit survived a failed confirm');
    assert.deepEqual(await savedCommitments(uid), [], 'a commitment survived a failed confirm');
  } finally { end(); }
});

test('R007 kinds switched off between proposal and confirm: 409 kinds_unavailable, nothing written', async () => {
  const uid = beginRules();
  try {
    const answer = await say(uid, WALK, { locale: 'ar' });
    const habit = habitsOf(answer)[0]!;
    setSwitches({ killed: true });
    const result = await confirm(uid, answer.proposal!, { habits: [habit.habitItemId] });
    assert.equal(result.status, 409, show(result.body));
    assert.equal(result.body.reason, 'kinds_unavailable');
    assert.deepEqual(await savedHabits(uid), []);
  } finally { end(); }
});

test('R007 memory switched off before confirming a goal: 409 goals_unavailable, nothing written', async () => {
  const uid = beginRules();
  try {
    const answer = await say(uid, GOAL, { entry: 'goal', locale: 'ar' });
    const goal = goalsOf(answer)[0]!;
    setSwitches({ memory: false });
    const result = await confirm(uid, answer.proposal!, { goals: [goal.goalItemId] });
    assert.equal(result.status, 409, show(result.body));
    assert.equal(result.body.reason, 'goals_unavailable');
    setSwitches({});
    assert.deepEqual(await savedGoals(uid), []);
  } finally { end(); }
});

/* ── keys, replay and recovery (R3-002, R4-001, R5-001, R6-001) ──────── */

test('R3-002 the same key replays the same body; the same key with another selection is 409 key_reused', async () => {
  const uid = beginRules();
  try {
    const answer = await say(uid, `${DOCTOR}، و${WALK}`, { locale: 'ar' });
    const item = answer.proposal!.items[0]!;
    const habit = habitsOf(answer)[0]!;
    const key = confirmKey('replay');
    const first = await confirm(uid, answer.proposal!, { items: [item.itemId], habits: [habit.habitItemId], key });
    assert.equal(first.status, 200, show(first.body));
    const again = await confirm(uid, answer.proposal!, { items: [item.itemId], habits: [habit.habitItemId], key });
    assert.equal(again.status, 200, show(again.body));
    assert.equal(again.body.replayed, true);
    assert.deepEqual(again.body.habitsPersisted, first.body.habitsPersisted);
    const reused = await confirm(uid, answer.proposal!, { items: [item.itemId], key });
    assert.equal(reused.status, 409, show(reused.body));
    assert.equal(reused.body.reason, 'key_reused');
    assert.equal((await savedHabits(uid)).length, 1, 'a replay wrote a second habit');
  } finally { end(); }
});

test('R4-001 another key on an already-confirmed proposal: 409 proposal_changed with the original, finalized receipt; nothing new written', async () => {
  const uid = beginRules();
  try {
    const answer = await say(uid, WALK, { locale: 'ar' });
    const habit = habitsOf(answer)[0]!;
    const first = await confirm(uid, answer.proposal!, { habits: [habit.habitItemId] });
    assert.equal(first.status, 200, show(first.body));
    const second = await confirm(uid, answer.proposal!, { habits: [habit.habitItemId], key: confirmKey('other') });
    assert.equal(second.status, 409, show(second.body));
    assert.equal(second.body.reason, 'proposal_changed');
    assert.equal(second.body.state, 'confirmed');
    assert.deepEqual(second.body.confirmation?.habitsPersisted, first.body.habitsPersisted, 'the 409 does not carry the original receipt');
    assert.equal((await savedHabits(uid)).length, 1);
  } finally { end(); }
});

test('R5-001 a crash after the transaction, before activation: a recovery confirm returns the full receipt and the commitment is active', async () => {
  const uid = beginRules();
  const seam = await finalizeSeam();
  try {
    const answer = await say(uid, DOCTOR, { locale: 'ar' });
    const item = answer.proposal!.items[0]!;
    const key = confirmKey('crash');
    seam((step) => step === 'activate');
    const crashed = await confirm(uid, answer.proposal!, { items: [item.itemId], key });
    seam(null);
    assert.notEqual(crashed.status, 200, 'the injected finalizer fault did not fire');
    const recovered = await confirm(uid, answer.proposal!, { items: [item.itemId], key });
    assert.equal(recovered.status, 200, show(recovered.body));
    assert.equal(recovered.body.persisted?.length, 1, show(recovered.body));
    const saved = Object.values(await import('../../../lib/services/mobile/participantState.ts').then((m) => m.getParticipantStateSnapshot(uid)).then((s) => s.commitments)) as Array<{ status?: string }>;
    assert.equal(saved.length, 1);
    assert.notEqual(saved[0]!.status, 'pending_confirmation', 'the recovered commitment was never activated');
  } finally { seam(null); end(); }
});

test('R6-001 a crash before goal links: recovery creates exactly the kept link and never a removed one', async () => {
  const uid = beginRules();
  const seam = await finalizeSeam();
  try {
    // Two commitments, each with a goal-link suggestion; the person keeps one link.
    const goalAnswer = await say(uid, GOAL, { entry: 'goal', locale: 'ar' });
    const saveGoal = await confirm(uid, goalAnswer.proposal!, { goals: [goalsOf(goalAnswer)[0]!.goalItemId] });
    assert.equal(saveGoal.status, 200, show(saveGoal.body));
    const answer = await say(uid, 'بكرا الساعة 7 الصبح بمشي ساعة لأنزل بالوزن، وبكرا الساعة 9 الصبح بتمرن لأنزل بالوزن', { locale: 'ar' });
    const linkable = answer.proposal!.items.filter((item: any) => item.goalLink);
    assert.equal(linkable.length, 2, `the two steps were not offered a goal link: ${show(answer.proposal)}`);
    const key = confirmKey('links');
    const body = {
      proposalId: answer.proposal!.proposalId,
      selectedItemIds: linkable.map((item) => item.itemId),
      selectedHabitItemIds: [], selectedGoalItemIds: [], selectedSeedItemIds: [],
      goalLinkItemIds: [linkable[0]!.itemId],
      idempotencyKey: key,
    };
    seam((step) => step === 'goalLinks');
    await confirmRaw(uid, body);
    seam(null);
    const recovered = await confirmRaw(uid, body);
    assert.equal(recovered.status, 200, show(recovered.body));
    const links = recovered.body.goalLinks ?? [];
    assert.deepEqual(links.map((link: any) => link.itemId), [linkable[0]!.itemId], `recovery linked ${show(links)}`);
  } finally { seam(null); end(); }
});

/* ── Stage B coverage (R008, R5-002) ─────────────────────────────────── */

test('R008 another account can neither edit nor confirm the proposal', async () => {
  const uid = beginRules();
  try {
    const answer = await say(uid, WALK, { locale: 'ar' });
    const habit = habitsOf(answer)[0]!;
    const stranger = uidFor('AccM3bStranger');
    const edit = await editPoint(stranger, answer, { habitItemId: habit.habitItemId }, { durationMinutes: 15 });
    assert.notEqual(edit.status, 200, `a stranger edited the proposal: ${show(edit.body)}`);
    const result = await confirm(stranger, answer.proposal!, { habits: [habit.habitItemId] });
    assert.notEqual(result.status, 200, `a stranger confirmed the proposal: ${show(result.body)}`);
    assert.deepEqual(await savedHabits(stranger), []);
    assert.deepEqual(await savedHabits(uid), []);
  } finally { end(); }
});

test('R008 account deletion removes the habit, goal and seed a capture confirm wrote', async () => {
  const uid = beginRules();
  try {
    const habitAnswer = await say(uid, WALK, { locale: 'ar' });
    assert.equal((await confirm(uid, habitAnswer.proposal!, { habits: [habitsOf(habitAnswer)[0]!.habitItemId] })).status, 200);
    const goalAnswer = await say(uid, GOAL, { entry: 'goal', locale: 'ar' });
    assert.equal((await confirm(uid, goalAnswer.proposal!, { goals: [goalsOf(goalAnswer)[0]!.goalItemId] })).status, 200);
    const thought = await say(uid, 'عم بفكر أسافر الصيف الجاي', { entry: 'thought', locale: 'ar' });
    assert.equal((await confirm(uid, thought.proposal!, { seeds: [thought.proposal!.seeds[0]!.seedItemId] })).status, 200);

    // The deletion receipt is peppered (as tests/account/accountDeletion.test.ts sets it).
    const previousPepper = process.env.MAYBESITTER_DELETION_RECEIPT_PEPPER;
    process.env.MAYBESITTER_DELETION_RECEIPT_PEPPER = 'm3b-gate-test-pepper';
    try {
      await deleteAccount(uid, {
        initiatedBy: 'user',
        storage: currentStorage(),
        auth: { async revokeRefreshTokens() {}, async deleteUser() {} } as never,
      });
    } finally {
      if (previousPepper === undefined) delete process.env.MAYBESITTER_DELETION_RECEIPT_PEPPER;
      else process.env.MAYBESITTER_DELETION_RECEIPT_PEPPER = previousPepper;
    }
    const left = currentStorage().pathsForTests().filter((path) => path.includes(uid));
    assert.deepEqual(left, [], `documents left after deletion: ${show(left)}`);
  } finally { end(); }
});

test('R5-002 a thought saved by the confirm records seed_confirmed once; a replay records nothing more', async () => {
  const uid = beginRules();
  try {
    await getOrCreateTrust(uid, new Date().toISOString());
    await applyTrustAction(uid, { type: 'set_analytics_consent', granted: true, at: new Date().toISOString() });
    const answer = await say(uid, 'عم بفكر أسافر الصيف الجاي', { entry: 'thought', locale: 'ar' });
    const key = confirmKey('seed-analytics');
    const seedItemId = answer.proposal!.seeds[0]!.seedItemId;
    assert.equal((await confirm(uid, answer.proposal!, { seeds: [seedItemId], key })).status, 200);
    assert.equal((await confirm(uid, answer.proposal!, { seeds: [seedItemId], key })).status, 200);
    const confirmed = (await getAnalyticsEventsFor(uid)).filter((event) => event.eventName === ('seed_confirmed' as never));
    assert.equal(confirmed.length, 1, `seed_confirmed recorded ${confirmed.length} times`);
    assert.ok(!JSON.stringify(confirmed).includes('أسافر'), 'the telemetry carries the sentence');
  } finally { end(); }
});

/* ── RB-10 (simulator 2026-10-08): a converted point can be saved ─────── */
// The M3b conversion pushed the new commitment into the proposal with no
// result and no commands, so the confirm refused it 400 invalid_selection:
// «حطّها التزام» then «احفظ» could never save anything.

test('SIM-10 a timed thought turned into a commitment is saved without doubt or time words, in ar, en and he', async () => {
  for (const [locale, message, expectedTitle] of [
    ['ar', 'عم بفكر روح عالجيم بكرا الساعة 6 المسا', 'روح عالجيم'],
    ['en', "I'm thinking about going to the gym tomorrow at 6pm", 'going to the gym'],
    ['he', 'אולי אלך לחדר כושר מחר ב-18:00', 'אלך לחדר כושר'],
  ] as const) {
    const uid = beginRules();
    try {
      const answer = await say(uid, message, { entry: 'thought', locale });
      const seed = answer.proposal!.seeds.find((candidate) => candidate.suggestedTime);
      assert.ok(seed, `${locale}: no timed thought: ${show(answer.proposal)}`);
      const edited = await editPoint(uid, answer, { seedItemId: seed!.seedItemId }, { kind: 'commitment' });
      assert.equal(edited.status, 200, show(edited.body));
      const next = edited.body as Answer;
      const item = next.proposal!.items.find((candidate) => candidate.pointId === seed!.pointId);
      assert.equal(item?.title, expectedTitle, `${locale}: ${show(next.proposal)}`);
      const result = await confirm(uid, next.proposal!, { items: [item!.itemId], seeds: [] });
      assert.equal(result.status, 200, show(result.body));
      assert.equal(result.body.persisted?.length, 1, show(result.body));
      const saved = await savedCommitments(uid);
      assert.equal(saved.length, 1, show(saved));
      assert.equal(saved[0]!.title, expectedTitle, `${locale}: ${show(saved[0])}`);
      assert.equal(new Date(saved[0]!.timeSpec.dueAt!).toISOString(), seed!.suggestedTime!.at, show(saved[0]));
    } finally { end(); }
  }
});

test('SIM-10 a structured thought edit saves a clean title in ar, en and he, and never saves an empty title', async () => {
  for (const [locale, message, expectedTitle] of [
    ['ar', 'بفكّر أروح عالجيم', 'أروح عالجيم'],
    ['en', "I'm thinking about calling mom", 'calling mom'],
    ['he', 'אני חושבת על ללכת לחדר כושר', 'ללכת לחדר כושר'],
    ['ar', 'يمكن', 'يمكن'],
  ] as const) {
    const uid = beginRules();
    try {
      const answer = await say(uid, message, { entry: 'thought', locale });
      const seed = answer.proposal!.seeds[0];
      assert.ok(seed, `${locale}: no thought: ${show(answer.proposal)}`);
      const edited = await editPoint(uid, answer, { seedItemId: seed!.seedItemId }, {
        kind: 'commitment',
        time: { at: '2030-01-08T07:00:00.000Z', timeZone: 'Asia/Jerusalem' },
      });
      assert.equal(edited.status, 200, show(edited.body));
      const next = edited.body as Answer;
      const item = next.proposal!.items.find((candidate) => candidate.pointId === seed!.pointId);
      assert.equal(item?.title, expectedTitle, `${locale}: ${show(next.proposal)}`);
      const result = await confirm(uid, next.proposal!, { items: [item!.itemId] });
      assert.equal(result.status, 200, show(result.body));
      assert.equal((await savedCommitments(uid))[0]?.title, expectedTitle);
    } finally { end(); }
  }
});

test('RB-10 a habit turned into a commitment, then given a time, is saved', async () => {
  const uid = beginRules();
  try {
    const answer = await say(uid, WALK, { entry: 'habit', locale: 'ar' });
    const habit = habitsOf(answer)[0];
    assert.ok(habit, `no habit: ${show(answer.proposal)}`);
    const converted = await editPoint(uid, answer, { habitItemId: habit!.habitItemId }, { kind: 'commitment' });
    assert.equal(converted.status, 200, show(converted.body));
    const afterConvert = converted.body as Answer;
    const item = afterConvert.proposal!.items.find((candidate) => candidate.pointId === habit!.pointId);
    assert.ok(item, `the habit did not become a commitment: ${show(afterConvert.proposal)}`);
    const at = '2030-01-08T07:00:00.000Z';
    const timed = await editPoint(uid, afterConvert, { itemId: item!.itemId }, { time: { at, timeZone: 'Asia/Jerusalem' } });
    assert.equal(timed.status, 200, show(timed.body));
    const ready = timed.body as Answer;
    const result = await confirm(uid, ready.proposal!, { items: [item!.itemId] });
    assert.equal(result.status, 200, show(result.body));
    assert.equal(result.body.persisted?.length, 1, show(result.body));
  } finally { end(); }
});

// RB-13 (inspection M3B-A-R6-001): «عدّل» on a timed thought sends a new kind
// and new words together; made a commitment, it must take the words (RB-12's
// rule), in the item and in what the confirm saves.
test('SIM-10 a hand-typed title in the conversion edit is saved exactly, even when it begins with «يمكن»', async () => {
  const uid = beginRules();
  try {
    const answer = await say(uid, 'عم بفكر روح عالجيم بكرا الساعة 6 المسا', { entry: 'thought', locale: 'ar' });
    const seed = answer.proposal!.seeds.find((candidate) => candidate.suggestedTime);
    assert.ok(seed, show(answer.proposal));
    const edited = await editPoint(uid, answer, { seedItemId: seed!.seedItemId }, { kind: 'commitment', text: 'يمكن جيم بكرا' });
    assert.equal(edited.status, 200, show(edited.body));
    const next = edited.body as Answer;
    const item = next.proposal!.items.find((candidate) => candidate.pointId === seed!.pointId);
    assert.equal(item?.title, 'يمكن جيم بكرا', `the words were changed: ${show(next.proposal)}`);
    const result = await confirm(uid, next.proposal!, { items: [item!.itemId], seeds: [] });
    assert.equal(result.status, 200, show(result.body));
    const saved = await savedCommitments(uid);
    assert.equal(saved[0]?.title, 'يمكن جيم بكرا', show(saved));
  } finally { end(); }
});
