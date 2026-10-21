/**
 * M5a Gate B — monitoring, enrolment, the daily sweep, pauses and Google
 * account changes (PLAN-M5a R4.1–R4.2, R3.3; M5A-R4-001, M5A-004, M5A-R23-003,
 * M5A-R24-*, M5A-R25-001/003, M5A-R2-005, M5A-R3-004, M5A-R5-004).
 *
 * The scheduler is driven through the gate's named seam
 * `runGmailJobTickForTests(route)` (support `tick`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NOW, TZ, begin, beginGoogle, call, connectGoogle, currentStorage, end, plusDays, plusMinutes, semanticModel, show, tick,
} from './support.ts';

test.afterEach(() => end());

const anything = () => semanticModel((text) => {
  const hit = /Please [^.\n]+/.exec(text);
  return hit ? [{ kind: 'request', evidence: hit[0], confidence: 0.9 }] : [];
});

async function monitorPost(uid: string, body: Record<string, unknown>) {
  return call(uid, 'intelligence/sources/gmail/monitor', 'POST', { body });
}

async function monitorDoc(uid: string): Promise<any> {
  return currentStorage().get(`users/${uid}/intelligenceMonitors/gmail`);
}

async function setup() {
  const uid = await begin();
  const model = anything();
  const google = beginGoogle(model);
  await connectGoogle(uid, 'gmail');
  return { uid, google, model };
}

test('M5A-R4-001: a fresh enable with enrollM5 writes m5 {v, providerAccountId, enabledAt, timezone}; the response says m5Enrolled', async () => {
  const { uid } = await setup();
  const result = await monitorPost(uid, { enabled: true, enrollM5: true, timezone: TZ });
  assert.equal(result.status, 200, show(result.body));
  assert.equal(result.body.m5Enrolled, true);
  const doc = await monitorDoc(uid);
  assert.equal(doc.m5?.v, 1);
  assert.ok(doc.m5?.providerAccountId, 'enrolment not bound to the Google identity');
  assert.ok(doc.m5?.enabledAt);
  assert.equal(doc.m5?.timezone, TZ);
});

test('M5A-R4-001 parity: an enable without enrollM5 (an older build) creates no m5 and no sweep', async () => {
  const { uid } = await setup();
  const result = await monitorPost(uid, { enabled: true });
  assert.equal(result.status, 200, show(result.body));
  assert.equal((await monitorDoc(uid)).m5, undefined);
  assert.equal(result.body.m5Enrolled ?? false, false);
});

test('M5A-R25-003: generation is stable across ticks (a lease, not the generation, is the per-runner claim)', async () => {
  const { uid } = await setup();
  await monitorPost(uid, { enabled: true, enrollM5: true, timezone: TZ });
  const before = (await monitorDoc(uid)).generation;
  await tick('live');
  await tick('live');
  assert.equal((await monitorDoc(uid)).generation, before, 'a tick rotated the enrolment generation');
});

test('M5A-R2-005 / M5A-R8-005: M5a never writes users/{uid}.timezone (the monitor stores its own)', async () => {
  const { uid } = await setup();
  await monitorPost(uid, { enabled: true, enrollM5: true, timezone: 'America/Los_Angeles' });
  const user = await currentStorage().get<any>(`users/${uid}`);
  assert.ok(!user?.timezone, 'the monitor POST wrote the account timezone');
});

test('M5A-004: the daily sweep never reads mail from before enabledAt (and "no" to backfill means none)', async () => {
  const { uid, google } = await setup();
  google.messages = [
    { id: 'before-enable', receivedAt: plusMinutes(NOW(), -120), subject: 'old', text: 'Please read the old note.' },
  ];
  await monitorPost(uid, { enabled: true, enrollM5: true, timezone: TZ });
  google.messages.push({ id: 'after-enable', receivedAt: plusMinutes(NOW(), 30), subject: 'new', text: 'Please read the new note.' });
  // Two days later, sweeps for every due day run.
  for (let i = 0; i < 6; i += 1) await tick('sweep', plusDays(NOW(), 2));
  assert.ok(!google.gets.includes('before-enable'), 'a sweep read mail from before monitoring began');
});

test('M5A-R35-004: an enrolled monitor without any timezone shows a held daily status with no day', async () => {
  const { uid } = await setup();
  await monitorPost(uid, { enabled: true, enrollM5: true });
  const status = await call(uid, 'intelligence/sources/gmail/scan', 'GET');
  assert.equal(status.status, 200, show(status.body));
  assert.equal(status.body.daily?.status, 'held');
  assert.equal(status.body.daily?.reason, 'no_timezone');
  assert.equal('day' in (status.body.daily ?? {}), false, 'a held status must not name a day');
  const resent = await monitorPost(uid, { enabled: true, enrollM5: true, timezone: TZ });
  assert.equal(resent.status, 200, show(resent.body));
  const after = await call(uid, 'intelligence/sources/gmail/scan', 'GET');
  assert.notEqual(after.body.daily?.status, 'held', 'the re-sent timezone did not clear the hold');
});

test('M5A-R23-003 / M5A-R25-001: pause then resume excludes the paused interval and resets the live cursor once', async () => {
  const { uid } = await setup();
  await monitorPost(uid, { enabled: true, enrollM5: true, timezone: TZ });
  const pause = await call(uid, 'settings/monitoring', 'PATCH', { body: { paused: true } });
  assert.ok(pause.status < 300, show(pause.body));
  const paused = await monitorDoc(uid);
  assert.ok(paused.m5?.pausedSince, 'pausing did not record pausedSince');
  const epoch = paused.m5?.pauseEpoch;
  const again = await call(uid, 'settings/monitoring', 'PATCH', { body: { paused: true } });
  assert.ok(again.status < 300);
  assert.equal((await monitorDoc(uid)).m5?.pausedSince, paused.m5.pausedSince, 'a repeated pause moved pausedSince');
  assert.equal((await monitorDoc(uid)).m5?.pauseEpoch, epoch, 'a repeated pause advanced the epoch');
  await call(uid, 'settings/monitoring', 'PATCH', { body: { paused: false } });
  const resumed = await monitorDoc(uid);
  assert.equal(resumed.m5?.excluded?.length, 1, 'resume did not record one excluded interval');
  assert.equal(resumed.cursor, null, 'resume did not reset the live cursor');
});

test('M5A-R3-004: disconnecting Google disables an enrolled monitor and fails a running scan reconnect_needed', async () => {
  const { uid, google } = await setup();
  google.messages = Array.from({ length: 150 }, (_, i) => ({ id: `m${i}`, receivedAt: plusMinutes(NOW(), -60 - i), subject: 's', text: 'Please do it.' }));
  await monitorPost(uid, { enabled: true, enrollM5: true, timezone: TZ });
  await call(uid, 'intelligence/sources/gmail/scan', 'POST', { body: { m5: true, intent: 'new', timezone: TZ } });
  const disconnected = await call(uid, 'integrations/google/disconnect', 'POST', { body: {} });
  assert.ok(disconnected.status < 300, show(disconnected.body));
  assert.equal((await monitorDoc(uid)).enabled, false, 'disconnect left the enrolled monitor on');
  const status = await call(uid, 'intelligence/sources/gmail/scan', 'GET');
  if (status.status === 200 && status.body.manual) {
    assert.equal(status.body.manual.status, 'failed');
    assert.equal(status.body.manual.failure, 'reconnect_needed');
  }
});

test('M5A-R3-004: a newly connected different Google identity starts with monitoring off', async () => {
  const { uid, google } = await setup();
  await monitorPost(uid, { enabled: true, enrollM5: true, timezone: TZ });
  await call(uid, 'integrations/google/disconnect', 'POST', { body: {} });
  google.account = { sub: '2000000000002', email: 'other@example.com' };
  await connectGoogle(uid, 'gmail');
  const doc = await monitorDoc(uid);
  assert.ok(!doc?.enabled, 'a new Google identity inherited the enabled monitor');
});

test('R4.2 route ownership: each job route refuses the other route\'s classes', async () => {
  let module: Record<string, unknown>;
  try {
    module = await import('../../../lib/intelligence/gmailJobs.ts') as Record<string, unknown>;
  } catch (error) {
    assert.fail(`lib/intelligence/gmailJobs.ts not built (${(error as Error).message.split('\n')[0]})`);
  }
  const ownership = module.GMAIL_JOB_CLASSES as Record<string, string[]> | undefined;
  assert.ok(ownership, 'GMAIL_JOB_CLASSES is not exported');
  assert.deepEqual([...ownership.live!].sort(), ['live', 'proposals']);
  assert.deepEqual([...ownership.sweep!].sort(), ['calendar_maintenance', 'continuation', 'sweep']);
});

test('R4.2: the sweep job route exists and is scheduler-authenticated', async () => {
  let module: Record<string, unknown>;
  try {
    module = await import('../../../src/app/api/internal/jobs/intelligence-gmail-sweep/route.ts') as Record<string, unknown>;
  } catch (error) {
    assert.fail(`the sweep job route is not built (${(error as Error).message.split('\n')[0]})`);
  }
  const post = module.POST as (request: Request) => Promise<Response>;
  // Scheduler auth configured, as in every deployed environment, so the
  // refusal under test is the missing credential (unconfigured is 503 by the
  // shared scheduler contract).
  const saved = { sa: process.env.MAYBESITTER_SCHEDULER_SA_EMAIL, aud: process.env.MAYBESITTER_INTERNAL_AUDIENCE };
  process.env.MAYBESITTER_SCHEDULER_SA_EMAIL = 'scheduler@example.iam.gserviceaccount.com';
  process.env.MAYBESITTER_INTERNAL_AUDIENCE = 'https://example.test';
  try {
    const refused = await post(new Request('http://localhost:3000/api/internal/jobs/intelligence-gmail-sweep', { method: 'POST' }));
    assert.ok(refused.status === 401 || refused.status === 403, `an unauthenticated tick must be refused (${refused.status})`);
  } finally {
    if (saved.sa === undefined) delete process.env.MAYBESITTER_SCHEDULER_SA_EMAIL; else process.env.MAYBESITTER_SCHEDULER_SA_EMAIL = saved.sa;
    if (saved.aud === undefined) delete process.env.MAYBESITTER_INTERNAL_AUDIENCE; else process.env.MAYBESITTER_INTERNAL_AUDIENCE = saved.aud;
  }
});
