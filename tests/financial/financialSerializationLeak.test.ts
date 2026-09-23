/**
 * Nothing raw survives the trip to a client.
 *
 * The import guards next door stop a *dependency*. This stops the data: it
 * runs the real service and the real routes over the fixture the sandbox
 * actually ships, serializes everything that comes back, and looks for strings
 * that could only have come from a transaction row.
 *
 * The failure paths are exercised too. A route that refuses is the one most
 * likely to hand back whatever it was holding when it gave up, and an error
 * body is still a response body.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { GET as contextGet } from '../../src/app/api/mobile/financial/context/route.ts';
import {
  DELETE as manualDelete,
  GET as manualGet,
  PUT as manualPut,
} from '../../src/app/api/mobile/financial/manual/route.ts';
import {
  DELETE as connectionDelete,
  GET as connectionGet,
  POST as connectionPost,
} from '../../src/app/api/mobile/financial/connection/route.ts';
import { readFinancialState } from '../../lib/services/financial/financialStateService.ts';
import { assertNoSentinel, RAW_FINANCIAL_SENTINELS } from './financialSentinels.ts';

const BASE = 'http://127.0.0.1:4321';
const USER = uidFor('FinancialLeakUser');
const AS_OF = '2026-09-23T09:00:00.000Z';

let auth: FakeAuthControls | null = null;

function setup(storage?: StorageAdapter): () => void {
  setStorageForTests(storage ?? createMemoryStorage());
  auth = installFakeAuth();
  return () => {
    auth?.restore();
    auth = null;
    resetStorageForTests();
  };
}

function request(path: string, init: RequestInit = {}, uid = USER): Request {
  return new Request(`${BASE}/api/mobile/financial/${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${tokenFor(uid)}`,
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
  });
}

const ok = (condition: boolean, message: string) => assert.ok(condition, message);

test('the sentinels are actually in the fixture, so a green run means something', async () => {
  const fixture = await import('node:fs').then((fs) =>
    fs.readFileSync('lib/integrations/financial/sandbox/__fixtures__/household.json', 'utf8'),
  );
  for (const sentinel of RAW_FINANCIAL_SENTINELS) {
    assert.ok(fixture.includes(sentinel), `${sentinel} is not in the fixture: this guard would pass vacuously`);
  }
});

test('the built state carries none of it', async () => {
  const teardown = setup();
  try {
    await connectionPost(request('connection', { method: 'POST' }));
    const state = await readFinancialState({ uid: USER, asOf: AS_OF });
    // The state is not empty, or there would be nothing for a leak to be in.
    assert.ok(state.cashAvailable !== null, 'the sandbox produced nothing to inspect');
    assert.ok(state.upcomingObligations.length > 0);
    assertNoSentinel(JSON.stringify(state), ok, 'the financial state');
  } finally {
    teardown();
  }
});

test('every route body carries none of it, on the happy path', async () => {
  const teardown = setup();
  try {
    await connectionPost(request('connection', { method: 'POST' }));
    await manualPut(request('manual', {
      method: 'PUT',
      body: JSON.stringify({ label: 'Tuition', category: 'tuition', dueAt: '2026-09-27T00:00:00.000Z', amountMinorUnits: 200_000, currency: 'ILS' }),
    }));

    const responses = await Promise.all([
      contextGet(request('context')),
      manualGet(request('manual')),
      connectionGet(request('connection')),
    ]);
    for (const response of responses) {
      assert.equal(response.status, 200);
      assertNoSentinel(await response.text(), ok, 'a route response');
    }
  } finally {
    teardown();
  }
});

test('a refusal carries none of it either', async () => {
  const teardown = setup();
  try {
    const refusals = await Promise.all([
      // Malformed body.
      manualPut(request('manual', { method: 'PUT', body: '{' })),
      // A field this product does not know.
      manualPut(request('manual', { method: 'PUT', body: JSON.stringify({ field: 'bank_password', kind: 'statement', value: 1 }) })),
      // An amount that is not an integer of minor units.
      manualPut(request('manual', { method: 'PUT', body: JSON.stringify({ field: 'cash_available', kind: 'statement', value: 12.34 }) })),
      // Nothing named to delete.
      manualDelete(request('manual', { method: 'DELETE' })),
    ]);
    for (const response of refusals) {
      assert.equal(response.status, 400);
      assertNoSentinel(await response.text(), ok, 'a refusal');
    }
  } finally {
    teardown();
  }
});

test('a storage failure that quotes the payload does not quote it back to the client', async () => {
  /*
   * Delegating rather than spreading: `createMemoryStorage` returns a class
   * instance, and `{...instance}` copies its fields and leaves its prototype
   * methods behind — which fails for a different reason than the one this
   * guard is about, and would have passed it for the wrong reason.
   */
  const base = createMemoryStorage() as unknown as StorageAdapter;
  const exploding: StorageAdapter = Object.assign(Object.create(base) as StorageAdapter, {
    list: async () => {
      // The shape of the thing this guard exists for: an upstream error that
      // helpfully includes the document it choked on.
      throw new Error('FAILED_PRECONDITION reading MCDONALDS ZEBRAHOUSE sbx-txn-0004 ****4432');
    },
  });
  const teardown = setup(exploding);
  try {
    for (const response of [await contextGet(request('context')), await manualGet(request('manual'))]) {
      assert.equal(response.status, 500);
      assertNoSentinel(await response.text(), ok, 'a 500 body');
    }
  } finally {
    teardown();
  }
});

test('disconnecting leaves nothing raw behind in what comes back', async () => {
  const teardown = setup();
  try {
    await connectionPost(request('connection', { method: 'POST' }));
    const removed = await connectionDelete(request('connection', { method: 'DELETE' }));
    assertNoSentinel(await removed.text(), ok, 'the disconnect response');
    const after = await contextGet(request('context'));
    const body = await after.text();
    assertNoSentinel(body, ok, 'the context after disconnecting');
    assert.ok(body.includes('"provider"'), 'the provider should now be listed as a missing source');
  } finally {
    teardown();
  }
});
