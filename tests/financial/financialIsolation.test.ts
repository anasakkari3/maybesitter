/**
 * One account's money is not reachable from another account's session.
 *
 * The structural claim is that every path is built from a uid fixed at
 * construction, so another account's rows are not filtered out of an answer —
 * they were never in the collection it read. These cases hold two accounts in
 * one process at once and check that claim from the outside, including while
 * both are being read at the same time: a module-level cache is exactly how
 * this class of bug appears, and it only appears under concurrency.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { FINANCIAL_INPUTS, userCol } from '../../lib/storage/paths.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { GET as contextGet } from '../../src/app/api/mobile/financial/context/route.ts';
import { GET as manualGet, PUT as manualPut } from '../../src/app/api/mobile/financial/manual/route.ts';
import { POST as connectionPost } from '../../src/app/api/mobile/financial/connection/route.ts';
import { StoredManualFinancialStore } from '../../lib/services/financial/manualFinancialStore.ts';
import { readFinancialState } from '../../lib/services/financial/financialStateService.ts';
import { getStorage } from '../../lib/storage/index.ts';

const BASE = 'http://127.0.0.1:4321';
const ALICE = uidFor('FinancialIsolationAlice');
const BILLIE = uidFor('FinancialIsolationBillie');
const AS_OF = '2026-09-23T09:00:00.000Z';

/** Unmistakable, and only ever written under Billie. */
const BILLIE_ONLY = 'BILLIE-ONLY-PRIVATE-TUITION';

let auth: FakeAuthControls | null = null;

function setup(): () => void {
  setStorageForTests(createMemoryStorage());
  auth = installFakeAuth();
  return () => {
    auth?.restore();
    auth = null;
    resetStorageForTests();
  };
}

function request(uid: string, path: string, init: RequestInit = {}): Request {
  return new Request(`${BASE}/api/mobile/financial/${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${tokenFor(uid)}`,
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
  });
}

const billiesBill = JSON.stringify({
  label: BILLIE_ONLY, category: 'tuition',
  dueAt: '2026-09-27T00:00:00.000Z', amountMinorUnits: 200_000, currency: 'ILS',
});

test('what one account typed is not in the other account\'s state', async () => {
  const teardown = setup();
  try {
    await manualPut(request(BILLIE, 'manual', { method: 'PUT', body: billiesBill }));

    const alice = await readFinancialState({ uid: ALICE, asOf: AS_OF });
    assert.equal(JSON.stringify(alice).includes(BILLIE_ONLY), false);
    assert.deepEqual([...alice.upcomingObligations], []);

    const billie = await readFinancialState({ uid: BILLIE, asOf: AS_OF });
    assert.equal(billie.upcomingObligations[0]?.label, BILLIE_ONLY, 'it was not saved at all, so this proved nothing');
  } finally {
    teardown();
  }
});

test('one account connecting a financial source does not connect the other', async () => {
  const teardown = setup();
  try {
    await connectionPost(request(BILLIE, 'connection', { method: 'POST' }));

    const alice = await readFinancialState({ uid: ALICE, asOf: AS_OF });
    assert.deepEqual([...alice.sourceKinds], []);
    assert.ok(alice.missingSourceKinds.includes('provider'));

    const billie = await readFinancialState({ uid: BILLIE, asOf: AS_OF });
    assert.ok(billie.sourceKinds.includes('provider'), 'the connection did not take, so this proved nothing');
  } finally {
    teardown();
  }
});

test('a store built for one account cannot read the other account\'s rows', async () => {
  const teardown = setup();
  try {
    await manualPut(request(BILLIE, 'manual', { method: 'PUT', body: billiesBill }));

    const asAlice = new StoredManualFinancialStore(ALICE, getStorage());
    const read = await asAlice.read();
    assert.deepEqual([...read.obligations], []);
    assert.deepEqual([...read.fields], []);

    // And the rows really are in a different tree, not merely filtered out.
    const billiesRows = await getStorage().list(userCol(BILLIE, FINANCIAL_INPUTS));
    const alicesRows = await getStorage().list(userCol(ALICE, FINANCIAL_INPUTS));
    assert.equal(billiesRows.length, 1);
    assert.equal(alicesRows.length, 0);
  } finally {
    teardown();
  }
});

test('a route answers the token it was given, not the last one it saw', async () => {
  const teardown = setup();
  try {
    await connectionPost(request(BILLIE, 'connection', { method: 'POST' }));
    await manualPut(request(BILLIE, 'manual', { method: 'PUT', body: billiesBill }));

    const billiesContext = await (await contextGet(request(BILLIE, 'context'))).text();
    const alicesContext = await (await contextGet(request(ALICE, 'context'))).text();

    assert.ok(billiesContext.includes(BILLIE_ONLY));
    assert.equal(alicesContext.includes(BILLIE_ONLY), false);
    assert.ok(alicesContext.includes(`"scopeId":"${ALICE}"`));
  } finally {
    teardown();
  }
});

test('reading both accounts at once keeps them apart', async () => {
  const teardown = setup();
  try {
    await connectionPost(request(BILLIE, 'connection', { method: 'POST' }));
    await manualPut(request(BILLIE, 'manual', { method: 'PUT', body: billiesBill }));
    // Alice has no bank. She states her currency first, which is what the
    // route requires before it will take an amount from anybody.
    await manualPut(request(ALICE, 'manual', {
      method: 'PUT',
      body: JSON.stringify({ field: 'currency', kind: 'statement', value: 'ILS' }),
    }));
    const saved = await manualPut(request(ALICE, 'manual', {
      method: 'PUT',
      body: JSON.stringify({ field: 'savings_goal', kind: 'statement', value: 4_200 }),
    }));
    assert.equal(saved.status, 200, 'Alice could not save her goal at all, so this proved nothing');

    // Twenty interleaved reads, alternating accounts, all in flight together.
    const answers = await Promise.all(
      Array.from({ length: 20 }, (_unused, index) => {
        const uid = index % 2 === 0 ? ALICE : BILLIE;
        return Promise.all([
          contextGet(request(uid, 'context')).then((response) => response.text()),
          manualGet(request(uid, 'manual')).then((response) => response.text()),
        ]).then(([context, manual]) => ({ uid, context, manual }));
      }),
    );

    for (const { uid, context, manual } of answers) {
      assert.ok(context.includes(`"scopeId":"${uid}"`), 'a response came back scoped to the wrong account');
      if (uid === ALICE) {
        assert.equal(context.includes(BILLIE_ONLY), false, 'a concurrent read crossed accounts');
        assert.equal(manual.includes(BILLIE_ONLY), false);
        assert.equal(context.includes('"savingsGoal":null'), false, 'Alice lost her own row under load');
      } else {
        assert.ok(manual.includes(BILLIE_ONLY), 'Billie lost her own row under load');
      }
    }
  } finally {
    teardown();
  }
});

test('an amount with no currency behind it is refused, not quietly swallowed', async () => {
  const teardown = setup();
  try {
    const refused = await manualPut(request(ALICE, 'manual', {
      method: 'PUT',
      body: JSON.stringify({ field: 'savings_goal', kind: 'statement', value: 4_200 }),
    }));
    assert.equal(refused.status, 409);
    assert.equal((await refused.json() as { code: string }).code, 'currency_required');

    // And nothing was written, so a later read cannot surface it half-formed.
    const state = await readFinancialState({ uid: ALICE, asOf: AS_OF });
    assert.equal(state.savingsGoal, null);
    assert.deepEqual([...state.sourceKinds], []);
  } finally {
    teardown();
  }
});
