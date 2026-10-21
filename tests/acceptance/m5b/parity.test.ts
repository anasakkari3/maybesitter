/**
 * M5b-1 Gate B — off and killed: byte parity, and off after on (PLAN-M5b-1
 * Release "Flag off or killed = byte-identical", "Off-mode readers ignore
 * every on-mode field"; Verification "Off and killed", "Off/killed after on",
 * M5B-016 plan part).
 *
 * Parity guards pin today's behaviour: they pass on dd73a9fb by construction
 * and fail on a build that leaks an on-mode field or rule into off or killed.
 * Each scenario runs for the flag explicitly off, killed, and never set (what
 * dd73a9fb's environment is), and the three answers must be byte-identical
 * (account ids, and the request digests that hash them, aside) and carry
 * exactly today's keys.
 *
 * The off-after-on cases first write data with the switch on, so they fail on
 * dd73a9fb at their setup (no on-mode field is ever written there).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readinessObserver } from '../../../lib/watchers/signals.ts';
import {
  NOW,
  REFERENCE,
  REVIEW,
  TODAY,
  addCommitment,
  addFloating,
  begin,
  buffersOf,
  buildPlan,
  call,
  checkIn,
  currentStorage,
  end,
  getPlan,
  grantRecommendations,
  healthSnapshot,
  nextStep,
  plusMinutes,
  postHealth,
  replan,
  setM5bSwitches,
  show,
  storeReadingContext,
  storedPlan,
  stripOnModeFields,
  type M5bSwitches,
} from './support.ts';

test.afterEach(() => end());

const MODES: Array<[string, M5bSwitches]> = [['off', { on: false }], ['killed', { on: true, killed: true }], ['unset', { on: null }]];

/** Today's keys (dd73a9fb). */
const PLAN_DTO_KEYS = ['acceptedAt', 'date', 'edited', 'explanation', 'fixed', 'generatedAt', 'generation', 'inputDigest', 'inputsChanged', 'protections', 'rebuildsLeft', 'scheduled', 'status', 'timezone', 'unscheduled', 'workingEndsAt'];
const READINESS_KEYS = ['freshness', 'readiness', 'selectedSource'];
const NEXT_STEP_KEYS = ['assignment', 'exposure', 'participantId', 'recommendation', 'success'];

const IDS = ['0c0ffee7-0000-4000-8000-000000000001', '0c0ffee7-0000-4000-8000-000000000002', '0c0ffee7-0000-4000-8000-000000000003'];

/** Runs `scenario` once per mode; answers must be identical across modes (the uid replaced). */
async function acrossModes(scenario: (uid: string) => Promise<unknown>): Promise<unknown> {
  const answers: string[] = [];
  for (const [, switches] of MODES) {
    const uid = await begin(switches);
    // The uid is replaced, and so is `inputDigest`: it hashes the request, whose scope id is the uid.
    answers.push(JSON.stringify(await scenario(uid)).split(uid).join('<uid>').replace(/"inputDigest":"[0-9a-f]{64}"/g, '"inputDigest":"<digest>"'));
    end();
  }
  assert.equal(answers[1], answers[0], 'killed differs from off');
  assert.equal(answers[2], answers[0], 'off differs from a deploy that never set the flag');
  return JSON.parse(answers[0]!);
}

async function seedTasks(uid: string): Promise<void> {
  await addFloating(uid, 'Write the summary', IDS[0]);
  await addFloating(uid, 'Call the bank', IDS[1]);
  await addFloating(uid, 'Book the train', IDS[2]);
}

/* ── off / killed byte parity ──────────────────────────────────────── */

test('Release parity (passes on base): off and killed, memory GET answers today\'s shape, identically', async () => {
  const body: any = await acrossModes(async (uid) => {
    const read = await call(uid, 'memory', 'GET');
    assert.equal(read.status, 200, show(read.body));
    return read.body;
  });
  assert.deepEqual(Object.keys(body).sort(), ['adaptive', 'items', 'suggestions']);
});

test('Release parity (passes on base): off and killed, readiness GET keeps today\'s keys and today\'s resolver (a historical snapshot still counts, as stale)', async () => {
  const body: any = await acrossModes(async (uid) => {
    await storeReadingContext(uid, { historicalInference: healthSnapshot(uid, 'low', '2026-10-03T07:00:00.000Z') });
    const read = await call(uid, 'readiness', 'GET');
    assert.equal(read.status, 200, show(read.body));
    return read.body;
  });
  assert.deepEqual(Object.keys(body).sort(), READINESS_KEYS, 'an on-mode field (planEffect) leaked into off');
  assert.deepEqual([body.selectedSource, body.freshness], ['historical_inference', 'stale']);
});

test('Release parity (passes on base): off and killed, PUT and POST treat a future timestamp exactly as today (accepted)', async () => {
  await acrossModes(async (uid) => {
    const put = await checkIn(uid, 2, plusMinutes(REFERENCE, 10));
    const post = await postHealth(uid, 'low', plusMinutes(REFERENCE, 10));
    assert.equal(put.status, 200, show(put.body));
    assert.equal(post.status, 200, show(post.body));
    const read = await call(uid, 'readiness', 'GET');
    return { put: put.body, post: post.body, read: read.body };
  });
});

test('Release parity (passes on base): off and killed, plan build, GET and regenerate answer today\'s DTO — a historical low reading still buffers', async () => {
  const body: any = await acrossModes(async (uid) => {
    await seedTasks(uid);
    await storeReadingContext(uid, { historicalInference: healthSnapshot(uid, 'low', '2026-10-03T07:00:00.000Z') });
    const built = await buildPlan(uid);
    const read = await getPlan(uid);
    const rebuilt = await call(uid, 'plans/[date]/regenerate', 'POST', { params: { date: TODAY } });
    assert.equal(rebuilt.status, 200, show(rebuilt.body));
    const stored = await storedPlan(uid);
    return { built, read, rebuilt: rebuilt.body, buffers: buffersOf(stored), storedKeys: Object.keys(stored).sort() };
  });
  for (const dto of [body.built, body.read.plan, body.rebuilt.plan]) assert.deepEqual(Object.keys(dto).sort(), PLAN_DTO_KEYS, 'an on-mode field leaked into the plan DTO');
  assert.ok(body.buffers.every((minutes: number) => minutes === 15), 'off-mode no longer applies today\'s readiness projection');
  assert.ok(!body.storedKeys.includes('readinessApplied'), 'an off-mode build wrote readinessApplied');
});

test('Release parity (passes on base): off and killed, the next step answers today\'s keys and a fresh low reading changes nothing', async () => {
  const body: any = await acrossModes(async (uid) => {
    await grantRecommendations(uid);
    await addCommitment(uid, 'Write the grant proposal', { kind: 'due_by', dueAt: plusMinutes(REFERENCE, 90), endAt: plusMinutes(REFERENCE, 180), allDay: false }, IDS[0]);
    await addCommitment(uid, 'Reply to the landlord', { kind: 'due_by', dueAt: plusMinutes(REFERENCE, 240), endAt: plusMinutes(REFERENCE, 270), allDay: false }, IDS[1]);
    const before = await nextStep(uid);
    await checkIn(uid, 1, plusMinutes(REFERENCE, -30));
    const after = await nextStep(uid);
    return { before, after };
  });
  assert.deepEqual(Object.keys(body.after).sort(), NEXT_STEP_KEYS, 'energy leaked into the off-mode next step');
  assert.equal(body.after.recommendation.primaryStep.commitmentId, IDS[0], 'the lighter rule ran off-mode');
  assert.equal(body.after.recommendation.proposalId, body.before.recommendation.proposalId, 'the off-mode id is salted by the reading');
});

test('Release parity (passes on base): off and killed, the readiness watcher still observes a historical snapshot, as today', async () => {
  await acrossModes(async (uid) => {
    await storeReadingContext(uid, { historicalInference: healthSnapshot(uid, 'low', '2026-10-03T07:00:00.000Z') });
    const observed = await readinessObserver.observe(
      { signalKind: 'readiness', provider: 'userState', subjectRef: 'user' } as any,
      { scopeId: uid, now: NOW() } as any,
      { storage: currentStorage() } as any,
    );
    assert.ok(observed, 'off-mode watcher stopped observing today\'s reading');
    return { stateDigest: observed!.stateDigest };
  });
});

test('R1.1 off and killed: the summary route answers 404 m5b_unavailable, identically', async () => {
  const body: any = await acrossModes(async (uid) => {
    const read = await call(uid, 'memory/summary', 'GET', { query: { language: 'en' } });
    return { status: read.status, body: read.body };
  });
  assert.equal(body.status, 404);
  assert.deepEqual(body.body, { success: false, error: 'm5b_unavailable' });
});

/* ── off / killed after on (M5B-016, plan part) ────────────────────── */

async function onModeData(): Promise<string> {
  const uid = await begin();
  await seedTasks(uid);
  assert.equal((await checkIn(uid, 1, plusMinutes(REFERENCE, -20))).status, 200);
  await buildPlan(uid);
  await replan(uid, REVIEW);
  const stored = await storedPlan(uid);
  assert.ok(stored.readinessApplied, 'setup: the on-mode plan has no readinessApplied');
  assert.ok(stored.proposal?.basisSnapshot, 'setup: the on-mode offer has no basisSnapshot');
  return uid;
}

test('M5B-016 off and killed after on: plan GET and build answer what the same documents answer with the on-mode fields removed', async () => {
  for (const [label, switches] of MODES.slice(0, 2)) {
    const uid = await onModeData();
    setM5bSwitches(switches);
    const withFields = { read: await getPlan(uid), built: await buildPlan(uid) };
    await stripOnModeFields(uid);
    const without = { read: await getPlan(uid), built: await buildPlan(uid) };
    assert.deepEqual(withFields, without, `${label}: an off-mode reader read an on-mode field`);
    assert.deepEqual(Object.keys(withFields.read.plan).sort(), PLAN_DTO_KEYS);
    end();
  }
});

test('M5B-016 off and killed after on: an off regenerate and an off automatic refresh write no readinessApplied', async () => {
  for (const [label, switches] of MODES.slice(0, 2)) {
    const uid = await onModeData();
    setM5bSwitches(switches);
    const rebuilt = await call(uid, 'plans/[date]/regenerate', 'POST', { params: { date: TODAY } });
    assert.equal(rebuilt.status, 200, show(rebuilt.body));
    assert.equal('readinessApplied' in (await storedPlan(uid)), false, `${label}: an off regenerate carried readinessApplied`);
    end();

    // An untouched on-mode plan, refreshed off by a new commitment.
    const fresh = await begin();
    await seedTasks(fresh);
    assert.equal((await checkIn(fresh, 1, plusMinutes(REFERENCE, -20))).status, 200);
    await buildPlan(fresh);
    assert.ok((await storedPlan(fresh)).readinessApplied, 'setup: no readinessApplied');
    setM5bSwitches(switches);
    const generation = (await storedPlan(fresh)).generation;
    await addFloating(fresh, 'Pick up the parcel');
    const read = await getPlan(fresh);
    assert.equal(read.plan.generation, generation + 1, 'fixture: the read did not refresh');
    assert.equal('readinessApplied' in (await storedPlan(fresh)), false, `${label}: an off refreshStalePlan carried readinessApplied through the spread`);
    end();
  }
});

test('M5B-016 off and killed after on: readiness GET has no planEffect, and PUT / POST accept a future timestamp as today', async () => {
  for (const [label, switches] of MODES.slice(0, 2)) {
    const uid = await begin();
    assert.equal((await checkIn(uid, 2, plusMinutes(REFERENCE, -20))).status, 200);
    const on = await call(uid, 'readiness', 'GET');
    assert.ok(on.body.planEffect, 'setup: no planEffect on-mode');
    setM5bSwitches(switches);
    const off = await call(uid, 'readiness', 'GET');
    assert.deepEqual(Object.keys(off.body).sort(), READINESS_KEYS, `${label}: planEffect leaked`);
    assert.equal((await checkIn(uid, 2, plusMinutes(REFERENCE, 10))).status, 200, `${label}: off refused a future check-in`);
    assert.equal((await postHealth(uid, 'low', plusMinutes(REFERENCE, 10))).status, 200, `${label}: off refused a future snapshot`);
    end();
  }
});

test('M5B-016 off and killed after on: the next step has no energy, and its proposalId is today\'s (no salt)', async () => {
  for (const [label, switches] of MODES.slice(0, 2)) {
    const uid = await begin();
    await grantRecommendations(uid);
    await addCommitment(uid, 'Write the grant proposal', { kind: 'due_by', dueAt: plusMinutes(REFERENCE, 90), endAt: plusMinutes(REFERENCE, 180), allDay: false });
    await addCommitment(uid, 'Reply to the landlord', { kind: 'due_by', dueAt: plusMinutes(REFERENCE, 240), endAt: plusMinutes(REFERENCE, 270), allDay: false });
    assert.equal((await checkIn(uid, 1, plusMinutes(REFERENCE, -20))).status, 200);
    const on = await nextStep(uid);
    assert.ok(on.energy, 'setup: no energy on-mode');
    setM5bSwitches(switches);
    const off = await nextStep(uid);
    assert.deepEqual(Object.keys(off).sort(), NEXT_STEP_KEYS, `${label}: energy leaked`);
    await storeReadingContext(uid, {});
    const unread = await nextStep(uid);
    assert.equal(off.recommendation.proposalId, unread.recommendation.proposalId, `${label}: the off-mode id depends on the reading`);
    end();
  }
});
