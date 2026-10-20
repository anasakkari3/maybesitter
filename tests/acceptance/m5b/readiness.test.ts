/**
 * M5b-1 Gate B — readiness: the route's planEffect, future timestamps, stale
 * presence, and every on-mode readiness consumer reading fresh only
 * (PLAN-M5b-1 R4.1 "One fresh-only resolver", "Readiness consumers",
 * "Writes, when on"; Wire "GET /api/mobile/readiness"; M5B-011, M5B-012,
 * M5B1-002).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readinessObserver } from '../../../lib/watchers/signals.ts';
import { userDoc } from '../../../lib/storage/paths.ts';
import { dayContexts } from '../../../lib/planning/freeSlots.ts';
import { previewSuggestionSchedule, slotStillFitsSchedule } from '../../../lib/intelligence/schedulePreview.ts';
import {
  AUTO_APPLY,
  NOW,
  REFERENCE,
  TODAY,
  TOMORROW,
  TZ,
  addFloating,
  begin,
  buffersOf,
  buildPlan,
  call,
  checkIn,
  currentStorage,
  end,
  getPlan,
  healthSnapshot,
  plusMinutes,
  postHealth,
  replan,
  show,
  storeReadingContext,
  storedPlan,
  threeTasks,
} from './support.ts';

test.afterEach(() => end());

const NO_READING = { snapshot: null, selectedSource: 'none', freshness: 'missing' };

async function readiness(uid: string): Promise<any> {
  const read = await call(uid, 'readiness', 'GET');
  assert.equal(read.status, 200, show(read.body));
  return read.body;
}

/* ── planEffect (Wire, strict) ─────────────────────────────────────── */

test('R4.1 / Wire: a fresh check-in of 2 gives planEffect check_in / 2 / low / 15 and no staleReading, strict shape', async () => {
  const uid = await begin();
  const observedAt = plusMinutes(REFERENCE, -30);
  assert.equal((await checkIn(uid, 2, observedAt)).status, 200);
  const body = await readiness(uid);
  assert.deepEqual(body.planEffect, { source: 'check_in', energy: 2, band: 'low', bufferMinutes: 15, staleReading: null });
  assert.deepEqual(Object.keys(body.planEffect).sort(), ['bufferMinutes', 'band', 'energy', 'source', 'staleReading']);
  assert.equal(body.selectedSource, 'current_subjective');
  assert.equal(body.freshness, 'fresh');
});

test('R4.1: a fresh health snapshot gives planEffect health / energy null / its band; a steady check-in adds nothing', async () => {
  const uid = await begin();
  assert.equal((await postHealth(uid, 'low', plusMinutes(REFERENCE, -60))).status, 200);
  assert.deepEqual((await readiness(uid)).planEffect, { source: 'health', energy: null, band: 'low', bufferMinutes: 15, staleReading: null });
  assert.equal((await checkIn(uid, 3, plusMinutes(REFERENCE, -5))).status, 200);
  assert.deepEqual((await readiness(uid)).planEffect, { source: 'check_in', energy: 3, band: 'steady', bufferMinutes: 0, staleReading: null });
});

test('M5B-011 stale presence: a 13 h check-in with no health data sets staleReading; an account that never sent one has null', async () => {
  const uid = await begin();
  const observedAt = plusMinutes(REFERENCE, -13 * 60);
  await storeReadingContext(uid, { currentSubjective: { energy: 2, observedAt } });
  const body = await readiness(uid);
  assert.deepEqual(body.planEffect, { source: 'none', energy: null, band: null, bufferMinutes: 0, staleReading: { source: 'check_in', observedAt } });
  assert.deepEqual([body.readiness, body.selectedSource, body.freshness], [null, 'none', 'missing']);
  end();
  const never = await begin();
  assert.deepEqual((await readiness(never)).planEffect, { source: 'none', energy: null, band: null, bufferMinutes: 0, staleReading: null });
});

test('M5B-011 stale presence: a historical-only account reports no reading as current and its snapshot as staleReading (health)', async () => {
  const uid = await begin();
  const computedAt = plusMinutes(REFERENCE, -5 * 24 * 60);
  await storeReadingContext(uid, { historicalInference: healthSnapshot(uid, 'low', computedAt) });
  const body = await readiness(uid);
  assert.deepEqual([body.readiness, body.selectedSource, body.freshness], [null, 'none', 'missing'], 'on-mode must never emit historical_inference or stale');
  assert.deepEqual(body.planEffect.staleReading, { source: 'health', observedAt: computedAt });
  assert.equal(body.planEffect.bufferMinutes, 0);
});

test('M5B-012: a stored check-in and health snapshot 10 min in the future are ignored (none / missing, no staleReading)', async () => {
  const uid = await begin();
  const future = plusMinutes(REFERENCE, 10);
  await storeReadingContext(uid, { currentSubjective: { energy: 1, observedAt: future }, recentReadiness: healthSnapshot(uid, 'low', future) });
  const body = await readiness(uid);
  assert.deepEqual([body.readiness, body.selectedSource, body.freshness], [null, 'none', 'missing']);
  assert.deepEqual(body.planEffect, { source: 'none', energy: null, band: null, bufferMinutes: 0, staleReading: null });
});

test('M5B1-002: a fresh low check-in with a stale health snapshot — the readiness snapshot carries no signal from the stale snapshot', async () => {
  const uid = await begin();
  await storeReadingContext(uid, {
    currentSubjective: { energy: 1, observedAt: plusMinutes(REFERENCE, -20) },
    recentReadiness: healthSnapshot(uid, 'high', plusMinutes(REFERENCE, -40 * 60)),
  });
  const body = await readiness(uid);
  assert.equal(body.selectedSource, 'current_subjective');
  assert.ok(body.readiness, show(body));
  assert.ok(!body.readiness.sourceKinds.includes('healthkit'), `the stale health snapshot leaked into sourceKinds: ${show(body.readiness.sourceKinds)}`);
  assert.ok(!body.readiness.signals.some((signal: any) => signal.source?.kind === 'healthkit'), 'a stale health signal was merged into the fresh check-in');
});

/* ── writes (M5B-012) ──────────────────────────────────────────────── */

test('M5B-012 writes: a check-in or health snapshot 10 min in the future answers 400 with the existing reason; 4 min ahead is accepted', async () => {
  const uid = await begin();
  const refused = await checkIn(uid, 2, plusMinutes(REFERENCE, 10));
  assert.equal(refused.status, 400, show(refused.body));
  assert.equal(refused.body.reason, 'invalid_check_in');
  const snapshot = await postHealth(uid, 'low', plusMinutes(REFERENCE, 10));
  assert.equal(snapshot.status, 400, show(snapshot.body));
  assert.equal(snapshot.body.reason, 'invalid_snapshot');
  const user = await currentStorage().get<Record<string, any>>(userDoc(uid));
  assert.equal(user?.readinessContext ?? null, null, 'a refused write stored something');
  assert.equal((await checkIn(uid, 2, plusMinutes(REFERENCE, 4))).status, 200);
  assert.equal((await postHealth(uid, 'low', plusMinutes(REFERENCE, 4))).status, 200);
});

test('M5B-012 writes: a stored future prior does not block a valid newer write (treated as absent in stale_ignored)', async () => {
  const uid = await begin();
  const future = plusMinutes(REFERENCE, 10);
  await storeReadingContext(uid, { currentSubjective: { energy: 5, observedAt: future }, recentReadiness: healthSnapshot(uid, 'high', future) });
  const saved = await checkIn(uid, 2, plusMinutes(REFERENCE, -1));
  assert.equal(saved.status, 200, show(saved.body));
  assert.equal(saved.body.result, 'stored', 'a future-dated prior blocked a valid check-in');
  const health = await postHealth(uid, 'low', plusMinutes(REFERENCE, -1));
  assert.equal(health.status, 200, show(health.body));
  assert.equal(health.body.result, 'stored', 'a future-dated prior blocked a valid snapshot');
  assert.equal((await readiness(uid)).planEffect.energy, 2);
});

/* ── every consumer reads fresh only (M5B1-002) ────────────────────── */

type Kind = 'stale' | 'future' | 'historical';
const KINDS: Kind[] = ['stale', 'future', 'historical'];

async function writeReading(uid: string, kind: Kind): Promise<void> {
  if (kind === 'stale') await storeReadingContext(uid, { currentSubjective: { energy: 1, observedAt: plusMinutes(REFERENCE, -13 * 60) } });
  if (kind === 'future') {
    const future = plusMinutes(REFERENCE, 10);
    await storeReadingContext(uid, { currentSubjective: { energy: 1, observedAt: future }, recentReadiness: healthSnapshot(uid, 'low', future) });
  }
  if (kind === 'historical') await storeReadingContext(uid, { historicalInference: healthSnapshot(uid, 'low', plusMinutes(REFERENCE, -4 * 24 * 60)) });
}

test('M5B1-002 readiness route: stale, future-dated and historical-only each answer readiness null / none / missing (staleReading set for stale and historical, null for future)', async () => {
  for (const kind of KINDS) {
    const uid = await begin();
    await writeReading(uid, kind);
    const body = await readiness(uid);
    assert.deepEqual([body.readiness, body.selectedSource, body.freshness], [null, 'none', 'missing'], `${kind}: ${show(body)}`);
    assert.ok(body.planEffect, `${kind}: no planEffect`);
    if (kind === 'future') assert.equal(body.planEffect.staleReading, null, 'future-only: a future reading is no reading at all');
    else assert.ok(body.planEffect.staleReading, `${kind}: staleReading not set`);
    end();
  }
});

test('M5B1-002 readiness watcher: stale, future-dated and historical-only readings observe null (no firing, no digest)', async () => {
  for (const kind of KINDS) {
    const uid = await begin();
    await writeReading(uid, kind);
    const observed = await readinessObserver.observe(
      { signalKind: 'readiness', provider: 'userState', subjectRef: `user:${uid}` } as any,
      { scopeId: uid, now: NOW() } as any,
      { storage: currentStorage() } as any,
    );
    assert.equal(observed, null, `${kind}: the watcher observed ${show(observed)}`);
    end();
  }
});

test('M5B1-002 plan build, regenerate, automatic refresh and continuous-replan solve: no buffer, bufferMinutesAdded 0', async () => {
  for (const kind of KINDS) {
    const uid = await begin();
    await threeTasks(uid);
    await writeReading(uid, kind);
    const built = await buildPlan(uid);
    assert.ok(built.readinessApplied, `${kind}: the plan DTO has no readinessApplied`);
    assert.equal(built.readinessApplied.bufferMinutesAdded, 0, `${kind}: build`);
    assert.equal(built.readinessApplied.source, 'none');
    assert.ok(buffersOf(await storedPlan(uid)).every((minutes) => minutes === 0), `${kind}: build added a buffer`);

    const rebuilt = await call(uid, 'plans/[date]/regenerate', 'POST', { params: { date: TODAY } });
    assert.equal(rebuilt.status, 200, show(rebuilt.body));
    assert.ok(buffersOf(await storedPlan(uid)).every((minutes) => minutes === 0), `${kind}: regenerate added a buffer`);

    // A new commitment makes the untouched plan stale: the read refreshes it.
    const generation = (await storedPlan(uid)).generation;
    await addFloating(uid, 'Pick up the parcel');
    const refreshed = await getPlan(uid);
    assert.equal(refreshed.plan.generation, generation + 1, `${kind}: fixture — the read did not refresh`);
    assert.ok(buffersOf(await storedPlan(uid)).every((minutes) => minutes === 0), `${kind}: the automatic refresh added a buffer`);

    const report = await replan(uid, AUTO_APPLY);
    assert.equal(report.pipelineResult.policyDecision?.action, 'auto_apply', `${kind}: fixture — the replan did not auto-apply`);
    assert.ok(buffersOf(await storedPlan(uid)).every((minutes) => minutes === 0), `${kind}: the replan solve added a buffer`);
    assert.deepEqual(report.userState?.readiness, NO_READING, `${kind}: the replan run reported a reading as current`);
    end();
  }
});

test('M5B1-002 goal-plan day contexts and the suggestion schedule preview and slot check: identical to the same account with no reading', async () => {
  for (const kind of KINDS) {
    const uid = await begin();
    await threeTasks(uid);
    const storage = currentStorage() as any;
    const action = { id: 'sug-1', kind: 'action', status: 'pending', durationMinutes: 30, title: 'Stretch', observationIds: [] } as any;
    const contextsBefore = await dayContexts(storage, uid, { localDate: TODAY, timezone: TZ }, [TODAY, TOMORROW], NOW());
    const previewBefore = await previewSuggestionSchedule(uid, [action], NOW(), storage);
    assert.ok(previewBefore[0]?.slot, 'fixture: the preview placed nothing');
    const fitsBefore = await slotStillFitsSchedule(uid, action, previewBefore[0]!.slot!, NOW(), storage);

    await writeReading(uid, kind);
    assert.deepEqual(await dayContexts(storage, uid, { localDate: TODAY, timezone: TZ }, [TODAY, TOMORROW], NOW()), contextsBefore, `${kind}: day contexts changed`);
    assert.deepEqual(await previewSuggestionSchedule(uid, [action], NOW(), storage), previewBefore, `${kind}: the schedule preview changed`);
    assert.equal(await slotStillFitsSchedule(uid, action, previewBefore[0]!.slot!, NOW(), storage), fitsBefore, `${kind}: the slot check changed`);
    end();
  }
});

/* ── the census (R4.1: a consumer added later must be listed) ───────── */

test('M5B1-002 census (passes on base by construction): every caller of composeCurrentUserState / resolveReadinessForUserState in lib/** and src/** is in R4.1\'s list', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const listed = new Set([
    'lib/userState/userStateService.ts', // the definition and its one resolver call
    'lib/integrations/readiness/subjectiveEnergy.ts', // the old resolver's definition
    'lib/integrations/readiness/freshReadiness.ts', // the fresh-only resolver (new)
    'lib/services/dailyPlan/dailyPlanService.ts', // 1. plan constraints (projectPlanLayerIntoConstraints)
    'src/app/api/mobile/readiness/route.ts', // 2. the readiness route
    'lib/watchers/signals.ts', // 3. the readiness watcher
    'lib/services/dailyPlan/continuousReplanService.ts', // 4. the replan run's reported user state
    'lib/services/mobile/pilotService.ts', // 5. the next step (nextStepContextFor)
  ]);
  const callers: string[] = [];
  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) { if (name !== 'node_modules') walk(path); continue; }
      if (!/\.(ts|tsx)$/.test(name)) continue;
      const source = readFileSync(path, 'utf8');
      if (/\b(composeCurrentUserState|resolveReadinessForUserState)\s*\(/.test(source)) callers.push(relative(root, path));
    }
  };
  walk(join(root, 'lib'));
  walk(join(root, 'src'));
  const unlisted = callers.filter((file) => !listed.has(file));
  assert.deepEqual(unlisted, [], `a readiness consumer is not in R4.1's list (it must take the readiness: 'fresh' path when on): ${unlisted.join(', ')}`);
});
