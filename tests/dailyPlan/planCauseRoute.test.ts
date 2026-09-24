/**
 * `GET /api/mobile/plans/[date]/cause` (#527, AC 2).
 *
 * Route exposing which monitor/watcher caused a daily plan replan.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage, type MemoryStorageAdapter } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { GET as planCauseGet } from '../../src/app/api/mobile/plans/[date]/cause/route.ts';
import { planPath, type StoredDailyPlan } from '../../lib/services/dailyPlan/planStore.ts';
import type { WatcherFireEvent } from '../../src/contracts/v1/watcherContracts.ts';
import { userSubDoc } from '../../lib/storage/paths.ts';
import type { StoredPlanCause } from '../../lib/services/dailyPlan/planCause.ts';

const BASE = 'https://api.maybesitter.test';
const ALICE = uidFor('AlicePlanCause');
const DATE = '2026-09-24';
const T0 = '2026-09-24T08:00:00.000Z';

let storage: MemoryStorageAdapter;
let auth: FakeAuthControls | null = null;

function begin(): void {
  storage = createMemoryStorage();
  setStorageForTests(storage);
  auth = installFakeAuth();
}

function end(): void {
  auth?.restore();
  auth = null;
  resetStorageForTests();
}

function req(path: string, uid?: string): Request {
  const headers = new Headers();
  if (uid) headers.set('authorization', `Bearer ${tokenFor(uid)}`);
  return new Request(`${BASE}${path}`, { headers });
}

function dateParams(date: string): { params: Promise<{ date: string }> } {
  return { params: Promise.resolve({ date }) };
}

test('GET /api/mobile/plans/[date]/cause authenticates and returns 404 for missing plan', async () => {
  begin();
  try {
    const anon = await planCauseGet(req(`/api/mobile/plans/${DATE}/cause`), dateParams(DATE));
    assert.equal(anon.status, 401);

    const badDate = await planCauseGet(req('/api/mobile/plans/bad-date/cause', ALICE), dateParams('bad-date'));
    assert.equal(badDate.status, 400);

    const missing = await planCauseGet(req(`/api/mobile/plans/${DATE}/cause`, ALICE), dateParams(DATE));
    assert.equal(missing.status, 404);
  } finally {
    end();
  }
});

test('GET /api/mobile/plans/[date]/cause exposes stored plan cause with attributions', async () => {
  begin();
  try {
    const changeId = 'watcher:sha256_cause_1';
    const watcherId = 'wtc_00000000-0000-4000-8000-000000000099';

    // Seed a plan with causeChangeIds
    const storedPlan = {
      version: 'v1',
      schemaVersion: 'daily-plan-v1',
      date: DATE,
      timezone: 'UTC',
      locale: 'en',
      status: 'accepted',
      generation: 2,
      inputDigest: 'digest_1',
      generatedAt: T0,
      acceptedAt: T0,
      updatedAt: T0,
      explanation: { text: 'Rebuilt for flight delay', locale: 'en', source: 'template', validated: true },
      plan: {
        version: 'v1',
        schema: 'v1',
        scopeId: ALICE,
        inputDigest: 'digest_1',
        constraintReasons: [],
        horizon: { startsAt: `${DATE}T00:00:00.000Z`, endsAt: `${DATE}T23:59:59.999Z` },
        scheduled: [],
        unscheduled: [],
      },
      edits: { moves: [], removals: [] },
      blocks: [],
      causeChangeIds: [changeId],
    } as unknown as StoredDailyPlan;
    await storage.set(planPath(ALICE, DATE), storedPlan);

    // Seed matching firing
    const firing: WatcherFireEvent = {
      version: 'v1',
      schemaVersion: 'watcher-event-v1',
      eventId: 'evt_cause_1',
      watcherId,
      scopeId: ALICE,
      signalId: 'sig_flight_1',
      provider: 'aviation',
      signalKind: 'flight',
      subjectRef: 'ba162',
      observedAt: T0,
      firedAt: T0,
      effect: 'replan_if_impacted',
      outcome: 'effected',
      reason: 'digest_changed',
      policyDecision: 'allowed',
      provenanceRef: 'aviation/flights/ba162',
      effectRef: changeId,
    };
    await storage.set(userSubDoc(ALICE, 'watcherEvents', 'evt_cause_1'), firing);

    const response = await planCauseGet(req(`/api/mobile/plans/${DATE}/cause`, ALICE), dateParams(DATE));
    assert.equal(response.status, 200);

    const body = (await response.json()) as { success: true; cause: StoredPlanCause };
    assert.equal(body.success, true);
    assert.equal(body.cause.date, DATE);
    assert.equal(body.cause.generation, 2);
    assert.deepEqual(body.cause.causeChangeIds, [changeId]);
    assert.equal(body.cause.attributions.length, 1);
    assert.equal(body.cause.attributions[0]!.watcherId, watcherId);
    assert.equal(body.cause.attributions[0]!.label, 'aviation:flight');
  } finally {
    end();
  }
});
