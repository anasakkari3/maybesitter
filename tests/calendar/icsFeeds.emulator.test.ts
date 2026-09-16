/**
 * A feed's documents against real Firestore (UC-3.4, #188).
 *
 * `npm test` runs on the memory adapter, which stores whatever JSON accepts and
 * answers any query. Firestore does neither, and #252 shipped a document it
 * refused. This round-trips the shapes this issue writes — the encrypted URL,
 * the proposal rows, the claim merged in the accept transaction — and runs the
 * refresh sweep's range query on `users.icsNextFetchAt` for real.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreStorage } from '../../lib/storage/firestoreAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { ICS_FEED_ITEMS, ICS_FEEDS, userCol, userDoc } from '../../lib/storage/paths.ts';
import { createInMemoryKms } from '../../lib/security/inMemoryKms.ts';
import { KMS_KEY_ENV_VAR, decryptField, fieldPurpose, isEncryptedField } from '../../lib/security/fieldEncryption.ts';
import { getParticipantStateSnapshot } from '../../lib/services/mobile/participantState.ts';
import {
  REFRESH_INTERVAL_MS,
  createIcsFeed,
  decideIcsDeadline,
  deleteIcsFeed,
  runIcsRefreshTick,
  type IcsFeedDocument,
  type IcsFeedItemDocument,
} from '../../lib/calendar/icsFeeds.ts';

const HOUR = 3_600_000;
const NOW = new Date('2026-10-05T08:00:00Z');
const URL_ = 'https://moodle.univ.example/export?authtoken=EMULATORSECRET';

function fmt(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

const BODY = [
  'BEGIN:VCALENDAR', 'VERSION:2.0',
  'BEGIN:VEVENT', 'UID:essay', 'SUMMARY:Essay due', 'DTSTAMP:20260915T080000Z',
  `DTSTART:${fmt(NOW.getTime() + 48 * HOUR)}`, `DTEND:${fmt(NOW.getTime() + 48 * HOUR)}`, 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:lecture', 'SUMMARY:Lecture', 'DTSTAMP:20260915T080000Z',
  `DTSTART:${fmt(NOW.getTime() + 20 * HOUR)}`, `DTEND:${fmt(NOW.getTime() + 22 * HOUR)}`, 'END:VEVENT',
  'END:VCALENDAR', '',
].join('\r\n');

test('firestore: subscribe, accept, sweep and unsubscribe round-trip', async () => {
  const storage = createFirestoreStorage();
  setStorageForTests(storage);
  const uid = `ics_${Date.now().toString(36)}`;
  const kms = createInMemoryKms();
  let now = NOW;
  let fetches = 0;
  const deps = {
    now: () => now,
    encryption: { kms, env: { NODE_ENV: 'test', [KMS_KEY_ENV_VAR]: kms.keyName } as NodeJS.ProcessEnv },
    log: () => undefined,
    fetch: async () => { fetches += 1; return { notModified: false as const, body: BODY, etag: null, lastModified: null }; },
  };
  try {
    const created = await createIcsFeed(uid, { url: URL_, label: 'Moodle' }, deps);
    assert.deepEqual([created.preview.deadlines, created.preview.busyBlocks], [1, 1]);
    const feedId = created.feed.feedId;

    const [feed] = (await storage.list<IcsFeedDocument>(userCol(uid, ICS_FEEDS))).map((row) => row.data);
    assert.ok(isEncryptedField(feed!.encryptedUrl), 'the encrypted URL did not survive Firestore');
    assert.equal(await decryptField(uid, fieldPurpose('ics-url', feedId), feed!.encryptedUrl, deps.encryption), URL_);
    assert.ok(!JSON.stringify(feed).includes('EMULATORSECRET'));

    const [item] = (await storage.list<IcsFeedItemDocument>(userCol(uid, ICS_FEED_ITEMS))).map((row) => row.data);
    const accepted = await decideIcsDeadline(uid, feedId, item!.itemKey, { action: 'accept' }, deps);
    assert.equal(accepted.deadline.state, 'accepted');
    const again = await decideIcsDeadline(uid, feedId, item!.itemKey, { action: 'accept' }, deps);
    assert.equal(again.replayed, true);
    assert.equal(Object.keys((await getParticipantStateSnapshot(uid)).commitments).length, 1, 'accept');

    // The sweep's range query on users.icsNextFetchAt, against Firestore.
    now = new Date(NOW.getTime() + REFRESH_INTERVAL_MS + HOUR);
    const totals = await runIcsRefreshTick({ ...deps, limit: 500 });
    assert.ok(totals.due >= 1, 'the sweep did not find the due feed');
    assert.equal(fetches, 2, 'fetches');

    const removed = await deleteIcsFeed(uid, feedId, deps);
    assert.equal(removed.busyBlocks, 1, 'busy blocks removed');
    assert.equal((await storage.get<Record<string, unknown>>(userDoc(uid)))?.icsNextFetchAt, undefined);
    assert.equal(Object.keys((await getParticipantStateSnapshot(uid)).commitments).length, 1, 'kept');
  } finally {
    await storage.deleteTree(userDoc(uid));
    resetStorageForTests();
  }
});
