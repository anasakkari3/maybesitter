import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { getFollowedClubs, setFollowedClubs, listFollowedClubIdsAcrossUsers } from '../../lib/football/followedClubs.ts';
import { AccountUnavailableError } from '../../lib/account/accountLiveness.ts';
import { seedLiveAccount } from '../support/liveAccount.ts';

const NOW = '2026-09-16T09:00:00.000Z';

// A follow is saved only under a live account (#772): authentication has
// created both users' documents, with their trust records, before any write.
test.beforeEach(async () => {
  setStorageForTests(createMemoryStorage());
  await seedLiveAccount('u1');
  await seedLiveAccount('u2');
});
test.afterEach(() => resetStorageForTests());

test('following nothing is an empty list, not an error', async () => {
  assert.deepEqual(await getFollowedClubs('u1'), []);
});

test('a follow round-trips', async () => {
  await setFollowedClubs('u1', ['barcelona'], NOW);
  assert.deepEqual(await getFollowedClubs('u1'), ['barcelona']);
});

test('more than one club is supported', async () => {
  await setFollowedClubs('u1', ['barcelona', 'liverpool'], NOW);
  assert.deepEqual([...await getFollowedClubs('u1')].sort(), ['barcelona', 'liverpool']);
});

test('an unknown club id is rejected', async () => {
  // The id is a document key for the sync. Accepting one the curated list does
  // not contain means a nightly job asking a provider about nothing, for ever.
  await assert.rejects(() => setFollowedClubs('u1', ['not-a-club'], NOW), /unknown club/i);
});

test('duplicates collapse', async () => {
  await setFollowedClubs('u1', ['barcelona', 'barcelona'], NOW);
  assert.deepEqual(await getFollowedClubs('u1'), ['barcelona']);
});

test('the sync can ask which clubs have any follower at all', async () => {
  await setFollowedClubs('u1', ['barcelona'], NOW);
  await setFollowedClubs('u2', ['barcelona', 'liverpool'], NOW);
  assert.deepEqual([...await listFollowedClubIdsAcrossUsers()].sort(), ['barcelona', 'liverpool']);
});

test('a follow for an account that is gone or marked deleted is refused and writes nothing (#772)', async () => {
  // Swept: no users/{uid} at all. The follow used to re-create its own
  // document under the deleted account, and the nightly sync kept finding it.
  await assert.rejects(() => setFollowedClubs('gone', ['barcelona'], NOW), AccountUnavailableError);
  assert.deepEqual(await getFollowedClubs('gone'), []);
  assert.deepEqual([...await listFollowedClubIdsAcrossUsers()], []);
});
