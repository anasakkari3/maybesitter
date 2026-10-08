/**
 * M4a Gate B — a connected Google Calendar inside the capture harness.
 *
 * The real connect → consent → callback routes, against the fake Google of
 * `tests/support/fakeGoogle.ts`, on the storage the capture harness already
 * installed. A sync goes through the real `POST …/integrations/google/calendar`,
 * so the stored window is whatever the server's own sync writes.
 */
import assert from 'node:assert/strict';
import { applyTrustAction } from '../../../lib/pilot/pilotTrustStore.ts';
import { createInMemoryKms } from '../../../lib/security/inMemoryKms.ts';
import { resetGoogleRuntimeForTests, setGoogleRuntimeForTests } from '../../../lib/integrations/google/googleRuntime.ts';
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FAKE_PICKER_KEY, FAKE_REDIRECT, FakeGoogle } from '../../support/fakeGoogle.ts';
import { call, currentStorage, show, type Raw } from './support.ts';

let google: FakeGoogle | null = null;

/** Installs the fake Google on the harness's storage. Undo with `endGoogle()`. */
export function beginGoogle(): FakeGoogle {
  google = new FakeGoogle();
  const kms = createInMemoryKms();
  setGoogleRuntimeForTests({
    storage: currentStorage(),
    env: {
      GOOGLE_OAUTH_CLIENT_ID: FAKE_CLIENT_ID,
      GOOGLE_OAUTH_CLIENT_SECRET: FAKE_CLIENT_SECRET,
      GOOGLE_OAUTH_REDIRECT_URI: FAKE_REDIRECT,
      MAYBESITTER_KMS_KEY_NAME: kms.keyName,
      GOOGLE_PICKER_API_KEY: FAKE_PICKER_KEY,
    },
    secrets: null,
    fetchImpl: google.fetch as typeof fetch,
    encryption: { kms, env: { MAYBESITTER_KMS_KEY_NAME: kms.keyName } as unknown as NodeJS.ProcessEnv },
  } as any);
  return google;
}

export function endGoogle(): void {
  resetGoogleRuntimeForTests();
  google = null;
}

/** Calendar consent in the Trust Center, then Google connected with the calendar feature. */
export async function connectGoogleCalendar(uid: string): Promise<void> {
  assert.ok(google, 'call beginGoogle() first');
  const at = new Date().toISOString();
  await applyTrustAction(uid, { type: 'record_first_value', at } as any);
  await applyTrustAction(uid, { type: 'set_calendar_consent', granted: true, at } as any);
  const begun = await call(uid, 'integrations/google/connect', 'POST', { body: { feature: 'calendar' } });
  assert.equal(begun.status, 200, show(begun.body));
  const granted = google!.consent(begun.body.authorizationUrl);
  const done = await call(uid, 'integrations/google/callback', 'POST', { body: granted });
  assert.equal(done.status, 200, show(done.body));
  assert.equal(done.body.google?.features?.calendar, true, show(done.body));
}

/** Google answers `busy`, and the server syncs it now. */
export async function syncGoogle(uid: string, busy: Array<{ start: string; end: string }>): Promise<Raw> {
  assert.ok(google, 'call beginGoogle() first');
  google!.busy = busy;
  const synced = await call(uid, 'integrations/google/calendar', 'POST', { body: {} });
  assert.equal(synced.status, 200, show(synced.body));
  return synced;
}

/** The Google busy read the app uses. */
export async function readGoogle(uid: string): Promise<Raw> {
  return call(uid, 'integrations/google/calendar', 'GET');
}

/**
 * `count` one-minute intervals, one every two minutes, from `fromIso`.
 * Interval i starts at from + 2i minutes, so the 1001st (index 1000) starts
 * at from + 2000 minutes.
 */
export function denseIntervals(fromIso: string, count: number): Array<{ start: string; end: string }> {
  const from = Date.parse(fromIso);
  return Array.from({ length: count }, (_, index) => ({
    start: new Date(from + index * 120_000).toISOString(),
    end: new Date(from + index * 120_000 + 60_000).toISOString(),
  }));
}
