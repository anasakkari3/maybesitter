/**
 * QA CA2.9: `?referenceTime=garbage` on Today and Upcoming answered 500 with
 * an empty body. A bad client value is a 400 that names the field.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor } from '../support/fakeAuth.ts';
import { seedLiveAccount } from '../support/liveAccount.ts';
import { GET as today } from '../../src/app/api/mobile/commitments/today/route.ts';
import { GET as upcoming } from '../../src/app/api/mobile/commitments/upcoming/route.ts';

const ALICE = uidFor('ReferenceTimeAlice');

for (const [name, route] of [['today', today], ['upcoming', upcoming]] as const) {
  test(`${name}: a referenceTime that is not a date is a 400, and a valid one still answers`, async () => {
    setStorageForTests(createMemoryStorage());
    const auth = installFakeAuth();
    try {
      await seedLiveAccount(ALICE);
      const ask = (query: string) => route(new Request(`https://api.maybesitter.test/api/mobile/commitments/${name}?timezone=Asia/Hebron${query}`, {
        headers: { authorization: `Bearer ${tokenFor(ALICE)}` },
      }));
      const refused = await ask('&referenceTime=garbage');
      assert.equal(refused.status, 400);
      const body = await refused.json() as { success: boolean; error: string };
      assert.equal(body.success, false);
      assert.match(body.error, /referenceTime/);
      assert.equal((await ask('&referenceTime=2026-11-12T08:00:00Z')).status, 200);
      assert.equal((await ask('')).status, 200);
    } finally {
      auth.restore();
      resetStorageForTests();
    }
  });
}
