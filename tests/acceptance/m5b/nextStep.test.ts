/**
 * M5b-1 Gate B — the next step under energy (PLAN-M5b-1 R4.3 "Gate B";
 * M5B-005, M5B-014, M5B-015, M5B-039, M5B-040, M5B1-001).
 *
 * The real read and decision routes, the baseline arm (no experiment, no
 * pinned arm). Fixtures are built so the arm's own pick is the heavy item:
 * every candidate is due within 24 h with no stated importance, so the
 * baseline's final key (commitment id, code-point order) decides, and the
 * heavy item is created first. Each case asserts that fixture before it
 * asserts the rule.
 *
 * A heavy `due_by` with a known span is necessarily a timed window
 * (`isTimedWindow`: dueAt and endAt), so the plan's "heavy due_by task" and
 * "heavy timed-window due_by (anchor = endAt)" are the same case here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { listRecentNextStepDecisions } from '../../../lib/services/mobile/nextStepDecisionLog.ts';
import {
  REFERENCE,
  TODAY,
  TOMORROW,
  addCommitment,
  at,
  begin,
  checkIn,
  checkInOk,
  commitment,
  decide,
  end,
  grantRecommendations,
  healthSnapshot,
  nextStep,
  plusMinutes,
  plusMs,
  postHealth,
  setClock,
  setM5bSwitches,
  show,
  storeReadingContext,
} from './support.ts';

test.afterEach(() => end());

const MIN = 60_000;

async function account(): Promise<string> {
  const uid = await begin();
  await grantRecommendations(uid);
  return uid;
}

/** A `due_by` window ending at `anchor`, `spanMinutes` long. */
function window(anchor: string, spanMinutes: number) {
  return { kind: 'due_by', dueAt: plusMinutes(anchor, -spanMinutes), endAt: anchor, allDay: false };
}

/** A task given an hour (not a named event): a `scheduled_event` starting at `start`. */
function taskAt(start: string, spanMinutes: number) {
  return { kind: 'scheduled_event', dueAt: start, endAt: plusMinutes(start, spanMinutes), allDay: false };
}

/** The lighter alternative: a 30-minute window ending 4 h 30 after REFERENCE. */
async function addLighter(uid: string, spanMinutes = 30): Promise<string> {
  return addCommitment(uid, 'Reply to the landlord', window(plusMinutes(REFERENCE, 270), spanMinutes));
}

async function lowNow(uid: string): Promise<string> {
  return checkInOk(uid, 1, plusMinutes(REFERENCE, -60));
}

function pickOf(body: any): string | null {
  return body.recommendation?.primaryStep?.commitmentId ?? null;
}

function assertNoEffect(body: any, label: string) {
  const energy = body.energy;
  if (energy === undefined) return;
  assert.deepEqual(energy, { band: null, source: 'none', level: null, changedPick: false }, `${label}: an energy effect without a fresh reading`);
}

/** The pick with the switch off (today's behaviour), same state and clock. */
async function offModeRead(uid: string): Promise<any> {
  setM5bSwitches({ on: false });
  const body = await nextStep(uid);
  setM5bSwitches({ on: true });
  return body;
}

/* ── the lighter-first rule ────────────────────────────────────────── */

test('R4.3 low fresh + heavy pick not due soon + a lighter (known ≤ 60 min) candidate → the lighter pick, changedPick true, energy strict', async () => {
  const uid = await account();
  const heavy = await addCommitment(uid, 'Write the grant proposal', window(plusMinutes(REFERENCE, 180), 90));
  const lighter = await addLighter(uid);
  assert.equal(pickOf(await nextStep(uid)), heavy, 'fixture: the arm does not pick the heavy item');
  await lowNow(uid);
  const body = await nextStep(uid);
  assert.equal(pickOf(body), lighter, 'the lighter item was not offered first');
  assert.deepEqual(body.energy, { band: 'low', source: 'check_in', level: 1, changedPick: true });
  assert.match(body.recommendation.proposalId, /^next-step-[0-9a-f]{16}$/);
});

test('M5B-014 a span of exactly 60 counts as lighter; 61 is heavy (so no lighter candidate)', async () => {
  for (const [span, expectLighter] of [[60, true], [61, false]] as const) {
    const uid = await account();
    const heavy = await addCommitment(uid, 'Write the grant proposal', window(plusMinutes(REFERENCE, 180), 90));
    const other = await addLighter(uid, span);
    await lowNow(uid);
    const body = await nextStep(uid);
    assert.equal(pickOf(body), expectLighter ? other : heavy, `span ${span}`);
    assert.equal(body.energy?.changedPick, expectLighter, `span ${span}: changedPick`);
    end();
  }
});

test('M5B-014 only unknown-duration or all-day alternatives → unchanged, changedPick false', async () => {
  const uid = await account();
  const heavy = await addCommitment(uid, 'Write the grant proposal', window(plusMinutes(REFERENCE, 180), 90));
  await addCommitment(uid, 'Call the plumber', { kind: 'due_by', dueAt: plusMinutes(REFERENCE, 270), allDay: false });
  await addCommitment(uid, 'Sort the receipts', { kind: 'due_by', dueAt: at(TODAY, '00:00'), allDay: true });
  await lowNow(uid);
  const body = await nextStep(uid);
  assert.equal(pickOf(body), heavy);
  assert.deepEqual(body.energy, { band: 'low', source: 'check_in', level: 1, changedPick: false });
});

test('M5B-014 an all-day heavy-looking pick (day-boundary span) is never replaced', async () => {
  const uid = await account();
  const allDay = await addCommitment(uid, 'Finish the tax forms', { kind: 'due_by', dueAt: at(TODAY, '00:00'), endAt: at(TOMORROW, '00:00'), allDay: true });
  await addLighter(uid);
  assert.equal(pickOf(await nextStep(uid)), allDay, 'fixture: the arm does not pick the all-day item');
  await lowNow(uid);
  const body = await nextStep(uid);
  assert.equal(pickOf(body), allDay, 'an all-day item was treated as heavy');
  assert.equal(body.energy?.changedPick, false);
});

test('R4.3 no lighter candidate → unchanged, changedPick false', async () => {
  const uid = await account();
  const heavy = await addCommitment(uid, 'Write the grant proposal', window(plusMinutes(REFERENCE, 180), 90));
  await lowNow(uid);
  const body = await nextStep(uid);
  assert.equal(pickOf(body), heavy);
  assert.deepEqual(body.energy, { band: 'low', source: 'check_in', level: 1, changedPick: false });
});

/* ── the precedence boundary (M5B-039) ─────────────────────────────── */

test('M5B-039 a heavy timed-window due_by (anchor = endAt) and a heavy non-event scheduled task, anchor 119 / 120 / 121 min ahead → unchanged, unchanged, lighter', async () => {
  const shapes: Array<[string, (anchor: string) => Record<string, unknown>]> = [
    ['window due_by', (anchor) => window(anchor, 90)],
    ['scheduled task', (anchor) => taskAt(anchor, 90)],
  ];
  for (const [label, shape] of shapes) {
    for (const [minutes, expectLighter] of [[119, false], [120, false], [121, true]] as const) {
      const uid = await account();
      const heavy = await addCommitment(uid, 'Write the grant proposal', shape(plusMinutes(REFERENCE, minutes)));
      const lighter = await addLighter(uid);
      await lowNow(uid);
      const body = await nextStep(uid);
      assert.equal(pickOf(body), expectLighter ? lighter : heavy, `${label} at ${minutes} min`);
      assert.equal(body.energy?.changedPick, expectLighter, `${label} at ${minutes} min: changedPick`);
      end();
    }
  }
});

test('M5B-039 a heavy named event under way (dueAt < now < endAt) keeps its place', async () => {
  const uid = await account();
  const meeting = await addCommitment(uid, 'Meeting with Dana', { kind: 'scheduled_event', dueAt: plusMinutes(REFERENCE, -30), endAt: plusMinutes(REFERENCE, 60), allDay: false });
  await addLighter(uid);
  assert.equal(pickOf(await nextStep(uid)), meeting, 'fixture: the arm does not pick the meeting');
  await lowNow(uid);
  const body = await nextStep(uid);
  assert.equal(pickOf(body), meeting);
  assert.equal(body.energy?.changedPick, false);
});

test('M5B-039 an overdue heavy due_by yields to the lighter one', async () => {
  const uid = await account();
  const heavy = await addCommitment(uid, 'Write the grant proposal', window(plusMinutes(REFERENCE, -10), 90));
  const lighter = await addLighter(uid);
  assert.equal(pickOf(await nextStep(uid)), heavy, 'fixture: the arm does not pick the overdue item');
  await lowNow(uid);
  const body = await nextStep(uid);
  assert.equal(pickOf(body), lighter);
  assert.equal(body.energy?.changedPick, true);
});

/* ── no fresh reading: no effect, no salt ──────────────────────────── */

test('R4.3 parity (passes on base): a stale, a future-dated and a historical reading leave the pick unchanged and the proposalId equal to the off-mode id', async () => {
  const writes: Array<[string, (uid: string) => Promise<void>]> = [
    ['stale', async (uid) => storeReadingContext(uid, { currentSubjective: { energy: 1, observedAt: plusMinutes(REFERENCE, -13 * 60) } })],
    ['future', async (uid) => storeReadingContext(uid, { currentSubjective: { energy: 1, observedAt: plusMinutes(REFERENCE, 10) }, recentReadiness: healthSnapshot(uid, 'low', plusMinutes(REFERENCE, 10)) })],
    ['historical', async (uid) => storeReadingContext(uid, { historicalInference: healthSnapshot(uid, 'low', plusMinutes(REFERENCE, -4 * 24 * 60)) })],
  ];
  for (const [label, write] of writes) {
    const uid = await account();
    const heavy = await addCommitment(uid, 'Write the grant proposal', window(plusMinutes(REFERENCE, 180), 90));
    await addLighter(uid);
    await write(uid);
    const on = await nextStep(uid);
    assert.equal(pickOf(on), heavy, `${label}: the pick changed`);
    assertNoEffect(on, label);
    const off = await offModeRead(uid);
    assert.equal(on.recommendation.proposalId, off.recommendation.proposalId, `${label}: the id is salted without a fresh reading`);
    end();
  }
});

/* ── preparation still first ───────────────────────────────────────── */

test('R4.3 preparation still first: low + heavy pick + an applicable preparation → the preparation, changedPick false, its id salted by the reading and stable for the same reading', async () => {
  const uid = await account();
  await addCommitment(uid, 'Write the grant proposal', window(plusMinutes(REFERENCE, 300), 90));
  const exam = await addCommitment(uid, 'Exam in statistics', { kind: 'scheduled_event', dueAt: plusMinutes(REFERENCE, 180), endAt: plusMinutes(REFERENCE, 240), allDay: false });
  await addLighter(uid);
  const unsalted = await nextStep(uid);
  assert.equal(unsalted.recommendation.primaryStep?.purpose, 'prepare', 'fixture: no preparation step');
  await lowNow(uid);
  const first = await nextStep(uid);
  assert.equal(first.recommendation.primaryStep?.purpose, 'prepare');
  assert.equal(pickOf(first), exam);
  assert.equal(first.energy?.changedPick, false, 'changedPick must follow the displayed recommendation');
  assert.notEqual(first.recommendation.proposalId, unsalted.recommendation.proposalId, 'the preparation id carries no reading salt');
  const second = await nextStep(uid);
  assert.equal(second.recommendation.proposalId, first.recommendation.proposalId, 'the same reading gave a different id');
});

/* ── decisions through the shared builder (M5B-005) ────────────────── */

test('M5B-005 a decision on a low-energy changed proposal (done, defer, edit) succeeds — no 409', async () => {
  for (const decision of ['done', 'defer', 'edit'] as const) {
    const uid = await account();
    await addCommitment(uid, 'Write the grant proposal', window(plusMinutes(REFERENCE, 180), 90));
    const lighter = await addLighter(uid);
    await lowNow(uid);
    const card = await nextStep(uid);
    assert.equal(pickOf(card), lighter, 'fixture: the lighter pick was not shown');
    const extra = decision === 'edit' ? { editedTitle: 'Reply to the landlord briefly' } : decision === 'defer' ? { deferUntil: plusMinutes(REFERENCE, 120) } : {};
    const answer = await decide(uid, card.recommendation.proposalId, decision, extra);
    assert.equal(answer.status, 200, `${decision}: ${show(answer.body)}`);
    if (decision === 'done') assert.equal((await commitment(uid, lighter)).status, 'completed');
    if (decision === 'edit') assert.equal((await commitment(uid, lighter)).title, 'Reply to the landlord briefly');
    end();
  }
});

/* ── same-band changes between read and decision (M5B-040) ─────────── */

async function decisionAfter(setupEnergy: number, change: (uid: string) => Promise<void>, options: { observedAt?: string } = {}) {
  const uid = await account();
  await addCommitment(uid, 'Write the grant proposal', window(plusMinutes(REFERENCE, 180), 90));
  await addLighter(uid);
  await checkInOk(uid, setupEnergy, options.observedAt ?? plusMinutes(REFERENCE, -60));
  const card = await nextStep(uid);
  await change(uid);
  const answer = await decide(uid, card.recommendation.proposalId, 'done');
  return { uid, card, answer };
}

test('M5B-040 a changed (lighter) pick under a low reading → 409 for check-in 2 → 1, the same level re-saved with a new observedAt, and health low replacing check-in low', async () => {
  const cases: Array<[string, number, (uid: string) => Promise<void>, string?]> = [
    ['2 → 1', 2, async (uid) => { await checkInOk(uid, 1, plusMinutes(REFERENCE, -1)); }],
    ['same level, new observedAt', 1, async (uid) => { await checkInOk(uid, 1, plusMinutes(REFERENCE, -1)); }],
    ['health low replaces check-in low', 1, async (uid) => {
      assert.equal((await postHealth(uid, 'low', plusMinutes(REFERENCE, -30))).status, 200);
      setClock(plusMinutes(REFERENCE, 2));
    }, plusMinutes(REFERENCE, -(11 * 60 + 59))],
  ];
  for (const [label, energy, change, observedAt] of cases) {
    const { card, answer } = await decisionAfter(energy, change, observedAt ? { observedAt } : {});
    assert.equal(card.energy?.changedPick, true, `${label}: fixture — the lighter pick was not shown`);
    assert.equal(answer.status, 409, `${label}: a card built under another reading was accepted: ${show(answer.body)}`);
    end();
  }
});

test('M5B-040 an unchanged pick under a steady reading → 409 for 3 → 3 with a new observedAt and for health steady replacing check-in steady', async () => {
  const cases: Array<[string, (uid: string) => Promise<void>, string?]> = [
    ['3 → 3, new observedAt', async (uid) => { await checkInOk(uid, 3, plusMinutes(REFERENCE, -1)); }],
    ['health steady replaces check-in steady', async (uid) => {
      assert.equal((await postHealth(uid, 'steady', plusMinutes(REFERENCE, -30))).status, 200);
      setClock(plusMinutes(REFERENCE, 2));
    }, plusMinutes(REFERENCE, -(11 * 60 + 59))],
  ];
  for (const [label, change, observedAt] of cases) {
    const { card, answer } = await decisionAfter(3, change, observedAt ? { observedAt } : {});
    assert.equal(card.energy?.band, 'steady', `${label}: fixture`);
    assert.equal(answer.status, 409, `${label}: ${show(answer.body)}`);
    end();
  }
});

test('M5B-040 parity (passes on base): an identical re-save (unchanged, same observedAt) → no 409', async () => {
  const observedAt = plusMinutes(REFERENCE, -60);
  const { answer } = await decisionAfter(1, async (uid) => {
    const again = await checkIn(uid, 1, observedAt);
    assert.equal(again.body.result, 'unchanged');
  }, { observedAt });
  assert.equal(answer.status, 200, show(answer.body));
});

/* ── pick binding at the boundaries (M5B1-001) ─────────────────────── */

async function bindingCase(build: (uid: string) => Promise<{ watched: string[] }>, readAt: string, decideAt: string) {
  const uid = await account();
  const { watched } = await build(uid);
  await lowNow(uid);
  setClock(readAt);
  const card = await nextStep(uid);
  const before = await Promise.all(watched.map((id) => commitment(uid, id)));
  setClock(decideAt);
  // What the card would be now, read before the decision changes anything.
  const cardAtDecide = await nextStep(uid);
  const answer = await decide(uid, card.recommendation.proposalId, 'done');
  const after = await Promise.all(watched.map((id) => commitment(uid, id)));
  const ledger = await listRecentNextStepDecisions(uid, new Date());
  return { uid, card, cardAtDecide, answer, before, after, ledger };
}

function assertRefusedCleanly(label: string, run: Awaited<ReturnType<typeof bindingCase>>) {
  assert.equal(run.answer.status, 409, `${label}: a decision crossed a pick change: ${show(run.answer.body)}`);
  assert.equal(run.ledger.length, 0, `${label}: a ledger entry was written`);
  assert.deepEqual(run.after.map((item) => [item.status, item.title, item.updatedAt]), run.before.map((item) => [item.status, item.title, item.updatedAt]), `${label}: a commitment changed`);
}

test('M5B1-001 pick binding: only the clock moves across a pick boundary → 409, no ledger entry, no effect on either commitment', async () => {
  // Window due_by, anchor A = REFERENCE + 121 min: read at A − 120 min 1 s (lighter), decide at A − 120 min (heavy kept).
  {
    const anchor = plusMinutes(REFERENCE, 121);
    const run = await bindingCase(async (uid) => ({ watched: [await addCommitment(uid, 'Write the grant proposal', window(anchor, 90)), await addLighter(uid)] }),
      plusMs(anchor, -(120 * MIN + 1000)), plusMs(anchor, -120 * MIN));
    assert.equal(run.card.energy?.changedPick, true, 'window: fixture — the read did not show the lighter pick');
    assertRefusedCleanly('window 120 min 1 s → 120 min', run);
    end();
  }
  // A heavy non-event scheduled task: the same pair of clocks on its start.
  {
    const start = plusMinutes(REFERENCE, 121);
    const run = await bindingCase(async (uid) => ({ watched: [await addCommitment(uid, 'Write the grant proposal', taskAt(start, 90)), await addLighter(uid)] }),
      plusMs(start, -(120 * MIN + 1000)), plusMs(start, -120 * MIN));
    assert.equal(run.card.energy?.changedPick, true, 'scheduled task: fixture');
    assertRefusedCleanly('scheduled task 120 min 1 s → 120 min', run);
    end();
  }
  // Window due_by: read at anchor − now = 0 (kept), decide 1 ms later (overdue → lighter).
  {
    const anchor = plusMinutes(REFERENCE, 60);
    const run = await bindingCase(async (uid) => ({ watched: [await addCommitment(uid, 'Write the grant proposal', window(anchor, 90)), await addLighter(uid)] }),
      anchor, plusMs(anchor, 1));
    assert.equal(run.card.energy?.changedPick, false, 'deadline: fixture — the read did not keep the heavy pick');
    assertRefusedCleanly('deadline passing', run);
    end();
  }
  // A heavy named event: read 1 ms before endAt (under way, kept), decide at endAt (lighter).
  {
    const endAt = plusMinutes(REFERENCE, 60);
    const run = await bindingCase(async (uid) => ({ watched: [
      await addCommitment(uid, 'Meeting with Dana', { kind: 'scheduled_event', dueAt: plusMinutes(REFERENCE, -60), endAt, allDay: false }),
      await addLighter(uid),
    ] }), plusMs(endAt, -1), endAt);
    assert.equal(run.card.energy?.changedPick, false, 'event end: fixture');
    assertRefusedCleanly('named event ending', run);
    end();
  }
});

test('M5B1-001 a preparation under lighter:yielded and the same preparation under lighter:kept have different ids; a decision across them → 409', async () => {
  // The exam is 90 min after the read, so the heavy deadline (after the exam) never keeps precedence over the preparation.
  const anchor = plusMinutes(REFERENCE, 121);
  const run = await bindingCase(async (uid) => ({ watched: [
    await addCommitment(uid, 'Write the grant proposal', window(anchor, 90)),
    await addCommitment(uid, 'Exam in statistics', { kind: 'scheduled_event', dueAt: plusMinutes(REFERENCE, 90), endAt: plusMinutes(REFERENCE, 150), allDay: false }),
    await addLighter(uid),
  ] }), plusMs(anchor, -(120 * MIN + 1000)), plusMs(anchor, -120 * MIN));
  assert.equal(run.card.recommendation.primaryStep?.purpose, 'prepare', 'fixture: the read did not show the preparation');
  const later = run.cardAtDecide;
  assert.equal(later.recommendation.primaryStep?.purpose, 'prepare', 'fixture: the preparation is not shown after the clock moved');
  assert.notEqual(later.recommendation.proposalId, run.card.recommendation.proposalId, 'yielded and kept preparations share an id');
  assertRefusedCleanly('preparation yielded → kept', run);
});

test('M5B1-001 controls: read and decide both inside (119 then 118 min) or both outside (122 then 121) → success, recorded against the commitment the card showed', async () => {
  for (const [readMinutes, decideMinutes, expectLighter] of [[119, 118, false], [122, 121, true]] as const) {
    const anchor = plusMinutes(REFERENCE, 200);
    let heavy = '';
    let lighter = '';
    const run = await bindingCase(async (uid) => {
      heavy = await addCommitment(uid, 'Write the grant proposal', window(anchor, 90));
      lighter = await addLighter(uid);
      return { watched: [heavy, lighter] };
    }, plusMinutes(anchor, -readMinutes), plusMinutes(anchor, -decideMinutes));
    const shown = expectLighter ? lighter : heavy;
    assert.equal(pickOf(run.card), shown, `${readMinutes}→${decideMinutes}: fixture`);
    assert.equal(run.answer.status, 200, `${readMinutes}→${decideMinutes}: ${show(run.answer.body)}`);
    assert.equal(run.ledger.length, 1);
    assert.equal(run.ledger[0]!.commitmentId, shown, 'the decision was recorded against a commitment the card did not show');
    assert.equal((await commitment(run.uid, shown)).status, 'completed');
    end();
  }
});
