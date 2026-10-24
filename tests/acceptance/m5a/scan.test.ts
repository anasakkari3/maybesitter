/**
 * M5a Gate B — the one email scan (PLAN-M5a R2.1–R2.2, Wire; addendum G-1):
 * the versioned request, V2 documents, coverage of every message in the
 * frozen window, status that says what happened, failure and resume, the
 * queue, and parity for older app builds.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NOW, TZ, begin, beginGoogle, call, connectGoogle, currentStorage, end, plusDays, plusMinutes, runScanToEnd,
  scanNew, scanResume, scanStatus, semanticModel, show, tick,
} from './support.ts';

test.afterEach(() => end());

const requestOf = (text: string) => {
  const evidence = /Please [^.\n]+/.exec(text)?.[0];
  return evidence ? [{ kind: 'request', evidence, confidence: 0.9 }] : [];
};

async function setup(count: number, options: { switches?: Parameters<typeof begin>[0] } = {}) {
  const uid = await begin(options.switches);
  const model = semanticModel(requestOf);
  const google = beginGoogle(model);
  await connectGoogle(uid, 'gmail');
  google.messages = Array.from({ length: count }, (_, index) => ({
    id: `m-${String(index).padStart(4, '0')}`,
    receivedAt: plusMinutes(plusDays(NOW(), -2), index),
    subject: `Subject ${index}`,
    text: `Please review item ${index}.`,
    category: index % 3 === 0 ? 'CATEGORY_PROMOTIONS' : 'CATEGORY_PERSONAL',
  }));
  return { uid, google, model };
}

test('M5A-R5-002 parity: a scan POST without m5 keeps the base behaviour and shape under the flag', async () => {
  const { uid } = await setup(4);
  const result = await call(uid, 'intelligence/sources/gmail/scan', 'POST', { body: {} });
  assert.equal(result.status, 200, show(result.body));
  assert.ok(['running', 'complete', 'busy'].includes(result.body.scan?.status), show(result.body));
  assert.equal(result.body.scan?.startedAt, undefined, 'the base answer must not gain M5a fields');
  assert.equal(await currentStorage().get(`users/${uid}/intelligenceGmailScans/manualV2`), null, 'a base request touched manualV2');
});

test('M5A-R5-002: m5 requests are refused 409 m5_unavailable when email sources is off', async () => {
  const { uid } = await setup(1, { switches: { emailSources: false } });
  const result = await scanNew(uid);
  assert.equal(result.status, 409, show(result.body));
  assert.equal(result.body.error, 'm5_unavailable');
});

test('Wire: the scan GET is 404 when email sources is off', async () => {
  const { uid } = await setup(1, { switches: { emailSources: false } });
  assert.equal((await scanStatus(uid)).status, 404);
});

test('M5A-R6-001: an M5a scan writes manualV2 and never touches latest', async () => {
  const { uid } = await setup(5);
  const result = await scanNew(uid);
  assert.equal(result.status, 200, show(result.body));
  assert.ok(await currentStorage().get(`users/${uid}/intelligenceGmailScans/manualV2`), 'no manualV2 document');
  assert.equal(await currentStorage().get(`users/${uid}/intelligenceGmailScans/latest`), null, 'an M5a scan wrote latest');
});

test('R2.1 / M5A-R36-006: every message of the frozen 7-day window is read, all categories, across 100-id pages, no cap', async () => {
  const { uid, google, model } = await setup(250);
  const status = await runScanToEnd(uid, 300);
  assert.equal(status.manual?.status, 'complete', show(status));
  assert.equal(status.manual.messagesRead, 250);
  assert.equal(status.manual.messagesSkippedBulk, 84);
  assert.equal(model.calls(), 166, 'bulk messages reached the semantic model');
  assert.equal(new Set(google.gets).size, 250, 'not every message was fetched');
  const lists = google.listQueries.filter((entry) => entry.q?.includes('after:'));
  assert.ok(lists.length >= 3, 'expected at least three listing pages');
  assert.ok(lists.every((entry) => entry.maxResults === 100), 'M5a listing pages must be 100 ids');
  assert.equal(new Set(lists.map((entry) => entry.q)).size, 1, 'the window must stay frozen across pages');
  assert.ok(lists.every((entry) => !/category:primary/.test(entry.q ?? '')), 'the scan must not be limited to Primary');
});

test('R2.2 / G-1: the status is a strict union with scanId, origin, window, startedAt and counts', async () => {
  const { uid } = await setup(3);
  await scanNew(uid);
  const status = await runScanToEnd(uid);
  const manual = status.manual;
  assert.equal(manual.status, 'complete');
  for (const field of ['scanId', 'origin', 'from', 'until', 'startedAt', 'finishedAt', 'messagesRead', 'messagesUnavailable', 'messagesTrimmed', 'messagesSkippedBulk', 'messagesUnanalysed', 'observationsFound', 'addedFromEmail']) {
    assert.ok(field in manual, `ScanStatus lacks ${field}`);
  }
  assert.equal(manual.origin, 'manual');
  assert.equal(manual.observationsFound, 2);
  assert.equal(manual.messagesSkippedBulk, 1);
  assert.equal(manual.messagesUnanalysed, 0);
  assert.equal(manual.addedFromEmail, 0);
});

test('R2.1: a message longer than 12,000 characters is analysed from its start and counted trimmed', async () => {
  const { uid, google, model } = await setup(0);
  google.messages = [{ id: 'long-1', receivedAt: plusDays(NOW(), -1), subject: 'Long', text: `Please call the bank.\n${'x'.repeat(13_000)}` }];
  const status = await runScanToEnd(uid);
  assert.equal(status.manual.messagesTrimmed, 1);
  assert.equal(status.manual.observationsFound, 1);
  assert.ok(model.calls() >= 1);
});

test('M5A-010: a legacy marker (no v) in the window is analysed once under M5a, and not again', async () => {
  const { uid, google, model } = await setup(0);
  google.messages = [{ id: 'old-1', receivedAt: plusDays(NOW(), -1), subject: 'Old', text: 'Please sign the form.' }];
  const { createHash } = await import('node:crypto');
  const legacyId = createHash('sha256').update('gmail\0old-1').digest('hex');
  await currentStorage().set(`users/${uid}/intelligenceSourceMarkers/${legacyId}`, { processedAt: plusDays(NOW(), -1) });
  await runScanToEnd(uid);
  assert.equal(model.calls(), 1, 'the legacy-marked message was not re-analysed once');
  await scanNew(uid);
  await runScanToEnd(uid);
  assert.equal(model.calls(), 1, 'a second scan re-analysed a v2-done message');
});

test('R2.2: a Gmail failure records failed + failure, and resume continues the same frozen window', async () => {
  const { uid, google } = await setup(8);
  const first = await scanNew(uid);
  assert.equal(first.status, 200, show(first.body));
  google.gmailStatus = 500;
  const failed = await scanResume(uid, (await scanStatus(uid)).body.manual.scanId);
  assert.ok(failed.status < 500, show(failed.body));
  const status = (await scanStatus(uid)).body.manual;
  assert.equal(status.status, 'failed', show(status));
  assert.equal(status.failure, 'source_unavailable');
  assert.ok(status.failedAt);
  google.gmailStatus = null;
  const scanId = status.scanId;
  // «كمّل من وين وقفت»: the person resumes the failed scan; then it runs to the end.
  const resumed = await scanResume(uid, scanId);
  assert.ok(resumed.status < 500, show(resumed.body));
  const done = await runScanToEnd(uid);
  assert.equal(done.manual.scanId, scanId, 'resume started a different scan');
  assert.equal(done.manual.status, 'complete');
  assert.equal(done.manual.messagesRead, 8);
  const windows = new Set(google.listQueries.filter((entry) => entry.q?.includes('after:')).map((entry) => entry.q));
  assert.equal(windows.size, 1, 'resume changed the frozen window');
});

test('#815 F3: during the backoff a sweep tick does nothing, while the person\'s resume tap retries now', async () => {
  const { uid, google } = await setup(3);
  assert.equal((await scanNew(uid)).status, 200);
  const scanId = (await scanStatus(uid)).body.manual.scanId;
  google.gmailStatus = 500;
  await scanResume(uid, scanId);
  const failed = (await scanStatus(uid)).body.manual;
  assert.equal(failed.status, 'failed', show(failed));
  assert.equal(failed.failure, 'source_unavailable');
  const stored = await currentStorage().get<any>(`users/${uid}/intelligenceGmailScans/manualV2`);
  assert.ok(Date.parse(stored.nextEligibleAt) > Date.now(), 'the failed scan did not back off');
  google.gmailStatus = null;
  const gets = google.gets.length;
  await tick('sweep');
  assert.equal(google.gets.length, gets, 'the unattended sweep stepped inside the backoff');
  assert.equal((await scanStatus(uid)).body.manual.status, 'failed');
  const resumed = await scanResume(uid, scanId);
  assert.ok(resumed.status < 500, show(resumed.body));
  assert.ok(google.gets.length > gets, 'the resume tap waited out the backoff');
  assert.notEqual((await scanStatus(uid)).body.manual.status, 'failed');
});

test('M5A-R40-001: a stale resume (wrong expectedScanId) returns the current status and starts nothing', async () => {
  const { uid } = await setup(4);
  await scanNew(uid);
  const before = (await scanStatus(uid)).body.manual.scanId;
  const stale = await scanResume(uid, 'not-the-scan');
  assert.ok(stale.status === 200 || stale.status === 409, show(stale.body));
  assert.equal((await scanStatus(uid)).body.manual.scanId, before);
});

test('M5A-R38-004 / M5A-R39-004: a new request behind a running scan is queued once; a repeat returns the same queue', async () => {
  const { uid } = await setup(250);
  await scanNew(uid);
  const queued = await scanNew(uid, { origin: 'backfill' });
  assert.equal(queued.status, 200, show(queued.body));
  const status = (await scanStatus(uid)).body;
  assert.ok(status.queuedManual, 'no queuedManual on the status');
  assert.equal(status.queuedManual.origin, 'backfill');
  const repeat = await scanNew(uid, { origin: 'backfill' });
  assert.equal((await scanStatus(uid)).body.queuedManual.acceptedAt, status.queuedManual.acceptedAt, 'a repeated confirmation replaced the queue');
  void repeat;
});

test('M5A-R24-005: after completion, an explicitly confirmed new scan starts a fresh window that includes a new message', async () => {
  const { uid, google } = await setup(2);
  const first = await runScanToEnd(uid);
  assert.equal(first.manual.status, 'complete');
  google.messages = [...google.messages, { id: 'new-1', receivedAt: NOW(), subject: 'New', text: 'Please confirm the venue.' }];
  await scanNew(uid);
  const second = await runScanToEnd(uid);
  assert.notEqual(second.manual.scanId, first.manual.scanId);
  assert.ok(google.gets.includes('new-1'), 'the new message was not read');
});

test('M5A-R11-006: a message deleted between listing and fetch counts as unavailable, never as read', async () => {
  const { uid, google } = await setup(3);
  // The oldest message is listed last, so it is fetched after the listing checkpoint.
  google.messages = google.messages.map((message, index) => (index === 0 ? { ...message, id: 'vanished' } : message));
  const listed = [...google.messages];
  // List with the original ids, then remove one before its fetch.
  await scanNew(uid);
  google.messages = listed.filter((message) => message.id !== 'vanished');
  const status = await runScanToEnd(uid);
  assert.equal(status.manual.messagesRead + status.manual.messagesUnavailable, 3);
});

test('M5A-R5-006: a rejected page token restarts listing without double counting', async () => {
  const { uid, google } = await setup(150);
  await scanNew(uid);
  google.rejectPageTokens.add('100');
  const status = await runScanToEnd(uid, 300);
  assert.equal(status.manual.status, 'complete', show(status));
  assert.equal(status.manual.messagesRead, 150, 'a listing restart double-counted or skipped');
});

test('R2.2: the scan timezone is stored on the scan only; users/{uid}.timezone is never written', async () => {
  const { uid } = await setup(1);
  await scanNew(uid, { timezone: TZ });
  const user = await currentStorage().get<any>(`users/${uid}`);
  assert.ok(!user || user.timezone === null || user.timezone === undefined, 'an M5a route wrote the account timezone');
});
