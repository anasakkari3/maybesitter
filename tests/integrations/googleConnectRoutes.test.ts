/**
 * The Google chain, route by route, against a fake Google (CL6a).
 *
 * Every route runs its real handler, the real OAuth lifecycle, the real state
 * store, the KMS-envelope vault (with an in-memory KMS) and the real busy-block
 * writer. Only Google is fake (`tests/support/fakeGoogle.ts`), and it says no
 * the way Google does: single-use codes, PKCE, `invalid_grant` on a dead
 * refresh token, 401 on a revoked access token, 403 on a missing scope.
 *
 * The brief's list, in order: not configured; connect start; callback success,
 * state mismatch and denied; disconnect; freebusy mapping; Gmail bounded scan;
 * Drive single file; needs-reauth. Plus the two things a Google refusal must
 * never do: answer 401 (the app signs out on it) or store anything.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import {
  BUSY_BLOCKS,
  GOOGLE_PICKER_TICKETS,
  PLANNING_STATE_CHANGES,
  PROVIDER_CONNECTIONS,
  PROVIDER_CREDENTIALS,
  PROVIDER_OAUTH_STATES,
  userCol,
} from '../../lib/storage/paths.ts';
import { applyTrustAction } from '../../lib/pilot/pilotTrustStore.ts';
import { createInMemoryKms } from '../../lib/security/inMemoryKms.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import {
  FAKE_CLIENT_ID,
  FAKE_CLIENT_SECRET,
  FAKE_PICKER_KEY,
  FAKE_REDIRECT,
  FakeGoogle,
} from '../support/fakeGoogle.ts';
import { googleRuntime, resetGoogleRuntimeForTests, setGoogleRuntimeForTests } from '../../lib/integrations/google/googleRuntime.ts';
import { busyBlockId, readBusyBlocksForPlanning, replaceBusyBlocks } from '../../lib/calendar/busyBlocks.ts';
import {
  GMAIL_SCAN_CAPTURE_RESERVE_MS,
  GMAIL_SCAN_DEADLINE_MS,
  GMAIL_SCAN_MAX_MESSAGES,
  GMAIL_SCAN_QUERY,
} from '../../lib/integrations/google/googleGmailScan.ts';
import { shareLlmProvider, type ShareStructuredGenerator } from '../../lib/llm/shareProvider.ts';
import { EMAIL_BATCH_SYSTEM_INSTRUCTION } from '../../lib/services/share/prompts/emailPrompt.ts';
import { BEGIN_UNTRUSTED_SHARED_CONTENT } from '../../lib/services/share/shareTypes.ts';
import { LLMUnavailableError, type LlmProvider } from '../../src/extraction/llm/index.ts';
import { GOOGLE_BUSY_SOURCE_ID } from '../../lib/integrations/google/googleConfig.ts';
import { GET as statusGet } from '../../src/app/api/mobile/integrations/google/route.ts';
import { POST as connectPost } from '../../src/app/api/mobile/integrations/google/connect/route.ts';
import { POST as callbackPost } from '../../src/app/api/mobile/integrations/google/callback/route.ts';
import { POST as disconnectPost } from '../../src/app/api/mobile/integrations/google/disconnect/route.ts';
import {
  GET as calendarGet,
  POST as calendarPost,
} from '../../src/app/api/mobile/integrations/google/calendar/route.ts';
import { POST as gmailScanPost } from '../../src/app/api/mobile/integrations/google/gmail/scan/route.ts';
import { POST as drivePickerPost } from '../../src/app/api/mobile/integrations/google/drive/picker/route.ts';
import { POST as driveImportPost } from '../../src/app/api/mobile/integrations/google/drive/import/route.ts';
import { GET as browserCallbackGet } from '../../src/app/api/oauth/google/callback/route.ts';
import { GET as pickerPageGet } from '../../src/app/api/oauth/google/picker/route.ts';
import { DELETE as accountDelete } from '../../src/app/api/mobile/account/route.ts';
import { setDeletionAuthForTests } from '../../lib/account/accountDeletion.ts';
import { deletionHooks } from '../../lib/account/deletionHooks.ts';
import { revokeGoogleForDeletedAccount } from '../../lib/integrations/google/googleDeletionHook.ts';
import { getOrCreateTrust } from '../../lib/pilot/pilotTrustStore.ts';
import { setAiConsent } from '../../lib/consents/aiConsentService.ts';
import { AI_CONSENT_VERSION } from '../../src/contracts/v1/consentContracts.ts';
import { registerSharePreprocessor, resetSharePreprocessorsForTests } from '../../lib/services/share/shareRegistry.ts';
import {
  documentPreprocessor,
  emailPreprocessor,
  imagePreprocessor,
  plainTextPreprocessor,
  whatsappPreprocessor,
} from '../../lib/services/share/channels/index.ts';

const BASE = 'http://127.0.0.1:4321';
const USER = uidFor('GoogleUser');
const OTHER = uidFor('GoogleOther');
const FREEBUSY = 'https://www.googleapis.com/auth/calendar.freebusy';
const GMAIL = 'https://www.googleapis.com/auth/gmail.readonly';
const DRIVE = 'https://www.googleapis.com/auth/drive.file';

let auth: FakeAuthControls | null = null;
let storage = createMemoryStorage();
let google = new FakeGoogle();

function setup(options: { configured?: boolean; picker?: boolean; shareModel?: ShareStructuredGenerator } = {}): () => void {
  storage = createMemoryStorage();
  google = new FakeGoogle();
  setStorageForTests(storage);
  auth = installFakeAuth();
  const kms = createInMemoryKms();
  const configured = options.configured ?? true;
  const env = configured
    ? {
      GOOGLE_OAUTH_CLIENT_ID: FAKE_CLIENT_ID,
      GOOGLE_OAUTH_CLIENT_SECRET: FAKE_CLIENT_SECRET,
      GOOGLE_OAUTH_REDIRECT_URI: FAKE_REDIRECT,
      MAYBESITTER_KMS_KEY_NAME: kms.keyName,
      ...(options.picker === false ? {} : { GOOGLE_PICKER_API_KEY: FAKE_PICKER_KEY }),
    }
    : { MAYBESITTER_KMS_KEY_NAME: kms.keyName };
  setGoogleRuntimeForTests({
    storage,
    env,
    secrets: null,
    fetchImpl: google.fetch as typeof fetch,
    encryption: { kms, env: { MAYBESITTER_KMS_KEY_NAME: kms.keyName } as unknown as NodeJS.ProcessEnv },
    ...(options.shareModel ? { shareModel: options.shareModel } : {}),
  });
  return () => {
    resetGoogleRuntimeForTests();
    auth?.restore();
    auth = null;
    resetStorageForTests();
  };
}

function request(path: string, options: { method?: string; body?: unknown; uid?: string } = {}): Request {
  const headers = new Headers({ authorization: `Bearer ${tokenFor(options.uid ?? USER)}` });
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  return new Request(`${BASE}${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

async function body(response: Response): Promise<Record<string, any>> {
  return response.json() as Promise<Record<string, any>>;
}

async function status(uid = USER): Promise<Record<string, any>> {
  return (await body(await statusGet(request('/api/mobile/integrations/google', { uid })))).google;
}

async function begin(feature: string, uid = USER): Promise<Record<string, any>> {
  const response = await connectPost(request('/api/mobile/integrations/google/connect', { body: { feature }, uid }));
  const json = await body(response);
  assert.equal(response.status, 200, JSON.stringify(json));
  return json;
}

/** Connect → Google consent → the app posts code and state back. */
async function connect(feature: string, uid = USER): Promise<Response> {
  const begun = await begin(feature, uid);
  const granted = google.consent(begun.authorizationUrl);
  return callbackPost(request('/api/mobile/integrations/google/callback', { body: granted, uid }));
}

async function consentToCalendar(uid = USER): Promise<void> {
  const at = new Date().toISOString();
  await applyTrustAction(uid, { type: 'record_first_value', at });
  await applyTrustAction(uid, { type: 'set_calendar_consent', granted: true, at });
}

/** Reading mail or a document is a model call: the person has said yes to those. */
async function grantAi(uid = USER): Promise<void> {
  await setAiConsent(uid, { state: 'granted', version: AI_CONSENT_VERSION });
}

/** Every document the storage holds, as one string, so a leak anywhere is found. */
async function dump(): Promise<string> {
  const paths = storage.pathsForTests();
  assert.ok(paths.length > 0, 'the dump is not vacuous');
  const rows = await Promise.all(paths.map(async (path) => [path, await storage.get(path)]));
  return JSON.stringify(rows);
}

async function listed(uid: string, collection: string): Promise<unknown[]> {
  return (await storage.list(userCol(uid, collection))).map((row) => row.data);
}

/* ── not configured ─────────────────────────────────────────────── */

test('not configured: status says so, and every action refuses with provider_not_configured', async () => {
  const done = setup({ configured: false });
  try {
    assert.deepEqual(await status(), {
      status: 'not_configured',
      accountEmail: null,
      features: { calendar: false, gmail: false, drive: false },
      pickerAvailable: false,
      connectedAt: null,
    });
    const refusals = [
      await connectPost(request('/api/mobile/integrations/google/connect', { body: { feature: 'calendar' } })),
      await callbackPost(request('/api/mobile/integrations/google/callback', { body: { code: 'c', state: 's' } })),
      await disconnectPost(request('/api/mobile/integrations/google/disconnect', { method: 'POST' })),
      await drivePickerPost(request('/api/mobile/integrations/google/drive/picker', { method: 'POST' })),
      await gmailScanPost(request('/api/mobile/integrations/google/gmail/scan', { body: {} })),
    ];
    for (const response of refusals) {
      assert.equal(response.status, 503);
      assert.equal((await body(response)).reason, 'provider_not_configured');
    }
    assert.equal(google.calls.length, 0, 'nothing reached Google');
  } finally {
    done();
  }
});

test('not configured without a KMS key, even with the client present: tokens have nowhere honest to go', async () => {
  const done = setup();
  try {
    setGoogleRuntimeForTests({
      storage,
      env: { GOOGLE_OAUTH_CLIENT_ID: FAKE_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET: FAKE_CLIENT_SECRET, GOOGLE_OAUTH_REDIRECT_URI: FAKE_REDIRECT },
      secrets: null,
      fetchImpl: google.fetch as typeof fetch,
    });
    assert.equal((await status()).status, 'not_configured');
  } finally {
    done();
  }
});

test('not configured while any half of the OAuth client is missing, with the redirect and the KMS key in place', async () => {
  const done = setup();
  try {
    const kms = createInMemoryKms();
    const full = {
      GOOGLE_OAUTH_CLIENT_ID: FAKE_CLIENT_ID,
      GOOGLE_OAUTH_CLIENT_SECRET: FAKE_CLIENT_SECRET,
      GOOGLE_OAUTH_REDIRECT_URI: FAKE_REDIRECT,
      MAYBESITTER_KMS_KEY_NAME: kms.keyName,
    };
    for (const missing of ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'] as const) {
      const env: Record<string, string> = { ...full };
      delete env[missing];
      setGoogleRuntimeForTests({ storage, env, secrets: null, fetchImpl: google.fetch as typeof fetch });
      assert.equal((await status()).status, 'not_configured', missing);
      const refused = await connectPost(request('/api/mobile/integrations/google/connect', { body: { feature: 'calendar' } }));
      assert.equal(refused.status, 503, missing);
      assert.equal((await body(refused)).reason, 'provider_not_configured', missing);
    }
    assert.equal(google.calls.length, 0, 'nothing reached Google');
  } finally {
    done();
  }
});

test('the secrets come from Secret Manager by their exact names when the environment has none', async () => {
  const done = setup();
  try {
    const kms = createInMemoryKms();
    const asked: string[] = [];
    const vault: Record<string, string> = {
      'google-oauth-client-id': FAKE_CLIENT_ID,
      'google-oauth-client-secret': FAKE_CLIENT_SECRET,
      'google-picker-api-key': FAKE_PICKER_KEY,
    };
    setGoogleRuntimeForTests({
      storage,
      env: { GOOGLE_OAUTH_REDIRECT_URI: FAKE_REDIRECT, MAYBESITTER_KMS_KEY_NAME: kms.keyName },
      secrets: async (name) => { asked.push(name); return vault[name] ?? null; },
      fetchImpl: google.fetch as typeof fetch,
    });
    const configured = await status();
    assert.equal(configured.status, 'not_connected');
    assert.equal(configured.pickerAvailable, true);
    assert.deepEqual(Array.from(new Set(asked)).sort(), ['google-oauth-client-id', 'google-oauth-client-secret', 'google-picker-api-key']);

    // A secret the owner has not created yet reads as absent, never as an error.
    delete vault['google-oauth-client-secret'];
    assert.equal((await status()).status, 'not_configured');
  } finally {
    done();
  }
});

/* ── connect start ──────────────────────────────────────────────── */

test('connect start asks for one feature scope plus identity, offline, incremental, PKCE, and no secret in the URL', async () => {
  const done = setup();
  try {
    // The memory adapter JSON-clones what it stores, so the raw write is what
    // shows whether Firestore would receive a timestamp its TTL policy acts on.
    const written: unknown[] = [];
    const run = storage.runTransaction.bind(storage);
    storage.runTransaction = ((fn: Parameters<typeof storage.runTransaction>[0]) => run((tx) => fn(new Proxy(tx, {
      get(target, key, receiver) {
        if (key !== 'set') return Reflect.get(target, key, receiver);
        return (path: string, value: unknown) => {
          if (path.includes(`/${PROVIDER_OAUTH_STATES}/`)) written.push((value as { expiresAt: unknown }).expiresAt);
          return target.set(path, value);
        };
      },
    })))) as typeof storage.runTransaction;
    const begun = await begin('calendar');
    const url = new URL(begun.authorizationUrl);
    assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.deepEqual(url.searchParams.get('scope')!.split(' ').sort(), [FREEBUSY, 'https://www.googleapis.com/auth/userinfo.email', 'openid'].sort());
    assert.equal(url.searchParams.get('access_type'), 'offline');
    assert.equal(url.searchParams.get('prompt'), 'consent');
    assert.equal(url.searchParams.get('include_granted_scopes'), 'true');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('redirect_uri'), FAKE_REDIRECT);
    assert.equal(url.searchParams.get('client_id'), FAKE_CLIENT_ID);
    assert.equal(begun.returnUrl, 'maybesitter://oauth/google');
    assert.doesNotMatch(begun.authorizationUrl, new RegExp(FAKE_CLIENT_SECRET));
    assert.ok(!('state' in begun), 'the state is only inside the URL');
    // One in-flight authorization, holding no raw state.
    const states = await listed(USER, PROVIDER_OAUTH_STATES);
    assert.equal(states.length, 1);
    assert.doesNotMatch(JSON.stringify(states), new RegExp(url.searchParams.get('state')!));
    assert.equal(written.length, 1);
    assert.ok(written[0] instanceof Date, 'expiresAt is written as a TTL-able timestamp, not a string');
  } finally {
    done();
  }
});

test('connect start refuses a feature it does not know', async () => {
  const done = setup();
  try {
    const response = await connectPost(request('/api/mobile/integrations/google/connect', { body: { feature: 'contacts' } }));
    assert.equal(response.status, 400);
    assert.equal((await body(response)).reason, 'invalid_request');
  } finally {
    done();
  }
});

/* ── callback ───────────────────────────────────────────────────── */

test('callback success: connected, the feature granted, tokens only as ciphertext', async () => {
  const done = setup();
  try {
    const response = await connect('calendar');
    const json = await body(response);
    assert.equal(response.status, 200, JSON.stringify(json));
    assert.equal(json.google.status, 'connected');
    assert.equal(json.google.accountEmail, 'person@example.com');
    assert.deepEqual(json.google.features, { calendar: true, gmail: false, drive: false });
    const credentials = JSON.stringify(await listed(USER, PROVIDER_CREDENTIALS));
    assert.ok(credentials.length > 10);
    assert.doesNotMatch(credentials, /access-\d|refresh-\d/, 'no plaintext token at rest');
    assert.doesNotMatch(JSON.stringify(await listed(USER, PROVIDER_CONNECTIONS)), /access-\d|refresh-\d/);
    assert.equal((await listed(USER, PROVIDER_OAUTH_STATES)).length, 0, 'the state was spent');
  } finally {
    done();
  }
});

test('incremental: turning Gmail on after Calendar keeps Calendar, and the combined grant still works an hour later', async () => {
  const done = setup();
  try {
    await consentToCalendar();
    await connect('calendar');
    const begun = await begin('gmail');
    const scopes = new URL(begun.authorizationUrl).searchParams.get('scope')!.split(' ');
    assert.ok(scopes.includes(GMAIL));
    assert.ok(!scopes.includes(FREEBUSY), 'an already-granted feature is not asked for again');
    const granted = google.consent(begun.authorizationUrl);
    const json = await body(await callbackPost(request('/api/mobile/integrations/google/callback', { body: granted })));
    assert.deepEqual(json.google.features, { calendar: true, gmail: true, drive: false });

    // At Google, revoking any token of a combined authorization revokes all of
    // it — the token just issued included (CL6a review C1). A re-consent for
    // the same account therefore revokes nothing.
    assert.equal(google.revokeCalls(), 0, 'adding a feature never calls /revoke');
    assert.equal(google.liveGrants(), 1, 'one authorization for the account, still live');

    // An hour later the access token has expired, so the next read has to
    // trade the stored refresh token in. It must still be good.
    google.expireAccessTokens();
    const synced = await calendarPost(request('/api/mobile/integrations/google/calendar', { method: 'POST' }));
    assert.equal(synced.status, 200, JSON.stringify(await body(synced.clone())));
    assert.equal((await status()).status, 'connected', 'still connected, not «أعد الربط»');
  } finally {
    done();
  }
});

test("callback state mismatch: another account's state is refused with 400, and nothing is stored", async () => {
  const done = setup();
  try {
    const begun = await begin('calendar', OTHER);
    const granted = google.consent(begun.authorizationUrl);
    const response = await callbackPost(request('/api/mobile/integrations/google/callback', { body: granted, uid: USER }));
    assert.equal(response.status, 400);
    assert.equal((await body(response)).reason, 'google_state_invalid');
    assert.equal((await listed(USER, PROVIDER_CREDENTIALS)).length, 0);
    assert.equal((await listed(USER, PROVIDER_CONNECTIONS)).length, 0);
    assert.ok(!google.calls.some((call) => call.url.endsWith('/token')), 'no code was exchanged');
  } finally {
    done();
  }
});

test('callback replay: the second post of the same code and state is refused', async () => {
  const done = setup();
  try {
    const begun = await begin('calendar');
    const granted = google.consent(begun.authorizationUrl);
    assert.equal((await callbackPost(request('/api/mobile/integrations/google/callback', { body: granted }))).status, 200);
    const again = await callbackPost(request('/api/mobile/integrations/google/callback', { body: granted }));
    assert.equal(again.status, 400);
    assert.equal((await body(again)).reason, 'google_state_invalid');
  } finally {
    done();
  }
});

test('callback denied: the person pressed Cancel at Google — 400 access_denied, never 401, nothing stored', async () => {
  const done = setup();
  try {
    await begin('calendar');
    const response = await callbackPost(request('/api/mobile/integrations/google/callback', { body: { error: 'access_denied' } }));
    assert.equal(response.status, 400);
    assert.equal((await body(response)).reason, 'google_access_denied');
    assert.equal((await listed(USER, PROVIDER_CONNECTIONS)).length, 0);
  } finally {
    done();
  }
});

test('callback: a permission unticked on the consent screen is permission_not_granted, not a connection', async () => {
  const done = setup();
  try {
    google.refusedScopes = [FREEBUSY];
    const response = await connect('calendar');
    assert.equal(response.status, 409);
    assert.equal((await body(response)).reason, 'google_permission_not_granted');
    assert.equal((await status()).status, 'not_connected');
  } finally {
    done();
  }
});

test('callback: adding a feature as a different Google account is refused, stores nothing new, and leaves no orphan grant', async () => {
  const done = setup();
  try {
    await consentToCalendar();
    await connect('calendar');
    google.account = { sub: '2000000000002', email: 'someone.else@example.com' };
    const response = await connect('gmail');
    assert.equal(response.status, 409);
    assert.equal((await body(response)).reason, 'google_account_mismatch');
    const now = await status();
    assert.equal(now.accountEmail, 'person@example.com');
    assert.deepEqual(now.features, { calendar: true, gmail: false, drive: false });

    // The other account did consent, and Google issued it a grant. Nobody
    // holds that grant now, so it is withdrawn rather than left live at
    // Google where the person could never see it from this app.
    assert.equal(google.liveGrants(), 1, "the other account's grant was revoked; the connected one's was not");
    // …and the connected account's grant is untouched: it still refreshes.
    google.expireAccessTokens();
    const synced = await calendarPost(request('/api/mobile/integrations/google/calendar', { method: 'POST' }));
    assert.equal(synced.status, 200);
    assert.equal((await status()).status, 'connected');
  } finally {
    done();
  }
});

test('the browser redirect forwards code and state to the app scheme, and nothing else', async () => {
  const forwarded = browserCallbackGet(new Request(`${BASE}/api/oauth/google/callback?code=4%2F0Ab&state=xyz&scope=openid&authuser=0`));
  assert.equal(forwarded.status, 302);
  const location = new URL(forwarded.headers.get('location')!);
  assert.equal(`${location.protocol}//${location.host}${location.pathname}`, 'maybesitter://oauth/google');
  assert.deepEqual(Array.from(location.searchParams.keys()).sort(), ['code', 'state']);
  assert.equal(location.searchParams.get('code'), '4/0Ab');
  assert.equal(forwarded.headers.get('cache-control'), 'no-store');
  assert.equal(forwarded.headers.get('referrer-policy'), 'no-referrer');

  const denied = browserCallbackGet(new Request(`${BASE}/api/oauth/google/callback?error=access_denied&state=xyz`));
  assert.equal(new URL(denied.headers.get('location')!).searchParams.get('error'), 'access_denied');
  const odd = browserCallbackGet(new Request(`${BASE}/api/oauth/google/callback?error=%3Cscript%3E`));
  assert.equal(new URL(odd.headers.get('location')!).searchParams.get('error'), 'failed');
  const empty = browserCallbackGet(new Request(`${BASE}/api/oauth/google/callback`));
  assert.equal(new URL(empty.headers.get('location')!).searchParams.get('error'), 'failed');
});

/* ── disconnect ─────────────────────────────────────────────────── */

test('disconnect revokes at Google, deletes the tokens, and takes the Google busy time off the account', async () => {
  const done = setup();
  try {
    await consentToCalendar();
    await connect('calendar');
    const start = Date.now() + 3 * 3_600_000;
    google.busy = [{ start: new Date(start).toISOString(), end: new Date(start + 3_600_000).toISOString() }];
    assert.equal((await calendarPost(request('/api/mobile/integrations/google/calendar', { method: 'POST' }))).status, 200);
    assert.equal((await listed(USER, BUSY_BLOCKS)).length, 1);
    const blockId = ((await listed(USER, BUSY_BLOCKS))[0] as { blockId: string }).blockId;
    const rowsBefore = (await listed(USER, PLANNING_STATE_CHANGES)).length;

    const response = await disconnectPost(request('/api/mobile/integrations/google/disconnect', { method: 'POST' }));
    const json = await body(response);
    assert.equal(response.status, 200, JSON.stringify(json));
    assert.equal(json.disconnected, true);
    assert.equal(json.google.status, 'not_connected');
    assert.equal(google.liveGrants(), 0, 'the grant is revoked at Google');
    assert.equal((await listed(USER, PROVIDER_CREDENTIALS)).length, 0, 'the tokens are gone');
    assert.equal((await listed(USER, BUSY_BLOCKS)).length, 0, 'the Google busy time is gone');
    // …and the replan tick hears that the time is free again (#611).
    const rows = (await listed(USER, PLANNING_STATE_CHANGES)) as Array<{ entityId: string }>;
    assert.equal(rows.length, rowsBefore + 1);
    assert.ok(rows.some((row) => row.entityId === blockId), 'the removed block is announced');
  } finally {
    done();
  }
});

test('disconnect that Google refuses keeps the tokens: our only copy of a live grant is not thrown away', async () => {
  const done = setup();
  try {
    await connect('calendar');
    google.revokeStatus = 503;
    const response = await disconnectPost(request('/api/mobile/integrations/google/disconnect', { method: 'POST' }));
    assert.equal(response.status, 502);
    assert.equal((await body(response)).reason, 'google_unavailable');
    assert.equal((await listed(USER, PROVIDER_CREDENTIALS)).length, 1);
    assert.equal(google.liveGrants(), 1);
  } finally {
    done();
  }
});

/* ── account deletion ───────────────────────────────────────────── */

test('account deletion revokes the grant at Google first, then the tokens and connection go with the tree', async () => {
  const done = setup();
  process.env.MAYBESITTER_DELETION_RECEIPT_PEPPER = 'google-route-test-pepper';
  setDeletionAuthForTests({ async revokeRefreshTokens() {}, async deleteUser() {} });
  try {
    assert.ok(deletionHooks().some((hook) => hook.name === 'googleRevoke'), 'the account route registers the Google hook');
    await getOrCreateTrust(USER, new Date().toISOString());
    await connect('gmail');
    assert.equal(google.liveGrants(), 1);
    assert.equal((await listed(USER, PROVIDER_CREDENTIALS)).length, 1);

    const response = await accountDelete(new Request(`${BASE}/api/mobile/account`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${tokenFor(USER)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation: 'delete-my-account' }),
    }));
    const json = await body(response);
    assert.equal(response.status, 200, JSON.stringify(json));
    assert.equal(google.liveGrants(), 0, 'the grant is withdrawn at Google, not only our copy of it');
    assert.equal((await listed(USER, PROVIDER_CREDENTIALS)).length, 0);
    assert.equal((await listed(USER, PROVIDER_CONNECTIONS)).length, 0);
  } finally {
    setDeletionAuthForTests(null);
    delete process.env.MAYBESITTER_DELETION_RECEIPT_PEPPER;
    done();
  }
});

test('account deletion with the Google client gone but a grant still stored fails the hook, so the receipt says revocation failed', async () => {
  const done = setup();
  try {
    await connect('calendar');
    // The secret (or the KMS key) was removed after the person connected.
    setGoogleRuntimeForTests({ ...googleRuntime(), env: {} });
    assert.equal((await status()).status, 'not_configured');
    await assert.rejects(revokeGoogleForDeletedAccount(USER), 'a live grant nobody can revoke is not "done"');
    assert.equal(google.liveGrants(), 1, 'nothing reached Google');

    // With nothing stored there is nothing to revoke, configured or not.
    await assert.doesNotReject(revokeGoogleForDeletedAccount(OTHER));
  } finally {
    done();
  }
});

/* ── freebusy ───────────────────────────────────────────────────── */

test('freebusy: Google intervals become google busy blocks the planner reads, deduped against the phone', async () => {
  const done = setup();
  try {
    await consentToCalendar();
    await connect('calendar');
    const hour = 3_600_000;
    const base = Math.ceil(Date.now() / hour) * hour + 24 * hour;
    const iso = (ms: number) => new Date(ms).toISOString();
    // The phone already holds 10:00–11:00 of that day.
    const window = { startsAt: iso(Date.now()), endsAt: iso(Date.now() + 28 * 24 * hour) };
    await replaceBusyBlocks(USER, 'device:phone-1', window, [{
      blockId: busyBlockId('device:phone-1', 'evt-1', iso(base)),
      sourceId: 'device:phone-1',
      sourceKind: 'device',
      startAt: iso(base),
      endAt: iso(base + hour),
      allDay: false,
    }], { platform: 'ios' });
    google.busy = [
      { start: iso(base), end: iso(base + hour) }, // the same meeting the phone has
      { start: iso(base + 3 * hour), end: iso(base + 4 * hour) }, // only on Google
      { start: iso(base + 48 * hour), end: iso(base + 72 * hour) }, // a whole day, busy
    ];

    const response = await calendarPost(request('/api/mobile/integrations/google/calendar', { method: 'POST' }));
    const json = await body(response);
    assert.equal(response.status, 200, JSON.stringify(json));
    assert.equal(json.blocks, 2, 'the interval the phone covers is not written twice');
    assert.equal(json.source.sourceId, GOOGLE_BUSY_SOURCE_ID);

    const request_ = google.calls.find((call) => call.url.endsWith('/calendar/v3/freeBusy'))!;
    const sent = JSON.parse(request_.body!);
    assert.deepEqual(sent.items, [{ id: 'primary' }]);
    assert.equal(Date.parse(sent.timeMax) - Date.parse(sent.timeMin), 14 * 24 * hour);

    const google_ = (await listed(USER, BUSY_BLOCKS) as Array<Record<string, unknown>>).filter((row) => row.sourceKind === 'google');
    assert.equal(google_.length, 2);
    for (const row of google_) {
      assert.deepEqual(Object.keys(row).sort(), ['allDay', 'blockId', 'endAt', 'sourceId', 'sourceKind', 'startAt']);
    }
    assert.equal(google_.find((row) => row.startAt === iso(base + 48 * hour))!.allDay, true);

    // The planner sees the Google-only meeting as blocking, exactly as it sees the phone's.
    const planning = await readBusyBlocksForPlanning(USER, { startsAt: iso(base - hour), endsAt: iso(base + 6 * hour) });
    assert.deepEqual(planning.map((block) => block.startsAt).sort(), [iso(base), iso(base + 3 * hour)].sort());
    // …and the replan tick hears about it (#611): a change row, written with the block.
    const changes = await listed(USER, PLANNING_STATE_CHANGES) as Array<{ source: string }>;
    assert.ok(changes.some((row) => row.source === 'calendar'));

    const read = await body(await calendarGet(request('/api/mobile/integrations/google/calendar')));
    assert.equal(read.blocks.length, 2);
    assert.ok(read.blocks.every((block: { sourceKind: string }) => block.sourceKind === 'google'));
  } finally {
    done();
  }
});

test('freebusy is refused without the calendar consent, like the phone upload', async () => {
  const done = setup();
  try {
    await connect('calendar');
    const response = await calendarPost(request('/api/mobile/integrations/google/calendar', { method: 'POST' }));
    assert.equal(response.status, 403);
    assert.equal((await body(response)).reason, 'calendar_consent_required');
    assert.ok(!google.calls.some((call) => call.url.endsWith('/freeBusy')));
  } finally {
    done();
  }
});

test('freebusy before the calendar feature is granted is feature_not_granted', async () => {
  const done = setup();
  try {
    await consentToCalendar();
    await connect('gmail');
    const response = await calendarPost(request('/api/mobile/integrations/google/calendar', { method: 'POST' }));
    assert.equal(response.status, 409);
    assert.equal((await body(response)).reason, 'google_feature_not_granted');
  } finally {
    done();
  }
});

/* ── Gmail ──────────────────────────────────────────────────────── */

test('Gmail scan is bounded: one fixed query, at most twenty messages, bodies never stored', async () => {
  const done = setup();
  try {
    await connect('gmail');
    await grantAi();
    const now = Date.now();
    for (let index = 0; index < 25; index += 1) {
      google.gmail.push({
        id: `m${String(index).padStart(3, '0')}`,
        subject: `Trip form ${index}`,
        body: `SECRET-BODY-${index} Please return the signed trip form by Friday.`,
        receivedAt: new Date(now - index * 3_600_000).toISOString(),
      });
    }
    const response = await gmailScanPost(request('/api/mobile/integrations/google/gmail/scan', {
      body: { timezone: 'Asia/Jerusalem', referenceTime: new Date(now).toISOString() },
    }));
    const json = await body(response);
    assert.equal(response.status, 200, JSON.stringify(json));
    // The literal, not the constant: a test that compares the query with
    // itself passes for any query at all.
    assert.equal(google.lastGmailQuery, 'category:primary newer_than:7d');
    assert.equal(GMAIL_SCAN_QUERY, 'category:primary newer_than:7d');
    const gets = google.calls.filter((call) => /\/users\/me\/messages\/m\d+/.test(call.url));
    assert.equal(gets.length, GMAIL_SCAN_MAX_MESSAGES);
    assert.equal(json.share.channel, 'email');
    // No model is configured here. Not one message was read, and the envelope
    // says so rather than calling twenty unread messages "nothing to save"
    // (CL6a review I2): the app shows the count, not the empty review.
    assert.equal(json.share.metrics.messagesFound, GMAIL_SCAN_MAX_MESSAGES);
    assert.equal(json.share.metrics.messagesRead, 0);
    assert.equal(json.share.metrics.messagesNotRead, GMAIL_SCAN_MAX_MESSAGES);
    assert.equal(json.share.metrics.modelUnavailable, GMAIL_SCAN_MAX_MESSAGES);
    assert.equal(json.status, 'no_commitment');
    assert.doesNotMatch(await dump(), /SECRET-BODY/, 'no message body reached storage');
    assert.doesNotMatch(JSON.stringify(json), /SECRET-BODY/, 'no message body is echoed back');
  } finally {
    done();
  }
});

/**
 * A model standing in for Gemini on the email batch prompt. It reads the
 * labelled untrusted blocks it is handed and answers one item per message
 * that asks for a trip form back — quoting that message, and naming it — so
 * the counts are about the scan, not about a model's mood.
 */
function batchModel(): { generate: ShareStructuredGenerator; provider: LlmProvider; calls: Array<{ system: string; parts: Array<{ kind: string; text?: string }> }> } {
  const calls: Array<{ system: string; parts: Array<{ kind: string; text?: string }> }> = [];
  const answer = async (request: { system: string; parts: readonly unknown[] }) => {
    const parts = request.parts as Array<{ kind: string; text?: string }>;
    calls.push({ system: request.system, parts });
    const items: unknown[] = [];
    let message = 0;
    for (const part of parts) {
      const label = /^Message (\d+):$/.exec(part.text ?? '');
      if (label) { message = Number(label[1]); continue; }
      const asked = /Please return the signed trip form (\d+) by Friday\./.exec(part.text ?? '');
      if (asked) {
        items.push({ message, title: `Return trip form ${asked[1]}`, evidenceSentence: asked[0], dueDayPhrase: 'by Friday' });
      }
    }
    return { text: JSON.stringify({ items }), model: 'gemini-2.5-flash', latencyMs: 1, promptTokens: 100, outputTokens: 10 };
  };
  const provider = { name: 'gemini', generateJson: answer, generateStructured: answer } as unknown as LlmProvider;
  return { generate: answer as unknown as ShareStructuredGenerator, provider, calls };
}

function tripForms(count: number, padding = 0): void {
  const now = Date.now();
  for (let index = 0; index < count; index += 1) {
    google.gmail.push({
      id: `m${String(index).padStart(3, '0')}`,
      subject: `Trip form ${index}`,
      body: `SECRET-BODY-${index}\n\n${'Lorem ipsum dolor sit amet. '.repeat(padding)}\n\nPlease return the signed trip form ${index} by Friday.`,
      // A minute apart, not an hour: «by Friday» in a mail received on a
      // Friday is that Friday, so on a Saturday an hour-spaced batch reached
      // back into yesterday and those forms were rightly dropped as past —
      // the test failed every Saturday, for its fixture and not the scan.
      receivedAt: new Date(now - index * 60_000).toISOString(),
    });
  }
}

async function scan(): Promise<Record<string, any>> {
  const response = await gmailScanPost(request('/api/mobile/integrations/google/gmail/scan', {
    body: { timezone: 'Asia/Jerusalem', referenceTime: new Date().toISOString() },
  }));
  const json = await body(response);
  assert.equal(response.status, 200, JSON.stringify(json));
  return json;
}

test('Gmail scan reads twenty messages in one model call, not one per message, and every message is its own untrusted block', async () => {
  const model = batchModel();
  const done = setup({ shareModel: model.generate });
  try {
    await connect('gmail');
    await grantAi();
    tripForms(GMAIL_SCAN_MAX_MESSAGES);
    const json = await scan();

    assert.equal(model.calls.length, 1, 'twenty short messages are one call');
    assert.equal(model.calls[0]!.system, EMAIL_BATCH_SYSTEM_INSTRUCTION);
    for (const part of model.calls[0]!.parts) {
      assert.ok(/^Message \d+:$/.test(part.text ?? '') || (part.text ?? '').startsWith(BEGIN_UNTRUSTED_SHARED_CONTENT),
        'mail text only ever travels inside an untrusted block');
    }
    assert.equal(json.share.metrics.messagesFound, 20);
    assert.equal(json.share.metrics.messagesRead, 20);
    assert.equal(json.share.metrics.messagesNotRead, 0);
    assert.equal(json.share.metrics.messagesWithItems, 20);
    assert.equal(json.share.metrics.modelCalls, 1);
    assert.ok(json.items.length > 0, 'the review gets the proposals');
    assert.doesNotMatch(await dump(), /SECRET-BODY/, 'no message body reached storage');
    assert.doesNotMatch(JSON.stringify(json), /SECRET-BODY/, 'no message body is echoed back');
  } finally {
    done();
  }
});

test('Gmail scan makes at most three model calls however long the mail is, and counts the rest as not read', async () => {
  const model = batchModel();
  const done = setup({ shareModel: model.generate });
  try {
    await connect('gmail');
    await grantAi();
    // ~7,000 characters each: three to a batch, so twenty would be seven calls.
    tripForms(GMAIL_SCAN_MAX_MESSAGES, 250);
    const json = await scan();

    assert.equal(model.calls.length, 3);
    assert.equal(json.share.metrics.modelCalls, 3);
    assert.equal(json.share.metrics.messagesRead, 9);
    assert.equal(json.share.metrics.messagesNotRead, 11);
    assert.equal(json.share.metrics.modelUnavailable, 0, 'the model answered; the budget stopped the read');
    assert.equal(json.share.metrics.messagesRead + json.share.metrics.messagesNotRead, json.share.metrics.messagesFound);
  } finally {
    done();
  }
});

test('Gmail scan under a per-minute model cap stops where the cap stops it, and says how many it read', async () => {
  const model = batchModel();
  // The real metered generator: the real usage guard, with a minute cap of one.
  const done = setup();
  try {
    setGoogleRuntimeForTests({
      ...googleRuntime(),
      shareModel: shareLlmProvider(USER, {
        provider: model.provider,
        consent: async () => 'granted',
        reserveOptions: { storage, minuteCap: 1 },
      }),
    });
    await connect('gmail');
    await grantAi();
    tripForms(GMAIL_SCAN_MAX_MESSAGES, 250);
    const json = await scan();

    assert.equal(model.calls.length, 1, 'the second call was refused by the cap, before the model');
    assert.equal(json.share.metrics.messagesRead, 3);
    assert.equal(json.share.metrics.messagesNotRead, 17);
    assert.equal(json.share.metrics.modelUnavailable, 17);
    assert.ok(json.items.length > 0, 'what was read is still offered');
  } finally {
    done();
  }
});

/**
 * A clock the scan reads, and a model that spends it: each call takes
 * `perCall` of it, and records the time it was allowed (CL6a round 2, N5).
 */
function slowModel(perCallMs: number, options: { failAfterSpending?: boolean } = {}) {
  let clock = Date.parse('2026-09-27T07:00:00.000Z');
  const allowed: Array<number | undefined> = [];
  const generate = (async (request: { parts: readonly unknown[]; timeoutMs?: number }) => {
    allowed.push(request.timeoutMs);
    clock += perCallMs;
    if (options.failAfterSpending) throw new LLMUnavailableError('timeout');
    const items: unknown[] = [];
    let message = 0;
    for (const part of request.parts as Array<{ text?: string }>) {
      const label = /^Message (\d+):$/.exec(part.text ?? '');
      if (label) { message = Number(label[1]); continue; }
      const asked = /Please return the signed trip form (\d+) by Friday\./.exec(part.text ?? '');
      if (asked) items.push({ message, title: `Return trip form ${asked[1]}`, evidenceSentence: asked[0], dueDayPhrase: 'by Friday' });
    }
    return { text: JSON.stringify({ items }), model: 'gemini-2.5-flash', latencyMs: perCallMs, promptTokens: 100, outputTokens: 10 };
  }) as unknown as ShareStructuredGenerator;
  return { generate, allowed, now: () => new Date(clock) };
}

test('Gmail scan has its own deadline below the app\'s 60 s: no model call starts after it, and what it cut is not read', async () => {
  const model = slowModel(25_000);
  const done = setup();
  try {
    setGoogleRuntimeForTests({ ...googleRuntime(), shareModel: model.generate, now: model.now });
    await connect('gmail');
    await grantAi();
    // ~7,000 characters each: three to a batch, seven batches, three allowed.
    tripForms(GMAIL_SCAN_MAX_MESSAGES, 250);
    const json = await scan();

    // 25 s, then 25 s more: the third call would start past the read's share
    // of the deadline, so it is never started.
    assert.equal(model.allowed.length, 2);
    assert.ok(GMAIL_SCAN_DEADLINE_MS < 60_000, 'below the app\'s upload timeout');
    const readBudget = GMAIL_SCAN_DEADLINE_MS - GMAIL_SCAN_CAPTURE_RESERVE_MS;
    // Each call is told how long it has left, never the provider's 45 s.
    assert.equal(model.allowed[0], readBudget);
    assert.equal(model.allowed[1], readBudget - 25_000);
    assert.equal(json.share.metrics.messagesRead, 6);
    assert.equal(json.share.metrics.messagesNotRead, 14);
    assert.equal(json.share.metrics.messagesPastDeadline, 14);
    // Not the model's fault, so the app does not tell anybody to try again soon.
    assert.equal(json.share.metrics.modelUnavailable, 0);
    assert.ok(json.items.length > 0, 'what was read is still offered');
  } finally {
    done();
  }
});

test('Gmail scan: a model call cut off by the deadline is counted as the deadline\'s, not as the model being unavailable', async () => {
  const model = slowModel(45_000, { failAfterSpending: true });
  const done = setup();
  try {
    setGoogleRuntimeForTests({ ...googleRuntime(), shareModel: model.generate, now: model.now });
    await connect('gmail');
    await grantAi();
    tripForms(3);
    const json = await scan();

    assert.equal(model.allowed.length, 1);
    assert.equal(json.share.metrics.messagesRead, 0);
    assert.equal(json.share.metrics.messagesNotRead, 3);
    assert.equal(json.share.metrics.messagesPastDeadline, 3);
    assert.equal(json.share.metrics.modelUnavailable, 0);
  } finally {
    done();
  }
});

test('Gmail scan over the daily share quota is refused before a single message is read', async () => {
  const done = setup();
  try {
    await connect('gmail');
    await grantAi();
    // Spend the day's shares on an empty mailbox, then put mail in it.
    for (let index = 0; index < 60; index += 1) {
      const response = await gmailScanPost(request('/api/mobile/integrations/google/gmail/scan', { body: {} }));
      if (response.status === 429) break;
    }
    tripForms(3);
    const before = google.calls.filter((call) => call.url.startsWith('https://gmail.googleapis.com')).length;
    const refused = await gmailScanPost(request('/api/mobile/integrations/google/gmail/scan', { body: {} }));
    assert.equal(refused.status, 429);
    assert.equal((await body(refused)).reason, 'share_quota');
    const after = google.calls.filter((call) => call.url.startsWith('https://gmail.googleapis.com')).length;
    assert.equal(after, before, 'the refused scan read no mail');
  } finally {
    done();
  }
});

test('AI is always on: a Gmail scan from an account that never answered is not refused for consent', async () => {
  // Before 2026-09-30 this was a 409 `ai_consent_required` before any mail was
  // read. The owner's always-on decision (`lib/consents/aiProcessingPolicy`)
  // means the consent gate now lets it through to the scan itself.
  const done = setup();
  try {
    await connect('gmail');
    google.gmail.push({ id: 'm1', subject: 'Trip form', body: 'Return the form by Friday.', receivedAt: new Date().toISOString() });
    const response = await gmailScanPost(request('/api/mobile/integrations/google/gmail/scan', { body: {} }));
    assert.notEqual((await body(response)).reason, 'ai_consent_required');
    assert.ok(google.calls.some((call) => new URL(call.url).host === 'gmail.googleapis.com'), 'the scan never read the mailbox');
  } finally {
    done();
  }
});

test('AI is always on: a Drive import from an account that never answered is not refused for consent', async () => {
  const done = setup();
  try {
    await connect('drive');
    google.drive.set('doc_abcdefghij', { id: 'doc_abcdefghij', mimeType: 'application/vnd.google-apps.document', content: 'x' });
    const response = await driveImportPost(request('/api/mobile/integrations/google/drive/import', { body: { fileId: 'doc_abcdefghij' } }));
    assert.notEqual((await body(response)).reason, 'ai_consent_required');
    assert.ok(google.calls.some((call) => call.url.includes('/drive/v3/')), 'the import never fetched the file');
  } finally {
    done();
  }
});

test('Gmail scan without the Gmail feature is feature_not_granted, and reads nothing', async () => {
  const done = setup();
  try {
    await connect('calendar');
    const response = await gmailScanPost(request('/api/mobile/integrations/google/gmail/scan', { body: {} }));
    assert.equal(response.status, 409);
    assert.equal((await body(response)).reason, 'google_feature_not_granted');
    assert.ok(!google.calls.some((call) => call.url.startsWith('https://gmail.googleapis.com')));
  } finally {
    done();
  }
});

/* ── Drive ──────────────────────────────────────────────────────── */

test('Drive: a one-time ticket opens the picker page once, and the token never goes through the app', async () => {
  const done = setup();
  try {
    await connect('drive');
    await grantAi();
    const minted = await body(await drivePickerPost(request('/api/mobile/integrations/google/drive/picker', { method: 'POST' })));
    assert.equal(minted.returnUrl, 'maybesitter://oauth/google/drive');
    const pickerUrl = new URL(minted.pickerUrl);
    assert.equal(pickerUrl.pathname, '/api/oauth/google/picker');
    assert.doesNotMatch(JSON.stringify(minted), /access-\d/, 'the app is never handed a token');
    const ticket = pickerUrl.searchParams.get('ticket')!;
    assert.doesNotMatch(JSON.stringify(await listed(USER, GOOGLE_PICKER_TICKETS)), new RegExp(ticket.split('.')[1]!));

    const page = await pickerPageGet(new Request(pickerUrl.toString()));
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy')!, /script-src 'nonce-/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    const html = await page.text();
    assert.match(html, /"appId":"123456789012"/, 'the project number is derived from the client id');
    assert.match(html, /fake-picker-key-not-real/);
    assert.doesNotMatch(html, /<\/script><script>alert/);

    const again = await pickerPageGet(new Request(pickerUrl.toString()));
    assert.equal(again.status, 302, 'a ticket opens the page once');
    assert.match(again.headers.get('location')!, /^maybesitter:\/\/oauth\/google\/drive\?error=expired$/);
    const forged = await pickerPageGet(new Request(`${BASE}/api/oauth/google/picker?ticket=${USER}.${'A'.repeat(43)}`));
    assert.equal(forged.status, 302);
  } finally {
    done();
  }
});

test('Drive: without the Picker key the Drive row cannot start, and says why', async () => {
  const done = setup({ picker: false });
  try {
    await connect('drive');
    assert.equal((await status()).pickerAvailable, false);
    const response = await drivePickerPost(request('/api/mobile/integrations/google/drive/picker', { method: 'POST' }));
    assert.equal(response.status, 503);
    assert.equal((await body(response)).reason, 'google_picker_unavailable');
  } finally {
    done();
  }
});

/**
 * The document channel reads through the model, and this suite has none. A
 * stand-in claims the same kinds ahead of it, records what the Drive import
 * handed the share pipeline, and answers with one commitment — so the test is
 * about the chain (Drive → one file → document share → proposal), not the model.
 */
function standInDocumentChannel(): { received: Array<{ kind: string; mediaType: string; text: string }>; restore: () => void } {
  const received: Array<{ kind: string; mediaType: string; text: string }> = [];
  registerSharePreprocessor({
    id: 'drive-stand-in',
    kinds: ['textFile', 'pdf'],
    priority: 1_000,
    async preprocess(input) {
      const file = input.files[0]!;
      received.push({ kind: input.kind, mediaType: file.mediaType, text: new TextDecoder().decode(file.bytes) });
      return { text: 'Submit the lab report on Thursday at 10am', ignoredSegments: 0 };
    },
  });
  return {
    received,
    restore: () => {
      resetSharePreprocessorsForTests();
      for (const channel of [documentPreprocessor, emailPreprocessor, imagePreprocessor, plainTextPreprocessor, whatsappPreprocessor]) {
        registerSharePreprocessor(channel);
      }
    },
  };
}

test('Drive import: one picked Google Doc is exported as text and read as one file; its text is never stored', async () => {
  const done = setup();
  const channel = standInDocumentChannel();
  try {
    await connect('drive');
    await grantAi();
    google.drive.set('doc_abcdefghij', {
      id: 'doc_abcdefghij',
      mimeType: 'application/vnd.google-apps.document',
      content: 'DOC-SECRET Submit the lab report by Thursday.',
    });
    const response = await driveImportPost(request('/api/mobile/integrations/google/drive/import', {
      body: { fileId: 'doc_abcdefghij', timezone: 'Asia/Jerusalem' },
    }));
    const json = await body(response);
    assert.equal(response.status, 200, JSON.stringify(json));
    assert.equal(json.share.fileCount, 1);
    assert.ok(google.calls.some((call) => call.url.includes('/files/doc_abcdefghij/export?mimeType=text%2Fplain')));
    const metadata = google.calls.find((call) => call.url.includes('fields='))!;
    assert.match(metadata.url, /fields=mimeType%2Csize|fields=mimeType,size/, 'type and size only — never the name');
    assert.deepEqual(channel.received, [{
      kind: 'textFile',
      mediaType: 'text/plain',
      text: 'DOC-SECRET Submit the lab report by Thursday.',
    }], 'exactly the one picked file reached the document share channel');
    assert.equal(json.status, 'proposed');
    assert.ok(json.items.length >= 1, 'the file became a proposal the person reviews');
    assert.doesNotMatch(await dump(), /DOC-SECRET/);
  } finally {
    channel.restore();
    done();
  }
});

test("Drive import stopped by the model's minute cap answers the quota, not an empty review and not 'Google is unavailable'", async () => {
  const model = batchModel();
  const done = setup();
  try {
    setGoogleRuntimeForTests({
      ...googleRuntime(),
      shareModel: shareLlmProvider(USER, {
        provider: model.provider,
        consent: async () => 'granted',
        reserveOptions: { storage, minuteCap: 0 },
      }),
    });
    await connect('drive');
    await grantAi();
    google.drive.set('doc_quota_12345', {
      id: 'doc_quota_12345',
      mimeType: 'application/vnd.google-apps.document',
      content: 'Lab 3\nSubmit the lab report by Thursday.',
    });
    const response = await driveImportPost(request('/api/mobile/integrations/google/drive/import', { body: { fileId: 'doc_quota_12345' } }));
    const json = await body(response);
    assert.equal(response.status, 429, JSON.stringify(json));
    assert.equal(json.reason, 'ai_quota');
    assert.equal(json.scope, 'user_minute');
    assert.ok(json.retryAfterSeconds >= 1);
    assert.equal(model.calls.length, 0, 'the cap refused the call before the model');
  } finally {
    done();
  }
});

test('Drive import refuses a file type Picker would not offer, before downloading it', async () => {
  const done = setup();
  try {
    await connect('drive');
    await grantAi();
    google.drive.set('sheet_abcdefghij', { id: 'sheet_abcdefghij', mimeType: 'application/vnd.google-apps.spreadsheet', content: 'x' });
    const response = await driveImportPost(request('/api/mobile/integrations/google/drive/import', { body: { fileId: 'sheet_abcdefghij' } }));
    assert.equal(response.status, 422);
    assert.equal((await body(response)).reason, 'google_file_unsupported');
    assert.ok(!google.calls.some((call) => call.url.includes('alt=media') || call.url.includes('/export')));
  } finally {
    done();
  }
});

test('Drive import refuses something that is not a file id, and a file the grant cannot see', async () => {
  const done = setup();
  try {
    await connect('drive');
    await grantAi();
    const bad = await driveImportPost(request('/api/mobile/integrations/google/drive/import', { body: { fileId: '../../etc' } }));
    assert.equal(bad.status, 400);
    const unseen = await driveImportPost(request('/api/mobile/integrations/google/drive/import', { body: { fileId: 'notpicked_12345' } }));
    assert.equal(unseen.status, 422);
    assert.equal((await body(unseen)).reason, 'google_file_unsupported');
  } finally {
    done();
  }
});

/* ── needs reauth ───────────────────────────────────────────────── */

test('needs reauth: a dead refresh token (Testing mode, day eight) becomes «أعد الربط», and reconnecting restores every feature', async () => {
  const done = setup();
  try {
    await consentToCalendar();
    await connect('calendar');
    await connect('gmail');
    google.expireGrants();
    setGoogleRuntimeForTests({
      ...googleRuntime(),
      // An hour and a bit later: the access token is past its life.
      now: () => new Date(Date.now() + 2 * 3_600_000),
    });

    const response = await calendarPost(request('/api/mobile/integrations/google/calendar', { method: 'POST' }));
    assert.equal(response.status, 409, 'never 401: the app would sign the person out');
    assert.equal((await body(response)).reason, 'google_reauth_required');
    assert.equal((await status()).status, 'needs_reauth');

    // Reconnect asks again for everything the dead grant held.
    google.refreshDead = false;
    const begun = await begin('calendar');
    const scopes = new URL(begun.authorizationUrl).searchParams.get('scope')!.split(' ');
    assert.ok(scopes.includes(FREEBUSY) && scopes.includes(GMAIL));
    const granted = google.consent(begun.authorizationUrl);
    const json = await body(await callbackPost(request('/api/mobile/integrations/google/callback', { body: granted })));
    assert.equal(json.google.status, 'connected');
    assert.deepEqual(json.google.features, { calendar: true, gmail: true, drive: false });
  } finally {
    done();
  }
});

test('a revoked access token that still fails after a refresh is marked needs_reauth, not retried forever', async () => {
  const done = setup();
  try {
    await consentToCalendar();
    await connect('calendar');
    google.resourceStatus = 401;
    const response = await calendarPost(request('/api/mobile/integrations/google/calendar', { method: 'POST' }));
    assert.equal(response.status, 409);
    assert.equal((await body(response)).reason, 'google_reauth_required');
    assert.equal((await status()).status, 'needs_reauth');
  } finally {
    done();
  }
});

test('no Google route ever answers 401 for a Google problem', async () => {
  const done = setup();
  try {
    await consentToCalendar();
    await connect('calendar');
    google.expireGrants();
    google.resourceStatus = 401;
    const responses = [
      await calendarPost(request('/api/mobile/integrations/google/calendar', { method: 'POST' })),
      await gmailScanPost(request('/api/mobile/integrations/google/gmail/scan', { body: {} })),
      await callbackPost(request('/api/mobile/integrations/google/callback', { body: { code: 'nope', state: 'nope' } })),
      await driveImportPost(request('/api/mobile/integrations/google/drive/import', { body: { fileId: 'doc_abcdefghij' } })),
    ];
    for (const response of responses) assert.notEqual(response.status, 401);
  } finally {
    done();
  }
});

test('every Google route refuses a caller with no token', async () => {
  const done = setup();
  try {
    const anonymous = (path: string, method = 'POST') => new Request(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });
    const responses = [
      await statusGet(anonymous('/api/mobile/integrations/google', 'GET')),
      await connectPost(anonymous('/api/mobile/integrations/google/connect')),
      await callbackPost(anonymous('/api/mobile/integrations/google/callback')),
      await disconnectPost(anonymous('/api/mobile/integrations/google/disconnect')),
      await calendarGet(anonymous('/api/mobile/integrations/google/calendar', 'GET')),
      await calendarPost(anonymous('/api/mobile/integrations/google/calendar')),
      await gmailScanPost(anonymous('/api/mobile/integrations/google/gmail/scan')),
      await drivePickerPost(anonymous('/api/mobile/integrations/google/drive/picker')),
      await driveImportPost(anonymous('/api/mobile/integrations/google/drive/import')),
    ];
    for (const response of responses) assert.equal(response.status, 401);
    assert.equal(google.calls.length, 0);
  } finally {
    done();
  }
});
