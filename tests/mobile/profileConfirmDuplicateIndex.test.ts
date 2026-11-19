/**
 * QA CA1.10 / CXA1.7: a confirm listing the same index twice wrote the same
 * fact twice (describe) or applied one candidate twice (import). The shipped
 * app never sends that; the API refuses it before reading the proposal.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor } from '../support/fakeAuth.ts';
import { seedLiveAccount } from '../support/liveAccount.ts';
import { POST as describeConfirm } from '../../src/app/api/mobile/profile/describe/confirm/route.ts';
import { POST as importConfirm } from '../../src/app/api/mobile/profile/import/confirm/route.ts';

const ALICE = uidFor('ConfirmDuplicateAlice');

for (const [name, route, path] of [
  ['describe', describeConfirm, '/api/mobile/profile/describe/confirm'],
  ['import', importConfirm, '/api/mobile/profile/import/confirm'],
] as const) {
  test(`${name} confirm refuses an index listed twice, and still reads a proposal for a clean list`, async () => {
    setStorageForTests(createMemoryStorage());
    const auth = installFakeAuth();
    const previousFlag = process.env.MAYBESITTER_FEATURE_MEMORY;
    process.env.MAYBESITTER_FEATURE_MEMORY = 'true';
    try {
      await seedLiveAccount(ALICE);
      const send = (accepted: unknown[]) => route(new Request(`https://api.maybesitter.test${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${tokenFor(ALICE)}`, 'content-type': 'application/json' },
        body: JSON.stringify({ proposalId: 'no-such-proposal', accepted }),
      }));
      const refused = await send([{ index: 0 }, { index: 0 }]);
      assert.equal(refused.status, 400);
      assert.match((await refused.json() as { error: string }).error, /more than once/);
      // A clean list reaches the proposal lookup (none here).
      const clean = await send([{ index: 0 }, { index: 1 }]);
      assert.equal(clean.status, 404);
      assert.equal((await clean.json() as { reason: string }).reason, 'proposal_not_found');
    } finally {
      if (previousFlag === undefined) delete process.env.MAYBESITTER_FEATURE_MEMORY;
      else process.env.MAYBESITTER_FEATURE_MEMORY = previousFlag;
      auth.restore();
      resetStorageForTests();
    }
  });
}
