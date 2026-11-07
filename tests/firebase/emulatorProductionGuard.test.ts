import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EmulatorInProductionError, assertNoEmulatorInProduction, getAdminApp, resetAdminAppForTests,
} from '../../lib/firebase/admin.ts';
import { FirebaseTokenVerifier, resetTokenVerifierForTests } from '../../lib/auth/tokenVerifier.ts';
import { MobileAuthError, requireMobileUser } from '../../lib/auth/mobileAuth.ts';
import { createFirestoreStorage, resetFirestoreForTests } from '../../lib/storage/firestoreAdapter.ts';

// A production revision pointed at the Firebase emulators would trust unsigned
// emulator ID tokens and write to an emulator database. The admin app, the one
// init point for auth verification and Firestore, refuses that combination.
// Nothing here reaches a network: the guard throws before any client exists.

const KEYS = ['MAYBESITTER_ENV', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIRESTORE_EMULATOR_HOST', 'GOOGLE_CLOUD_PROJECT'] as const;

function withEnv(values: Partial<Record<(typeof KEYS)[number], string>>, work: () => Promise<void>): () => Promise<void> {
  return async () => {
    const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
    for (const key of KEYS) delete process.env[key];
    Object.assign(process.env, values);
    resetAdminAppForTests();
    resetFirestoreForTests();
    try { await work(); } finally {
      for (const key of KEYS) {
        if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
      }
      resetAdminAppForTests();
      resetFirestoreForTests();
    }
  };
}

/** An unsigned token of the shape the Auth emulator mints. */
function unsignedEmulatorToken(project: string): string {
  const now = Math.floor(Date.now() / 1000);
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none', typ: 'JWT' })}.${part({
    iss: `https://securetoken.google.com/${project}`, aud: project, sub: 'emulator-user', user_id: 'emulator-user',
    iat: now, exp: now + 3600, auth_time: now,
  })}.`;
}

test('the guard: production with either emulator host set is refused, any other combination is not', () => {
  for (const host of ['FIREBASE_AUTH_EMULATOR_HOST', 'FIRESTORE_EMULATOR_HOST'] as const) {
    assert.throws(() => assertNoEmulatorInProduction({ MAYBESITTER_ENV: 'production', [host]: '127.0.0.1:9099' }),
      EmulatorInProductionError, host);
    assert.throws(() => assertNoEmulatorInProduction({ MAYBESITTER_ENV: ' Production ', [host]: '127.0.0.1:9099' }),
      EmulatorInProductionError, `${host}, case and spaces`);
    assert.doesNotThrow(() => assertNoEmulatorInProduction({ MAYBESITTER_ENV: 'staging', [host]: '127.0.0.1:9099' }));
    assert.doesNotThrow(() => assertNoEmulatorInProduction({ [host]: '127.0.0.1:9099' }), 'no env name: the emulator suite');
  }
  assert.doesNotThrow(() => assertNoEmulatorInProduction({ MAYBESITTER_ENV: 'production' }));
  assert.doesNotThrow(() => assertNoEmulatorInProduction({ MAYBESITTER_ENV: 'production', FIRESTORE_EMULATOR_HOST: '' }));
});

test('production with the Auth emulator host: the admin app is not created', withEnv({
  MAYBESITTER_ENV: 'production', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:1', GOOGLE_CLOUD_PROJECT: 'demo-guard',
}, async () => {
  assert.throws(() => getAdminApp(), EmulatorInProductionError);
}));

test('production with the Auth emulator host: an unsigned emulator token is refused before it is decoded', withEnv({
  MAYBESITTER_ENV: 'production', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:1', GOOGLE_CLOUD_PROJECT: 'demo-guard',
}, async () => {
  await assert.rejects(new FirebaseTokenVerifier().verify(unsignedEmulatorToken('demo-guard'), { forceRevocationCheck: false }), EmulatorInProductionError);
}));

test('production with the Firestore emulator host: storage refuses before any client exists', withEnv({
  MAYBESITTER_ENV: 'production', FIRESTORE_EMULATOR_HOST: '127.0.0.1:1', GOOGLE_CLOUD_PROJECT: 'demo-guard',
}, async () => {
  await assert.rejects(createFirestoreStorage().get('system/probe'), EmulatorInProductionError);
}));

test('the emulator suite is unaffected: no production env name, the admin app is created', withEnv({
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:1', FIRESTORE_EMULATOR_HOST: '127.0.0.1:1', GOOGLE_CLOUD_PROJECT: 'demo-guard',
}, async () => {
  assert.ok(getAdminApp());
}));

test('production with the Auth emulator host: a mobile request is answered 503 auth_unavailable, never admitted', withEnv({
  MAYBESITTER_ENV: 'production', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:1', GOOGLE_CLOUD_PROJECT: 'demo-guard',
}, async () => {
  resetTokenVerifierForTests();
  const request = new Request('http://127.0.0.1/api/mobile/me', {
    headers: { authorization: `Bearer ${unsignedEmulatorToken('demo-guard')}` },
  });
  await assert.rejects(requireMobileUser(request), (error: unknown) => {
    assert.ok(error instanceof MobileAuthError);
    assert.equal(error.status, 503);
    assert.equal(error.reason, 'auth_unavailable');
    return true;
  });
}));
