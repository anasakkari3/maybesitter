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

/**
 * The lock the old mobile «وقّف» left (before #873): the revoke and, in the
 * same request, its audit line `revoked` / `revoke` — the trace that tells it
 * apart from the operator's `scripts/revoke-user.ts`, which never wrote one.
 */
async function selfStopped(name: string, at = new Date()): Promise<string> {
  const { createPilotAuditEvent } = await import('../../lib/pilot/closedPilotControls.ts');
  const uid = uidFor(name);
  await getOrCreateTrust(uid, new Date(at.getTime() - 1000).toISOString());
  await applyTrustAction(uid, { type: 'revoke', at: at.toISOString() }, {
    audit: createPilotAuditEvent({
      version: 'v1', eventType: 'revoked', participantId: uid, occurredAt: at.toISOString(), outcome: 'recorded', reasonCode: 'revoke',
    }),
  });
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

test('only the export, deletion and resume routes admit a revoked account', async () => {
  // Any mention of the identifier counts — `allowRevoked: true`, the shorthand
  // `{ allowRevoked }`, a variable, a wrapper that forwards it — because each
  // is a way for a third caller to let a revoked account back into the
  // product. Only the guard that defines it and the two data-rights routes
  // may name it.
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join, relative, sep } = await import('node:path');
  const repo = process.cwd();
  const allowed = new Set([
    'lib/auth/mobileAuth.ts',
    'src/app/api/mobile/account/route.ts',
    'src/app/api/mobile/account/export/route.ts',
    // «رجّع حسابي»: the way back for an account locked before #873.
    'src/app/api/mobile/account/resume/route.ts',
  ]);
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(?:[cm]?[jt]sx?)$/.test(entry) && /\ballowRevoked\b/.test(readFileSync(path, 'utf8'))) {
        found.push(relative(repo, path).split(sep).join('/'));
      }
    }
  };
  walk(join(repo, 'src'));
  walk(join(repo, 'lib'));
  assert.deepEqual(found.filter(file => !allowed.has(file)), [], 'allowRevoked is named outside its allow-list');
  // And the two routes really do use it: the rights tests above fail without.
  for (const file of Array.from(allowed)) assert.ok(found.includes(file), `${file} no longer names allowRevoked`);
});

/* ── «رجّع حسابي»: an account locked before #873 comes back (QA v3) ── */

// Before #873, «وقّف» stamped `trust.revokedAt` and every route but export and
// deletion answered 403 `revoked`. Accounts locked that way (qa-v3-d3-main,
// maybe some in production) had no way back. `POST /api/mobile/account/resume`
// clears the stamp for the caller's own account only: suggestions and learning
// stay off until the person turns them on, and a deleted account never returns.

async function resume(uid: string, init: RequestInit = {}): Promise<Response> {
  const { POST } = await import('../../src/app/api/mobile/account/resume/route.ts');
  return POST(authed(uid, '/api/mobile/account/resume', { method: 'POST', ...init }));
}

/** An account that agreed to both questions, then pressed the old «وقّف». */
async function lockedAfterAgreeing(name: string): Promise<string> {
  const { setRecommendationConsent, RECOMMENDATION_CONSENT_VERSION } = await import('../../lib/consents/recommendationConsentService.ts');
  const { setPersonalizationConsent, PERSONALIZATION_CONSENT_VERSION } = await import('../../lib/consents/personalizationConsentService.ts');
  const uid = uidFor(name);
  const before = new Date(Date.now() - 2000);
  await getOrCreateTrust(uid, before.toISOString());
  await setRecommendationConsent(uid, { state: 'granted', version: RECOMMENDATION_CONSENT_VERSION, at: before });
  await setPersonalizationConsent(uid, { state: 'granted', version: PERSONALIZATION_CONSENT_VERSION, at: before });
  const { createPilotAuditEvent } = await import('../../lib/pilot/closedPilotControls.ts');
  const lockedAt = new Date(Date.now() - 1000).toISOString();
  await applyTrustAction(uid, { type: 'revoke', at: lockedAt }, {
    audit: createPilotAuditEvent({
      version: 'v1', eventType: 'revoked', participantId: uid, occurredAt: lockedAt, outcome: 'recorded', reasonCode: 'revoke',
    }),
  });
  return uid;
}

test('a revoked account brings itself back, with suggestions and learning still off', async () => {
  begin();
  try {
    const { getRecommendationConsent } = await import('../../lib/consents/recommendationConsentService.ts');
    const { personalizationGrowthAllowed } = await import('../../lib/consents/personalizationConsentService.ts');
    const { listAuditEvents, readTrust } = await import('../../lib/pilot/pilotTrustStore.ts');
    const uid = await lockedAfterAgreeing('RevokedResume');
    assert.equal((await profileGet(authed(uid, '/api/mobile/profile'))).status, 403);

    const response = await resume(uid);
    assert.equal(response.status, 200, 'a revoked account could not bring itself back');
    assert.equal(auth!.lastForceRevocationCheck(), true);
    const body = await response.json() as { success: boolean; trust: { revokedAt: string | null; recommendationConsent: boolean; analyticsConsent: boolean; calendarConsent: boolean } };
    assert.equal(body.success, true);
    assert.equal(body.trust.revokedAt, null);
    assert.equal(body.trust.recommendationConsent, false);
    assert.equal(body.trust.analyticsConsent, false);
    assert.equal(body.trust.calendarConsent, false);
    assert.equal((await readTrust(uid))?.revokedAt, null);

    // The account answers again.
    assert.notEqual((await profileGet(authed(uid, '/api/mobile/profile'))).status, 403);
    const { GET: trustGet } = await import('../../src/app/api/mobile/pilot/trust/route.ts');
    assert.equal((await trustGet(authed(uid, '/api/mobile/pilot/trust'))).status, 200);
    // The yes given before the lock is not silently back.
    assert.equal(await getRecommendationConsent(uid), 'declined');
    assert.equal(await personalizationGrowthAllowed(uid), false);

    // One audit line, codes only.
    const lines = (await listAuditEvents(uid)).filter((event) => event.reasonCode === 'resume_account');
    assert.equal(lines.length, 1);
    assert.deepEqual(Object.keys(lines[0]!).sort(), ['eventType', 'occurredAt', 'outcome', 'participantId', 'reasonCode', 'version']);
  } finally {
    end();
  }
});

test('resuming an account that is not revoked changes nothing and writes nothing', async () => {
  begin();
  try {
    const { listAuditEvents, readTrust } = await import('../../lib/pilot/pilotTrustStore.ts');
    const uid = uidFor('NotRevokedResume');
    await getOrCreateTrust(uid, new Date(Date.now() - 1000).toISOString());
    const before = await readTrust(uid);
    const response = await resume(uid);
    assert.equal(response.status, 200);
    assert.deepEqual(await readTrust(uid), before);
    assert.equal((await listAuditEvents(uid)).length, 0);
  } finally {
    end();
  }
});

test('a deleted account is never brought back', async () => {
  begin();
  try {
    const { readTrust } = await import('../../lib/pilot/pilotTrustStore.ts');
    const uid = uidFor('DeletedResume');
    await getOrCreateTrust(uid, new Date(Date.now() - 2000).toISOString());
    await applyTrustAction(uid, { type: 'revoke', at: new Date(Date.now() - 1000).toISOString() });
    await applyTrustAction(uid, { type: 'delete', at: new Date().toISOString() });
    const response = await resume(uid);
    assert.equal(response.status, 403);
    assert.equal((await response.json() as { reason: string }).reason, 'deleted');
    const after = await readTrust(uid);
    assert.ok(after?.deletedAt);
    assert.ok(after?.revokedAt, 'a deleted account had its revocation cleared');

    // And one swept by the real deletion is not re-created by a resume.
    const swept = await selfStopped('SweptResume');
    const deleted = await accountDelete(authed(swept, '/api/mobile/account', {
      method: 'DELETE',
      body: JSON.stringify({ confirmation: 'delete-my-account' }),
    }));
    assert.equal(deleted.status, 200);
    const again = await resume(swept);
    assert.notEqual(again.status, 200);
    assert.equal(await getStorage().get(userDoc(swept)), null, 'a resume re-created a deleted account');
  } finally {
    end();
  }
});

test('a resume only ever reaches the caller\'s own account', async () => {
  begin();
  try {
    const { readTrust } = await import('../../lib/pilot/pilotTrustStore.ts');
    const mine = await selfStopped('ResumeMine');
    const theirs = await selfStopped('ResumeTheirs');
    const response = await resume(mine, {
      body: JSON.stringify({ uid: theirs, participantId: theirs }),
      headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(response.status, 200);
    assert.equal((await readTrust(mine))?.revokedAt, null);
    assert.ok((await readTrust(theirs))?.revokedAt, 'another account was resumed');

    // Without a token there is no account to resume.
    const { POST } = await import('../../src/app/api/mobile/account/resume/route.ts');
    const anonymous = await POST(new Request(`${baseUrl}/api/mobile/account/resume`, { method: 'POST' }));
    assert.equal(anonymous.status, 401);
    assert.ok((await readTrust(theirs))?.revokedAt);
  } finally {
    end();
  }
});


/* ── An operator's stop is not the person's to undo (review of #883) ── */

// `scripts/revoke-user.ts` is the operator's «إنهاء وصول» (docs/operations/
// V03_PILOT_OPERATIONAL_DEPLOYMENT.md, Participant Revoke). It stamped the
// same `revokedAt` as the old «وقّف», so the resume route would have let the
// person lift it with one press after signing in again.

async function operatorRevoked(name: string): Promise<string> {
  const { revokeAccountAsOperator } = await import('../../lib/pilot/operatorRevoke.ts');
  const uid = uidFor(name);
  await getOrCreateTrust(uid, new Date(Date.now() - 1000).toISOString());
  const cut: string[] = [];
  await revokeAccountAsOperator(uid, { revokeRefreshTokens: async (id) => { cut.push(id); } });
  assert.deepEqual(cut, [uid], 'the operator revoke did not cut the refresh tokens');
  return uid;
}

test('an operator revoke cannot be lifted from the app', async () => {
  begin();
  try {
    const { readTrust, listAuditEvents } = await import('../../lib/pilot/pilotTrustStore.ts');
    const uid = await operatorRevoked('OperatorResume');
    const before = await readTrust(uid);
    assert.equal(before?.revokedBy, 'operator');

    const response = await resume(uid);
    assert.equal(response.status, 403, 'an operator revoke was lifted by the account');
    assert.equal((await response.json() as { reason: string }).reason, 'operator_revoked');
    assert.deepEqual(await readTrust(uid), before, 'the refused resume changed the trust record');
    assert.equal((await listAuditEvents(uid)).some((event) => event.reasonCode === 'resume_account'), false);

    // The other routes say who stopped it, so the app can say so too.
    const elsewhere = await profileGet(authed(uid, '/api/mobile/profile'));
    assert.equal(elsewhere.status, 403);
    assert.deepEqual(await elsewhere.json(), {
      success: false, error: 'this account was revoked', reason: 'revoked', revokedBy: 'operator',
    });
    // Its data rights stay.
    assert.equal((await exportGet(authed(uid, '/api/mobile/account/export'))).status, 200);
  } finally {
    end();
  }
});

test('the operator script revokes through the marked operator path', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync('scripts/revoke-user.ts', 'utf8');
  assert.match(source, /revokeAccountAsOperator\(/);
  assert.doesNotMatch(source, /type: 'revoke'/, 'the script still writes an unmarked revoke');
});

test('a revoke written before the mark exists is the person\'s only when its «وقّف» audit line is there', async () => {
  begin();
  try {
    const { readTrust } = await import('../../lib/pilot/pilotTrustStore.ts');
    // The old operator script: a revoke and no audit line at all.
    const operatorOld = await revoked('LegacyOperatorResume');
    const refused = await resume(operatorOld);
    assert.equal(refused.status, 403, 'an unmarked revoke with no «وقّف» line was lifted');
    assert.equal((await refused.json() as { reason: string }).reason, 'operator_revoked');
    assert.ok((await readTrust(operatorOld))?.revokedAt);

    // The old «وقّف»: its audit line sits at the revoke.
    const self = await selfStopped('LegacySelfResume');
    assert.equal((await resume(self)).status, 200);
    assert.equal((await readTrust(self))?.revokedAt, null);
  } finally {
    end();
  }
});

test('a «وقّف» line long before the lock does not make a later unmarked revoke the person\'s', async () => {
  begin();
  try {
    const { createPilotAuditEvent } = await import('../../lib/pilot/closedPilotControls.ts');
    const { appendAudit, readTrust } = await import('../../lib/pilot/pilotTrustStore.ts');
    const uid = uidFor('StaleStopLine');
    const day = 24 * 60 * 60 * 1000;
    await getOrCreateTrust(uid, new Date(Date.now() - 3 * day).toISOString());
    await appendAudit(createPilotAuditEvent({
      version: 'v1', eventType: 'revoked', participantId: uid,
      occurredAt: new Date(Date.now() - 2 * day).toISOString(), outcome: 'recorded', reasonCode: 'revoke',
    }));
    await applyTrustAction(uid, { type: 'revoke', at: new Date().toISOString() });
    const refused = await resume(uid);
    assert.equal(refused.status, 403);
    assert.ok((await readTrust(uid))?.revokedAt);
  } finally {
    end();
  }
});

test('a resume that loses a race never turns off what the person turned on after the first one', async () => {
  begin();
  try {
    const { resumeRevokedAccount } = await import('../../lib/services/mobile/pilotService.ts');
    const { getRecommendationConsent, setRecommendationConsent, RECOMMENDATION_CONSENT_VERSION } = await import('../../lib/consents/recommendationConsentService.ts');
    const { personalizationGrowthAllowed, setPersonalizationConsent, PERSONALIZATION_CONSENT_VERSION } = await import('../../lib/consents/personalizationConsentService.ts');
    const uid = await lockedAfterAgreeing('RacingResume');
    // The second press read the account while it was still locked; the first
    // press finished, and the person turned both back on, before it went on.
    const result = await resumeRevokedAccount(uid, {
      afterRead: async () => {
        assert.equal((await resume(uid)).status, 200);
        await setRecommendationConsent(uid, { state: 'granted', version: RECOMMENDATION_CONSENT_VERSION });
        await setPersonalizationConsent(uid, { state: 'granted', version: PERSONALIZATION_CONSENT_VERSION });
      },
    });
    assert.equal(result.trust.revokedAt, null);
    assert.equal(await getRecommendationConsent(uid), 'granted', 'the late resume declined suggestions again');
    assert.equal(await personalizationGrowthAllowed(uid), true, 'the late resume turned learning off again');
  } finally {
    end();
  }
});

test('the team stopping an account the person had already stopped is still the team\'s, and nothing is declined', async () => {
  begin();
  try {
    const { revokeAccountAsOperator } = await import('../../lib/pilot/operatorRevoke.ts');
    const { readTrust } = await import('../../lib/pilot/pilotTrustStore.ts');
    const { getRecommendationConsent } = await import('../../lib/consents/recommendationConsentService.ts');
    const { personalizationGrowthAllowed } = await import('../../lib/consents/personalizationConsentService.ts');
    const uid = await lockedAfterAgreeing('OperatorOverSelfStop');
    await revokeAccountAsOperator(uid, { revokeRefreshTokens: async () => {} });
    assert.equal((await readTrust(uid))?.revokedBy, 'operator');
    const response = await resume(uid);
    assert.equal(response.status, 403);
    assert.equal((await response.json() as { reason: string }).reason, 'operator_revoked');
    // Refused before anything was written: the answers given before the lock are as they were.
    assert.equal(await getRecommendationConsent(uid), 'granted');
    assert.equal(await personalizationGrowthAllowed(uid), true);
  } finally {
    end();
  }
});

test('a resume whose lock lifts between its two declines never turns learning off again', async () => {
  begin();
  try {
    const { resumeRevokedAccount } = await import('../../lib/services/mobile/pilotService.ts');
    const { setPersonalizationConsent, personalizationGrowthAllowed, PERSONALIZATION_CONSENT_VERSION } = await import('../../lib/consents/personalizationConsentService.ts');
    const uid = await lockedAfterAgreeing('RaceBetweenDeclines');
    // Suggestions were declined under the lock; before learning is, the other
    // press finishes and the person turns learning back on.
    const result = await resumeRevokedAccount(uid, {
      beforeLearning: async () => {
        assert.equal((await resume(uid)).status, 200);
        await setPersonalizationConsent(uid, { state: 'granted', version: PERSONALIZATION_CONSENT_VERSION });
      },
    });
    assert.equal(result.trust.revokedAt, null);
    assert.equal(await personalizationGrowthAllowed(uid), true, 'the late resume turned learning off again');
  } finally {
    end();
  }
});

test('the team stopping the account while a resume is on its way wins, and nothing is declined', async () => {
  begin();
  try {
    const { resumeRevokedAccount, MobilePilotError } = await import('../../lib/services/mobile/pilotService.ts');
    const { revokeAccountAsOperator } = await import('../../lib/pilot/operatorRevoke.ts');
    const { readTrust } = await import('../../lib/pilot/pilotTrustStore.ts');
    const { getRecommendationConsent } = await import('../../lib/consents/recommendationConsentService.ts');
    const { personalizationGrowthAllowed } = await import('../../lib/consents/personalizationConsentService.ts');
    const uid = await lockedAfterAgreeing('OperatorDuringResume');
    await assert.rejects(resumeRevokedAccount(uid, {
      afterRead: async () => { await revokeAccountAsOperator(uid, { revokeRefreshTokens: async () => {} }); },
    }), (error: unknown) => error instanceof MobilePilotError && error.reason === 'operator_revoked');
    assert.equal((await readTrust(uid))?.revokedBy, 'operator');
    assert.equal(await getRecommendationConsent(uid), 'granted', 'suggestions were declined under the team\'s stop');
    assert.equal(await personalizationGrowthAllowed(uid), true, 'learning was turned off under the team\'s stop');
  } finally {
    end();
  }
});
