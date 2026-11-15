/**
 * A revoked account keeps its two data rights (C12.1).
 *
 * «وقّف المشاركة» stamps `trust.revokedAt`, and from then on every mobile
 * route answered 403 `revoked` — `DELETE /api/mobile/account` and
 * `GET /api/mobile/account/export` included. The QA run left account v32
 * undeletable except by an operator, while the revoke screen promises the
 * data stays until the person deletes it.
 *
 * The two routes that serve a person's rights over their own data admit a
 * revoked session; every other route still refuses it, and a deleted account
 * is still refused everywhere.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { getStorage, resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { userDoc } from '../../lib/storage/paths.ts';
import { setDeletionAuthForTests } from '../../lib/account/accountDeletion.ts';
import { resetDeletionHooksForTests } from '../../lib/account/deletionHooks.ts';
import { applyTrustAction, getOrCreateTrust } from '../../lib/pilot/pilotTrustStore.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { DELETE as accountDelete } from '../../src/app/api/mobile/account/route.ts';
import { GET as exportGet } from '../../src/app/api/mobile/account/export/route.ts';
import { GET as profileGet } from '../../src/app/api/mobile/profile/route.ts';

const baseUrl = 'http://localhost:3000';

let auth: FakeAuthControls | null = null;
let firebaseDeleted: string[] = [];

function begin(): void {
  process.env.MAYBESITTER_DELETION_RECEIPT_PEPPER = 'revoked-rights-pepper';
  resetDeletionHooksForTests();
  auth = installFakeAuth();
  firebaseDeleted = [];
  setDeletionAuthForTests({
    async revokeRefreshTokens() {},
    async deleteUser(uid) { firebaseDeleted.push(uid); },
  });
  setStorageForTests(createMemoryStorage());
}

function end(): void {
  setDeletionAuthForTests(null);
  resetStorageForTests();
  auth?.restore();
  auth = null;
  resetDeletionHooksForTests();
  delete process.env.MAYBESITTER_DELETION_RECEIPT_PEPPER;
}

function authed(uid: string, path: string, init: RequestInit = {}): Request {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  headers.set('authorization', `Bearer ${tokenFor(uid)}`);
  return new Request(`${baseUrl}${path}`, { ...init, headers });
}

async function revoked(name: string): Promise<string> {
  const uid = uidFor(name);
  await getOrCreateTrust(uid, new Date(Date.now() - 1000).toISOString());
  await applyTrustAction(uid, { type: 'revoke', at: new Date().toISOString() });
  return uid;
}

test('a revoked account can still export its data', async () => {
  begin();
  try {
    const uid = await revoked('RevokedExport');
    const response = await exportGet(authed(uid, '/api/mobile/account/export'));
    assert.equal(response.status, 200, 'a revoked account could not export its own data');
    const body = await response.json() as { account: { uid: string } };
    assert.equal(body.account.uid, uid);
    assert.equal(auth!.lastForceRevocationCheck(), true);
  } finally {
    end();
  }
});

test('a revoked account can still delete itself', async () => {
  begin();
  try {
    const uid = await revoked('RevokedDelete');
    const response = await accountDelete(authed(uid, '/api/mobile/account', {
      method: 'DELETE',
      body: JSON.stringify({ confirmation: 'delete-my-account' }),
    }));
    assert.equal(response.status, 200, 'a revoked account could not delete itself');
    assert.equal(await getStorage().get(userDoc(uid)), null);
    assert.deepEqual(firebaseDeleted, [uid]);
  } finally {
    end();
  }
});

test('every other route still refuses a revoked account', async () => {
  begin();
  try {
    const uid = await revoked('RevokedElsewhere');
    const response = await profileGet(authed(uid, '/api/mobile/profile'));
    assert.equal(response.status, 403);
    assert.equal((await response.json() as { reason: string }).reason, 'revoked');
  } finally {
    end();
  }
});

test('a deleted account is still refused by export and deletion', async () => {
  begin();
  try {
    const uid = uidFor('AlreadyDeleted');
    await getOrCreateTrust(uid, new Date(Date.now() - 1000).toISOString());
    await applyTrustAction(uid, { type: 'delete', at: new Date().toISOString() });
    const exported = await exportGet(authed(uid, '/api/mobile/account/export'));
    assert.equal(exported.status, 403);
    assert.equal((await exported.json() as { reason: string }).reason, 'deleted');
    const deleted = await accountDelete(authed(uid, '/api/mobile/account', {
      method: 'DELETE',
      body: JSON.stringify({ confirmation: 'delete-my-account' }),
    }));
    assert.equal(deleted.status, 403);
    assert.equal((await deleted.json() as { reason: string }).reason, 'deleted');
  } finally {
    end();
  }
});
