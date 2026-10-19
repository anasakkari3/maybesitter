/**
 * M5a Gate B — calendar choice on the server (PLAN-M5a R1.1 / R1.1b and Wire):
 * account enrolment and its purge, refusal of older builds' uploads, the Trust
 * projection for older builds, phone registration with an installation
 * secret, the selection intent and its continuation, permanent retirement,
 * the 20-phone cap and the tombstone.
 *
 * Every test drives the real routes. Uploads use the existing busy upload
 * envelope (`sourceId, platform, windowStart, windowEnd, blocks`) plus the
 * M5a fields the Wire adds (`choiceVersion`, `opId`, `epoch`) and the
 * `X-MaybeSitter-Source-Secret` header.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { CHOICE_HEADER, TOMORROW, at, begin, call, callWith, currentStorage, end, grantCalendarConsent, show } from './support.ts';

test.afterEach(() => end());

const WINDOW = { windowStart: at(TOMORROW, '00:00'), windowEnd: at('2026-10-15', '00:00') };

function block(seed: string, start: string, end: string) {
  return { blockId: createHash('sha256').update(seed).digest('hex'), startAt: start, endAt: end, allDay: false };
}

function legacyUpload(uid: string, sourceId: string, blocks = [block('a', at(TOMORROW, '10:00'), at(TOMORROW, '11:00'))]) {
  return call(uid, 'calendar/busy', 'POST', { body: { sourceId, platform: 'ios', ...WINDOW, blocks } });
}

async function deviceRows(uid: string): Promise<number> {
  const rows = await currentStorage().list<any>(`users/${uid}/busyBlocks`);
  return rows.filter((row) => String(row.data.sourceId ?? '').startsWith('device:')).length;
}

async function enrol(uid: string) {
  const result = await callWith(uid, 'calendar/choice', 'POST', { body: {}, headers: CHOICE_HEADER });
  assert.equal(result.status, 200, show(result.body));
  return result.body;
}

async function register(uid: string, sourceInstallationId = randomUUID(), sourceSecret = randomUUID() + randomUUID()) {
  const result = await callWith(uid, 'calendar/busy/register', 'POST', {
    body: { sourceInstallationId, sourceSecret, registrationId: randomUUID() }, headers: CHOICE_HEADER,
  });
  return { result, sourceInstallationId, sourceSecret, sourceId: result.body?.sourceId as string };
}

function intent(uid: string, sourceId: string, secret: string, operation: 'upload' | 'clear', intentId = randomUUID()) {
  return callWith(uid, 'calendar/busy/intent', 'POST', {
    body: { sourceId, intentId, operation, selectionDigest: createHash('sha256').update(intentId).digest('hex'), choiceVersion: 1 },
    headers: { ...CHOICE_HEADER, 'X-MaybeSitter-Source-Secret': secret },
  });
}

function upload(uid: string, sourceId: string, secret: string, opId: string, epoch: number, blocks = [block('b', at(TOMORROW, '12:00'), at(TOMORROW, '13:00'))]) {
  return callWith(uid, 'calendar/busy', 'POST', {
    body: { sourceId, platform: 'ios', ...WINDOW, blocks, choiceVersion: 1, opId, epoch },
    headers: { ...CHOICE_HEADER, 'X-MaybeSitter-Source-Secret': secret },
  });
}

/* ── enrolment ──────────────────────────────────────────────────────── */

test('R1.1b: the first choice POST deletes every pre-enrolment device source and answers active', async () => {
  const uid = await begin();
  await grantCalendarConsent(uid);
  assert.equal((await legacyUpload(uid, 'device:phone-a')).status, 200);
  assert.equal((await legacyUpload(uid, 'device:phone-b')).status, 200);
  assert.ok((await deviceRows(uid)) >= 2, 'precondition: legacy device rows stored');
  const body = await enrol(uid);
  assert.equal(body.success, true);
  assert.equal(body.state, 'active');
  assert.equal(await deviceRows(uid), 0, 'pre-enrolment device rows survived enrolment');
});

test('M5A-R9-001: a later choice POST while active deletes nothing', async () => {
  const uid = await begin();
  await grantCalendarConsent(uid);
  await enrol(uid);
  const phone = await register(uid);
  assert.equal(phone.result.status, 200, show(phone.result.body));
  const op = await intent(uid, phone.sourceId, phone.sourceSecret, 'upload');
  assert.equal(op.status, 200, show(op.body));
  assert.equal((await upload(uid, phone.sourceId, phone.sourceSecret, op.body.opId, op.body.epoch)).status, 200);
  const before = await deviceRows(uid);
  assert.ok(before > 0);
  await enrol(uid);
  assert.equal(await deviceRows(uid), before, 'a second enrolment call deleted a current M5a phone source');
});

test('Wire: the choice POST is 404 when calendar choice is off; the choice GET is always available', async () => {
  const uid = await begin({ calendarChoice: false });
  const post = await callWith(uid, 'calendar/choice', 'POST', { body: {}, headers: CHOICE_HEADER });
  assert.equal(post.status, 404, show(post.body));
  const get = await callWith(uid, 'calendar/choice', 'GET', { headers: CHOICE_HEADER, query: { sourceId: 'device:x' } });
  assert.equal(get.status, 200, show(get.body));
  assert.equal(get.body.enrolled, false);
  assert.equal(get.body.state, null);
});

/* ── older builds ───────────────────────────────────────────────────── */

test('R1.1b: an enrolled account refuses a device upload without choiceVersion (an older build) and stores nothing', async () => {
  const uid = await begin();
  await grantCalendarConsent(uid);
  await enrol(uid);
  const result = await legacyUpload(uid, 'device:old-build');
  assert.equal(result.status, 409, show(result.body));
  assert.equal(result.body.error, 'calendar_choice_required');
  assert.equal(await deviceRows(uid), 0);
});

test('R1.1b: the refusal holds whatever the flag once the account is enrolled (kill)', async () => {
  const uid = await begin();
  await grantCalendarConsent(uid);
  await enrol(uid);
  process.env.MAYBESITTER_KILL_SWITCH_CALENDAR_CHOICE = 'true';
  const result = await legacyUpload(uid, 'device:old-build');
  assert.equal(result.status, 409, show(result.body));
  assert.equal(result.body.error, 'calendar_choice_required');
});

test('parity: an un-enrolled account keeps accepting legacy device uploads', async () => {
  const uid = await begin();
  await grantCalendarConsent(uid);
  assert.equal((await legacyUpload(uid, 'device:legacy')).status, 200);
});

test('M5A-R10-001 / M5A-R12-003: the Trust read reports calendar consent off to a header-less request on an enrolled account, on GET and POST', async () => {
  const uid = await begin();
  await grantCalendarConsent(uid);
  await enrol(uid);
  const header = await callWith(uid, 'pilot/trust', 'GET', { headers: CHOICE_HEADER });
  assert.equal(header.status, 200, show(header.body));
  assert.equal(header.body.trust?.calendarConsent, true, 'an M5a build sees the true consent');
  const legacy = await call(uid, 'pilot/trust', 'GET');
  assert.equal(legacy.body.trust?.calendarConsent, false, 'an older build must see calendar consent off');
  assert.equal(legacy.body.whatKnows?.calendarConnected, false, 'whatKnows must agree with the projected consent');
  const posted = await call(uid, 'pilot/trust', 'POST', { body: { type: 'record_first_value', at: new Date().toISOString() } });
  assert.ok(posted.status < 300, show(posted.body));
  assert.equal(posted.body.trust?.calendarConsent, false, 'the POST response projects the same way');
  const stored = await callWith(uid, 'pilot/trust', 'GET', { headers: CHOICE_HEADER });
  assert.equal(stored.body.trust?.calendarConsent, true, 'the canonical consent stays true');
});

test('parity: an un-enrolled account shows its real consent to a header-less request', async () => {
  const uid = await begin();
  await grantCalendarConsent(uid);
  const legacy = await call(uid, 'pilot/trust', 'GET');
  assert.equal(legacy.body.trust?.calendarConsent, true);
});

/* ── registration and the intent ────────────────────────────────────── */

test('M5A-R55-001: registration is keyed by sourceInstallationId; a retry with the same secret returns the same sourceId', async () => {
  const uid = await begin();
  await grantCalendarConsent(uid);
  await enrol(uid);
  const first = await register(uid);
  assert.equal(first.result.status, 200, show(first.result.body));
  assert.match(first.sourceId, /^device:/);
  const retry = await callWith(uid, 'calendar/busy/register', 'POST', {
    body: { sourceInstallationId: first.sourceInstallationId, sourceSecret: first.sourceSecret, registrationId: randomUUID() }, headers: CHOICE_HEADER,
  });
  assert.equal(retry.status, 200, show(retry.body));
  assert.equal(retry.body.sourceId, first.sourceId);
  const other = await register(uid);
  assert.notEqual(other.sourceId, first.sourceId, 'two phones collapsed into one source');
});

test('M5A-R54-002: a registration retry with a different secret for the same installation is refused', async () => {
  const uid = await begin();
  await grantCalendarConsent(uid);
  await enrol(uid);
  const first = await register(uid);
  const wrong = await callWith(uid, 'calendar/busy/register', 'POST', {
    body: { sourceInstallationId: first.sourceInstallationId, sourceSecret: 'not-the-secret-not-the-secret-000', registrationId: randomUUID() }, headers: CHOICE_HEADER,
  });
  assert.ok(wrong.status >= 400 && wrong.status < 500, show(wrong.body));
});

test('M5A-R57-002: the 21st registered phone is refused too_many_phones', async () => {
  const uid = await begin();
  await grantCalendarConsent(uid);
  await enrol(uid);
  for (let i = 0; i < 20; i += 1) assert.equal((await register(uid)).result.status, 200);
  const extra = await register(uid);
  assert.equal(extra.result.status, 409, show(extra.result.body));
  assert.equal(extra.result.body.error, 'too_many_phones');
});

test('M5A-R53-004: the intent mints the epoch; a new intentId advances it, a retried intentId returns the same opId and epoch', async () => {
  const uid = await begin();
  await grantCalendarConsent(uid);
  await enrol(uid);
  const phone = await register(uid);
  const intentId = randomUUID();
  const a = await intent(uid, phone.sourceId, phone.sourceSecret, 'upload', intentId);
  assert.equal(a.status, 200, show(a.body));
  assert.equal(typeof a.body.opId, 'string');
  assert.ok(Number.isSafeInteger(a.body.epoch));
  const again = await intent(uid, phone.sourceId, phone.sourceSecret, 'upload', intentId);
  assert.deepEqual([again.body.opId, again.body.epoch], [a.body.opId, a.body.epoch], 'a retried intent is not idempotent');
  const b = await intent(uid, phone.sourceId, phone.sourceSecret, 'upload');
  assert.equal(b.body.epoch, a.body.epoch + 1, 'a new selection must mint currentEpoch + 1');
  assert.notEqual(b.body.opId, a.body.opId);
});

test('M5A-R52-002 / M5A-R53-001: an older operation is refused once a newer intent exists; an upload opId cannot continue as a clear', async () => {
  const uid = await begin();
  await grantCalendarConsent(uid);
  await enrol(uid);
  const phone = await register(uid);
  const older = await intent(uid, phone.sourceId, phone.sourceSecret, 'upload');
  const newer = await intent(uid, phone.sourceId, phone.sourceSecret, 'upload');
  const stale = await upload(uid, phone.sourceId, phone.sourceSecret, older.body.opId, older.body.epoch);
  assert.equal(stale.status, 409, show(stale.body));
  assert.equal(stale.body.error, 'selection_stale');
  assert.equal(stale.body.currentEpoch, newer.body.epoch);
  const crossKind = await callWith(uid, 'calendar/busy', 'DELETE', {
    query: { sourceId: phone.sourceId, opId: newer.body.opId, epoch: String(newer.body.epoch) },
    headers: { ...CHOICE_HEADER, 'X-MaybeSitter-Source-Secret': phone.sourceSecret },
  });
  assert.ok(crossKind.status >= 400, `an upload opId continued as a clear (${crossKind.status})`);
  assert.equal((await upload(uid, phone.sourceId, phone.sourceSecret, newer.body.opId, newer.body.epoch)).status, 200);
});

test('M5A-R53-003: the intent refuses non-device and unregistered source ids before any side effect', async () => {
  const uid = await begin();
  await grantCalendarConsent(uid);
  await enrol(uid);
  const phone = await register(uid);
  for (const sourceId of ['google:primary', 'ics:feed-1', 'manual-x', 'weekly-x', 'not a source', 'device:unregistered']) {
    const result = await intent(uid, sourceId, phone.sourceSecret, 'upload');
    assert.ok(result.status >= 400 && result.status < 500, `${sourceId} was accepted (${result.status})`);
  }
});

test('M5A-R55-002: an intent with the wrong secret is refused', async () => {
  const uid = await begin();
  await grantCalendarConsent(uid);
  await enrol(uid);
  const phone = await register(uid);
  const result = await intent(uid, phone.sourceId, 'wrong-secret-wrong-secret-wrong-secret', 'upload');
  assert.ok(result.status === 401 || result.status === 403 || result.status === 409, show(result.body));
});

test('M5A-R11-005 (purging): while enrolment is purging, device uploads are refused calendar_choice_purging', async () => {
  const uid = await begin();
  await grantCalendarConsent(uid);
  await currentStorage().set(`users/${uid}/calendarChoice/state`, { v: 1, generation: 1, state: 'purging', enrolledAt: new Date().toISOString(), purge: { owner: 'x', leaseUntil: new Date(Date.now() + 60_000).toISOString(), cursor: null, version: 1 } });
  const result = await callWith(uid, 'calendar/busy', 'POST', {
    body: { sourceId: 'device:any', platform: 'ios', ...WINDOW, blocks: [], choiceVersion: 1, opId: 'x', epoch: 1 },
    headers: { ...CHOICE_HEADER, 'X-MaybeSitter-Source-Secret': 'x' },
  });
  assert.equal(result.status, 409, show(result.body));
  assert.ok(['calendar_choice_purging', 'calendar_choice_required'].includes(result.body.error), show(result.body));
});

/* ── listing, clearing, retiring ────────────────────────────────────── */

test('M5A-R58-002: the sources list shows every registration, including one with no source yet (registered)', async () => {
  const uid = await begin();
  await grantCalendarConsent(uid);
  await enrol(uid);
  const phone = await register(uid);
  const list = await callWith(uid, 'calendar/busy/sources', 'GET', { headers: CHOICE_HEADER });
  assert.equal(list.status, 200, show(list.body));
  const row = list.body.sources.find((entry: any) => entry.sourceId === phone.sourceId);
  assert.ok(row, 'a fresh registration is not listed');
  assert.equal(row.status, 'registered');
  assert.equal(row.lastUploadAt, null);
});

test('M5A-R11-002: a plain clear (no revoke) keeps the registration — the phone can select again and upload', async () => {
  const uid = await begin();
  await grantCalendarConsent(uid);
  await enrol(uid);
  const phone = await register(uid);
  const up = await intent(uid, phone.sourceId, phone.sourceSecret, 'upload');
  assert.equal((await upload(uid, phone.sourceId, phone.sourceSecret, up.body.opId, up.body.epoch)).status, 200);
  const clear = await intent(uid, phone.sourceId, phone.sourceSecret, 'clear');
  assert.equal(clear.status, 200, show(clear.body));
  const cleared = await callWith(uid, 'calendar/busy', 'DELETE', {
    query: { sourceId: phone.sourceId, opId: clear.body.opId, epoch: String(clear.body.epoch) },
    headers: { ...CHOICE_HEADER, 'X-MaybeSitter-Source-Secret': phone.sourceSecret },
  });
  assert.equal(cleared.status, 200, show(cleared.body));
  assert.equal(await deviceRows(uid), 0);
  const again = await intent(uid, phone.sourceId, phone.sourceSecret, 'upload');
  assert.equal(again.status, 200, show(again.body));
  assert.equal((await upload(uid, phone.sourceId, phone.sourceSecret, again.body.opId, again.body.epoch)).status, 200);
});

test('M5A-R53-001: a clear intent succeeds idempotently when the source holds nothing', async () => {
  const uid = await begin();
  await grantCalendarConsent(uid);
  await enrol(uid);
  const phone = await register(uid);
  const clear = await intent(uid, phone.sourceId, phone.sourceSecret, 'clear');
  assert.equal(clear.status, 200, show(clear.body));
});

test('M5A-R58-002 / M5A-R59-001: removal from the list retires the phone permanently — uploads refused, probe revoked, re-registration of the old identity refused', async () => {
  const uid = await begin();
  await grantCalendarConsent(uid);
  await enrol(uid);
  const phone = await register(uid);
  const up = await intent(uid, phone.sourceId, phone.sourceSecret, 'upload');
  assert.equal((await upload(uid, phone.sourceId, phone.sourceSecret, up.body.opId, up.body.epoch)).status, 200);
  const removed = await callWith(uid, 'calendar/busy', 'DELETE', { query: { sourceId: phone.sourceId, revoke: '1' }, headers: CHOICE_HEADER });
  assert.equal(removed.status, 200, show(removed.body));
  const later = await intent(uid, phone.sourceId, phone.sourceSecret, 'upload');
  assert.equal(later.status, 409, show(later.body));
  assert.equal(later.body.error, 'source_revoked');
  const probe = await callWith(uid, 'calendar/choice', 'GET', { query: { sourceId: phone.sourceId }, headers: CHOICE_HEADER });
  assert.equal(probe.body.sourceStatus, 'revoked');
  const reborn = await callWith(uid, 'calendar/busy/register', 'POST', {
    body: { sourceInstallationId: phone.sourceInstallationId, sourceSecret: phone.sourceSecret, registrationId: randomUUID() }, headers: CHOICE_HEADER,
  });
  assert.equal(reborn.status, 409, show(reborn.body));
  assert.equal(reborn.body.error, 'source_revoked');
  const fresh = await register(uid);
  assert.equal(fresh.result.status, 200, 'a brand-new credential registers as a new source');
  assert.notEqual(fresh.sourceId, phone.sourceId);
});

test('M5A-R34-001: revoke=1 is refused for non-device sources before any side effect', async () => {
  const uid = await begin();
  await grantCalendarConsent(uid);
  await enrol(uid);
  for (const sourceId of ['google:primary', 'ics:feed-1', 'manual-x', 'weekly-x']) {
    const result = await callWith(uid, 'calendar/busy', 'DELETE', { query: { sourceId, revoke: '1' }, headers: CHOICE_HEADER });
    assert.ok(result.status >= 400 && result.status < 500, `${sourceId} accepted revoke=1 (${result.status})`);
  }
});

test('M5A-R50-002: privacy-reducing removal stays available when the calendar control is disabled', async () => {
  const uid = await begin();
  await grantCalendarConsent(uid);
  await enrol(uid);
  const phone = await register(uid);
  await currentStorage().set('system/m5aControls', { email: { epoch: 0, enabled: true }, calendar: { epoch: 1, enabled: false } });
  const removed = await callWith(uid, 'calendar/busy', 'DELETE', { query: { sourceId: phone.sourceId, revoke: '1' }, headers: CHOICE_HEADER });
  assert.equal(removed.status, 200, show(removed.body));
});
