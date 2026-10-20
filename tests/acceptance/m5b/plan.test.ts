/**
 * M5b-1 Gate B — the plan: the fresh-only buffer, readinessApplied, the
 * readiness-changed rule, unknown snapshots, continuous replan snapshots and
 * the personalization purge (PLAN-M5b-1 R4.1, Release "On-mode persistence",
 * Wire "Plan DTO"; M5B-009, M5B-012, M5B-027, M5B-028, M5B-029).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { userDoc } from '../../../lib/storage/paths.ts';
import { planPath } from '../../../lib/services/dailyPlan/planStore.ts';
import {
  AUTO_APPLY,
  NO_READINESS_APPLIED,
  REFERENCE,
  REVIEW,
  TODAY,
  YESTERDAY,
  acceptPlanRoute,
  at,
  begin,
  buffersOf,
  buildPlan,
  call,
  checkIn,
  checkInOk,
  currentStorage,
  end,
  getPlan,
  healthSnapshot,
  planAction,
  plusMinutes,
  postHealth,
  replan,
  setClock,
  setM5bSwitches,
  show,
  storeReadingContext,
  storedPlan,
  stripOnModeFields,
  threeTasks,
  touchPlan,
} from './support.ts';

test.afterEach(() => end());

const applied = (source: string, energy: number | null, band: string | null, bufferMinutesAdded: number, observedAt: string | null) =>
  ({ source, energy, band, bufferMinutesAdded, observedAt });

/* ── the buffer and readinessApplied ───────────────────────────────── */

test('R4.1 a check-in of 2 gives +15 after each item and readinessApplied check_in / low with its observedAt, on the DTO and the stored plan', async () => {
  const uid = await begin();
  await threeTasks(uid);
  const observedAt = await checkInOk(uid, 2, plusMinutes(REFERENCE, -30));
  const plan = await buildPlan(uid);
  assert.deepEqual(plan.readinessApplied, applied('check_in', 2, 'low', 15, observedAt));
  assert.equal(plan.basisChanged, false);
  const stored = await storedPlan(uid);
  assert.deepEqual(stored.readinessApplied, applied('check_in', 2, 'low', 15, observedAt), 'the stored plan does not record readinessApplied');
  assert.ok(buffersOf(stored).every((minutes) => minutes === 15), `buffers: ${buffersOf(stored)}`);
});

test('R4.1 a check-in 13 h old gives 0 and source none', async () => {
  const uid = await begin();
  await threeTasks(uid);
  await storeReadingContext(uid, { currentSubjective: { energy: 2, observedAt: plusMinutes(REFERENCE, -13 * 60) } });
  const plan = await buildPlan(uid);
  assert.deepEqual(plan.readinessApplied, NO_READINESS_APPLIED);
  assert.ok(buffersOf(await storedPlan(uid)).every((minutes) => minutes === 0));
});

test('R4.1 a historical-only account gives 0', async () => {
  const uid = await begin();
  await threeTasks(uid);
  await storeReadingContext(uid, { historicalInference: healthSnapshot(uid, 'low', plusMinutes(REFERENCE, -3 * 24 * 60)) });
  const plan = await buildPlan(uid);
  assert.deepEqual(plan.readinessApplied, NO_READINESS_APPLIED);
  assert.ok(buffersOf(await storedPlan(uid)).every((minutes) => minutes === 0), 'a historical snapshot still buffers the plan');
});

test('R4.1 health 30 h old applies (health / energy null / low / 15); 37 h old does not', async () => {
  const uid = await begin();
  await threeTasks(uid);
  const computedAt = plusMinutes(REFERENCE, -30 * 60);
  assert.equal((await postHealth(uid, 'low', computedAt)).status, 200);
  assert.deepEqual((await buildPlan(uid)).readinessApplied, applied('health', null, 'low', 15, computedAt));
  end();
  const old = await begin();
  await threeTasks(old);
  assert.equal((await postHealth(old, 'low', plusMinutes(REFERENCE, -37 * 60))).status, 200);
  assert.deepEqual((await buildPlan(old)).readinessApplied, NO_READINESS_APPLIED);
});

test('M5B-012 a stored check-in and health snapshot 10 min in the future are ignored by the build; a check-in 4 min ahead applies', async () => {
  const uid = await begin();
  await threeTasks(uid);
  const future = plusMinutes(REFERENCE, 10);
  await storeReadingContext(uid, { currentSubjective: { energy: 1, observedAt: future }, recentReadiness: healthSnapshot(uid, 'low', future) });
  assert.deepEqual((await buildPlan(uid)).readinessApplied, NO_READINESS_APPLIED);
  assert.ok(buffersOf(await storedPlan(uid)).every((minutes) => minutes === 0));
  end();
  const soon = await begin();
  await threeTasks(soon);
  const observedAt = await checkInOk(soon, 1, plusMinutes(REFERENCE, 4));
  assert.deepEqual((await buildPlan(soon)).readinessApplied, applied('check_in', 1, 'low', 15, observedAt));
});

/* ── readiness changed (M5B-009) ───────────────────────────────────── */

test('M5B-009 a check-in on an untouched proposed plan: the next GET returns generation+1 with the new snapshot and no rebuild spent', async () => {
  const uid = await begin();
  await threeTasks(uid);
  const built = await buildPlan(uid);
  const observedAt = await checkInOk(uid, 2, plusMinutes(REFERENCE, -1));
  const read = await getPlan(uid);
  assert.equal(read.plan.generation, built.generation + 1, 'the untouched plan was not refreshed for the new reading');
  assert.equal(read.plan.rebuildsLeft, built.rebuildsLeft, 'the refresh spent a rebuild');
  assert.deepEqual(read.plan.readinessApplied, applied('check_in', 2, 'low', 15, observedAt));
  assert.equal(read.plan.basisChanged, false);
  const stored = await storedPlan(uid);
  assert.equal(stored.automaticGenerations, 1);
  assert.ok(buffersOf(stored).every((minutes) => minutes === 15));
});

test('M5B-009 a check-in on a touched plan or an accepted plan: basisChanged with no refresh', async () => {
  for (const touch of [touchPlan, acceptPlanRoute]) {
    const uid = await begin();
    await threeTasks(uid);
    await buildPlan(uid);
    await touch(uid);
    const before = await storedPlan(uid);
    await checkInOk(uid, 2, plusMinutes(REFERENCE, -1));
    const read = await getPlan(uid);
    assert.equal(read.plan.basisChanged, true, `${touch.name}: basisChanged not raised`);
    assert.equal(read.plan.generation, before.generation, `${touch.name}: a touched plan was refreshed`);
    assert.deepEqual(read.plan.readinessApplied, NO_READINESS_APPLIED, `${touch.name}: the DTO must report what the plan was solved with`);
    end();
  }
});

async function touchedUnder(energy: number, observedAt: string): Promise<string> {
  const uid = await begin();
  await threeTasks(uid);
  await checkInOk(uid, energy, observedAt);
  await buildPlan(uid);
  await touchPlan(uid);
  assert.equal((await getPlan(uid)).plan.basisChanged, false, 'basisChanged is missing from the DTO, or true before any change');
  return uid;
}

test('M5B-009 full identity: energy 4 → 5 (both high, buffer 0) raises basisChanged on a touched plan', async () => {
  const uid = await touchedUnder(4, plusMinutes(REFERENCE, -30));
  await checkInOk(uid, 5, plusMinutes(REFERENCE, -1));
  assert.equal((await getPlan(uid)).plan.basisChanged, true);
});

test('M5B-009 full identity: the same energy with a new observedAt raises basisChanged', async () => {
  const uid = await touchedUnder(2, plusMinutes(REFERENCE, -30));
  await checkInOk(uid, 2, plusMinutes(REFERENCE, -1));
  assert.equal((await getPlan(uid)).plan.basisChanged, true);
});

test('M5B-009 full identity: health low replacing check-in low (same band, same +15) raises basisChanged', async () => {
  const observedAt = plusMinutes(REFERENCE, -(11 * 60 + 50));
  const uid = await touchedUnder(2, observedAt);
  assert.equal((await postHealth(uid, 'low', plusMinutes(REFERENCE, -60))).status, 200);
  // Fifteen minutes on the check-in is 12 h 05 old: the fresh health snapshot is now the reading.
  setClock(plusMinutes(REFERENCE, 15));
  const read = await getPlan(uid);
  assert.equal(read.plan.basisChanged, true);
  assert.equal(read.plan.readinessApplied.source, 'check_in', 'the DTO reports what the plan was solved with');
});

test('M5B-009 full identity: an identical re-save (unchanged) does not raise basisChanged', async () => {
  const observedAt = plusMinutes(REFERENCE, -30);
  const uid = await touchedUnder(2, observedAt);
  const again = await checkIn(uid, 2, observedAt);
  assert.equal(again.body.result, 'unchanged', show(again.body));
  assert.equal((await getPlan(uid)).plan.basisChanged, false);
});

/* ── unknown snapshot (M5B-028) ────────────────────────────────────── */

/** A plan for `date` written with the switch off (no readinessApplied), then the switch turned on. */
async function legacyPlan(date: string = TODAY): Promise<string> {
  const uid = await begin({ on: false });
  await threeTasks(uid);
  if (date !== TODAY) setClock(at(date, '10:00'));
  await buildPlan(uid, date);
  if (date !== TODAY) setClock(REFERENCE);
  const stored = await storedPlan(uid, date);
  assert.equal('readinessApplied' in stored, false, 'fixture: an off-mode build wrote readinessApplied');
  setM5bSwitches({ on: true });
  return uid;
}

test('M5B-028 unknown snapshot, untouched, today: the first on GET refreshes once (automaticGenerations +1, rebuilds unchanged); the second does not', async () => {
  const uid = await legacyPlan();
  const before = await storedPlan(uid);
  const first = await getPlan(uid);
  assert.equal(first.plan.generation, before.generation + 1, 'an untouched legacy plan was not refreshed');
  assert.deepEqual(first.plan.readinessApplied, NO_READINESS_APPLIED, 'the refreshed generation must carry its snapshot');
  const stored = await storedPlan(uid);
  assert.equal(stored.automaticGenerations ?? 0, (before.automaticGenerations ?? 0) + 1);
  assert.deepEqual(stored.readinessApplied, NO_READINESS_APPLIED);
  const second = await getPlan(uid);
  assert.equal(second.plan.generation, first.plan.generation, 'refreshed again for the same reason');
  assert.equal(second.plan.rebuildsLeft, first.plan.rebuildsLeft);
});

test('M5B-028 unknown snapshot, touched or accepted, today: basisChanged true with readinessApplied null', async () => {
  for (const touch of [touchPlan, acceptPlanRoute]) {
    const uid = await begin({ on: false });
    await threeTasks(uid);
    await buildPlan(uid);
    await touch(uid);
    setM5bSwitches({ on: true });
    const before = await storedPlan(uid);
    const read = await getPlan(uid);
    assert.equal(read.plan.readinessApplied, null, `${touch.name}: an unknown snapshot is not "nothing applied"`);
    assert.equal(read.plan.basisChanged, true, `${touch.name}`);
    assert.equal(read.plan.generation, before.generation);
    end();
  }
});

test('M5B-028 unknown snapshot for yesterday: readinessApplied null, basisChanged false', async () => {
  const uid = await legacyPlan(YESTERDAY);
  const read = await getPlan(uid, YESTERDAY);
  assert.equal(read.plan.readinessApplied, null);
  assert.equal(read.plan.basisChanged, false);
});

/* ── continuous replan (M5B-029, readiness part) ───────────────────── */

async function lowPlan(): Promise<{ uid: string; observedAt: string }> {
  const uid = await begin();
  await threeTasks(uid);
  const observedAt = await checkInOk(uid, 1, plusMinutes(REFERENCE, -20));
  await buildPlan(uid);
  return { uid, observedAt };
}

test('M5B-029 a replan tick that auto-applies stores the solve\'s readinessApplied on the installed generation', async () => {
  const { uid, observedAt } = await lowPlan();
  const report = await replan(uid, AUTO_APPLY);
  assert.equal(report.pipelineResult.policyDecision?.action, 'auto_apply', 'fixture: not auto-applied');
  const stored = await storedPlan(uid);
  assert.equal(stored.generation, 2);
  assert.deepEqual(stored.readinessApplied, applied('check_in', 1, 'low', 15, observedAt));
});

test('M5B-029 a replan tick that offers stores basisSnapshot { readinessApplied } next to solveInputs', async () => {
  const { uid, observedAt } = await lowPlan();
  const report = await replan(uid, REVIEW);
  assert.equal(report.pipelineResult.policyDecision?.action, 'propose_for_review', 'fixture: no offer');
  const stored = await storedPlan(uid);
  assert.ok(stored.proposal, 'fixture: no offer stored');
  assert.deepEqual(stored.proposal.basisSnapshot, { readinessApplied: applied('check_in', 1, 'low', 15, observedAt) });
});

test('M5B-029 a calendar change that reuses the pending solve keeps the offer\'s snapshot', async () => {
  const { uid, observedAt } = await lowPlan();
  await replan(uid, REVIEW);
  const offered = await storedPlan(uid);
  assert.ok(offered.proposal?.basisSnapshot, 'no basisSnapshot on the offer');
  // A new low reading (same buffer), then a short call wholly inside the meeting that caused the offer.
  await checkInOk(uid, 2, plusMinutes(REFERENCE, -2));
  const meeting = (await storedPlan(uid)).plan.scheduled[0]!.interval;
  const inside = { startsAt: plusMinutes(meeting.startsAt, 5), endsAt: plusMinutes(meeting.startsAt, 15) };
  const report = await replan(uid, REVIEW, inside, 'busy-short-call');
  assert.equal(report.offerOutcome, 'kept', `fixture: the offer was not kept (${report.offerOutcome})`);
  const after = await storedPlan(uid);
  assert.equal(after.proposal?.proposalId, offered.proposal!.proposalId);
  assert.deepEqual(after.proposal?.basisSnapshot, { readinessApplied: applied('check_in', 1, 'low', 15, observedAt) }, 'a reused solve must keep its own snapshot');
});

test('M5B-029 accepting with an unchanged reading installs the offer\'s snapshot, basisChanged false', async () => {
  const { uid, observedAt } = await lowPlan();
  await replan(uid, REVIEW);
  const proposalId = (await storedPlan(uid)).proposal!.proposalId;
  const accepted = await planAction(uid, { action: 'accept_proposal', proposalId });
  assert.equal(accepted.status, 200, show(accepted.body));
  assert.deepEqual((await storedPlan(uid)).readinessApplied, applied('check_in', 1, 'low', 15, observedAt));
  assert.equal((await getPlan(uid)).plan.basisChanged, false);
});

test('M5B-029 a check-in between offer and acceptance: accepted (200, not stale_proposal), the generation carries the offer\'s snapshot, the next GET says basisChanged', async () => {
  const { uid, observedAt } = await lowPlan();
  await replan(uid, REVIEW);
  const proposalId = (await storedPlan(uid)).proposal!.proposalId;
  await checkInOk(uid, 4, plusMinutes(REFERENCE, -1));
  const accepted = await planAction(uid, { action: 'accept_proposal', proposalId });
  assert.equal(accepted.status, 200, `acceptance rejected because the reading changed: ${show(accepted.body)}`);
  assert.deepEqual((await storedPlan(uid)).readinessApplied, applied('check_in', 1, 'low', 15, observedAt));
  const read = await getPlan(uid);
  assert.equal(read.plan.basisChanged, true);
});

test('M5B-029 an offer with no basisSnapshot accepted on: installed without readinessApplied (unknown snapshot), basisChanged true', async () => {
  const { uid } = await lowPlan();
  await replan(uid, REVIEW);
  const offered = await storedPlan(uid);
  assert.ok(offered.proposal?.basisSnapshot, 'fixture: the on-mode offer has no basisSnapshot to remove');
  await stripOnModeFields(uid);
  // Put the plan's own readinessApplied back: only the offer is legacy.
  await currentStorage().set(planPath(uid, TODAY), { ...(await storedPlan(uid)), readinessApplied: offered.readinessApplied });
  const accepted = await planAction(uid, { action: 'accept_proposal', proposalId: offered.proposal!.proposalId });
  assert.equal(accepted.status, 200, show(accepted.body));
  assert.equal('readinessApplied' in (await storedPlan(uid)), false, 'an offer without a snapshot installed one anyway');
  const read = await getPlan(uid);
  assert.equal(read.plan.readinessApplied, null);
  assert.equal(read.plan.basisChanged, true);
});

test('Release: an off-mode replan auto-apply and an off-mode acceptance of an on-mode offer write neither field', async () => {
  const auto = await lowPlan();
  assert.ok((await storedPlan(auto.uid)).readinessApplied, 'fixture: the on-mode plan has no readinessApplied');
  setM5bSwitches({ on: false });
  const report = await replan(auto.uid, AUTO_APPLY);
  assert.equal(report.pipelineResult.policyDecision?.action, 'auto_apply', 'fixture: not auto-applied');
  assert.equal('readinessApplied' in (await storedPlan(auto.uid)), false, 'an off-mode auto-apply carried readinessApplied');
  end();

  const offer = await lowPlan();
  await replan(offer.uid, REVIEW);
  const offered = await storedPlan(offer.uid);
  assert.ok(offered.proposal?.basisSnapshot, 'fixture: the on-mode offer has no basisSnapshot');
  setM5bSwitches({ on: true, killed: true });
  const accepted = await planAction(offer.uid, { action: 'accept_proposal', proposalId: offered.proposal!.proposalId });
  assert.equal(accepted.status, 200, show(accepted.body));
  const installed = await storedPlan(offer.uid);
  assert.equal('readinessApplied' in installed, false, 'a killed-mode acceptance installed readinessApplied');
  assert.equal(installed.proposal?.basisSnapshot, undefined);
});

/* ── the personalization purge needs no M5b-1 handling (checked decision) ── */

test('Release: delete-all-memory leaves on-mode plans and readinessContext byte-identical, returns today\'s receipt fields, and the next GET says basisChanged false', async () => {
  // The receipt's fields on an account M5b-1 never touched.
  const control = await begin({ on: false });
  const controlDeleted = await call(control, 'memory', 'DELETE');
  assert.equal(controlDeleted.status, 200, show(controlDeleted.body));
  const receiptKeys = Object.keys(controlDeleted.body.deleted ?? {}).sort();
  end();

  const { uid } = await lowPlan();
  await replan(uid, REVIEW);
  const plan = await storedPlan(uid);
  assert.ok(plan.readinessApplied, 'fixture: the on-mode plan has no readinessApplied');
  assert.ok(plan.proposal?.basisSnapshot, 'fixture: no pending offer with basisSnapshot');
  const user = await currentStorage().get<Record<string, unknown>>(userDoc(uid));
  const planBefore = JSON.stringify(plan);
  const contextBefore = JSON.stringify(user?.readinessContext);

  const deleted = await call(uid, 'memory', 'DELETE');
  assert.equal(deleted.status, 200, show(deleted.body));
  assert.deepEqual(Object.keys(deleted.body.deleted ?? {}).sort(), receiptKeys, 'the receipt gained or lost a field');
  assert.equal(JSON.stringify(await storedPlan(uid)), planBefore, 'the purge changed the plan document');
  const userAfter = await currentStorage().get<Record<string, unknown>>(userDoc(uid));
  assert.equal(JSON.stringify(userAfter?.readinessContext), contextBefore, 'the purge changed readinessContext');
  assert.equal((await getPlan(uid)).plan.basisChanged, false);
});
