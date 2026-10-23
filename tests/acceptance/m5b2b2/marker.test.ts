/**
 * M5b-2b-2 Gate B, R1 Server: the marker (shape, pending at 0.6, no content,
 * the transactional writer, idempotence across concurrent scans, never
 * re-created once dismissed, at most 20 writes a pass, the matched outcome
 * re-read in the marker's transaction).
 * PLAN-M5b-2b-2 R1 "The marker", R2-003, REV-004. See support.ts for the
 * harness and the gate rules.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  DAY_MS, MARKER_KEYS, NOW, READD_WRITER_MODULE, begin, confirmAt, currentStorage, daysAgo, dismissDirectly, dropAt,
  droppedThenReadded, end, isMarker, learn, loadModule, markerFor, markerId, markers, markersFor, outcomeFor, plusMinutes,
  reviewH, scan, show, spyStorage, withStorage,
} from './support.ts';
import { listObservations } from '../../../lib/intelligence/observationStore.ts';

test.afterEach(() => end());

test('R1 marker: pending at 0.6, exactly the plan\'s fields, bound to the matched outcome, stamped with C.confirmedAt, under a deterministic id', async () => {
  const uid = await begin();
  const { c, outcome, confirmedAt } = await droppedThenReadded(uid, 'Call the dentist');
  await scan(uid);
  const marker = await markerFor(uid, c);
  assert.deepEqual(Object.keys(marker).sort(), [...MARKER_KEYS].sort(), `the marker holds other fields: ${show(marker)}`);
  assert.deepEqual(marker, {
    id: markerId(c),
    source: 'behavior',
    kind: 'outcome',
    sourceRef: `readd:${c}`,
    evidence: 'Re-added',
    confidence: 0.6,
    review: 'pending',
    reviewedAt: null,
    observedAt: confirmedAt,
    linkedMemoryId: null,
    matchedOutcomeId: outcome.id,
  });
});

test('R1 marker: no title or commitment content in the stored document, nor in any log line of the scan', async () => {
  const uid = await begin();
  const title = 'Ask Dr Haddad about the crown';
  const { c } = await droppedThenReadded(uid, title);
  const lines: string[] = [];
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((name) =>
    mock.method(console, name, (...args: unknown[]) => { lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')); }));
  try { await scan(uid); } finally { for (const spy of spies) spy.mock.restore(); }
  const marker = await markerFor(uid, c);
  const stored = JSON.stringify(marker);
  for (const word of ['Haddad', 'crown', title]) {
    assert.equal(stored.includes(word), false, `the marker stores «${word}»: ${stored}`);
    for (const line of lines) assert.equal(line.includes(word), false, `a log line carries «${word}»: ${line}`);
  }
});

test('R1 marker (pending override): only the marker is pending; learned outcomes stay self-confirmed, written through putReaddMarkerInTransaction', async () => {
  const uid = await begin();
  const { c, outcome } = await droppedThenReadded(uid, 'Renew the car insurance');
  await scan(uid);
  const marker = await markerFor(uid, c);
  assert.equal(marker.review, 'pending');
  const after = (await listObservations(uid, currentStorage() as any)).find((row) => row.id === outcome.id);
  assert.deepEqual(after, outcome, 'the scan changed the matched outcome');
  const writer = await loadModule(READD_WRITER_MODULE);
  assert.equal(typeof writer.putReaddMarkerInTransaction, 'function', `putReaddMarkerInTransaction is not exported from ${READD_WRITER_MODULE}`);
});

test('R1/R2-003 marker: two concurrent scans write one marker, bound to the same outcome; a later scan leaves it byte-identical', async () => {
  const uid = await begin();
  const { c, outcome } = await droppedThenReadded(uid, 'Book the dentist again');
  await Promise.all([scan(uid), scan(uid)]);
  const marker = await markerFor(uid, c, 'two concurrent scans did not leave exactly one marker');
  assert.equal(marker.matchedOutcomeId, outcome.id);
  assert.equal((await markers(uid)).length, 1, show(await markers(uid)));
  await scan(uid);
  assert.deepEqual(await markerFor(uid, c), marker, 'a later scan rewrote the marker');
});

test('R1 marker: a dismissed marker is never re-created and a confirmed one never rewritten', async () => {
  const uid = await begin();
  const one = await droppedThenReadded(uid, 'Return the library books');
  const two = await droppedThenReadded(uid, 'Clean the fridge');
  await scan(uid);
  const dismissed = await markerFor(uid, one.c);
  const confirmed = await markerFor(uid, two.c);
  assert.equal((await reviewH(uid, dismissed.id, 'dismissed')).status, 200);
  assert.equal((await reviewH(uid, confirmed.id, 'confirmed')).status, 200);
  const before = [await markerFor(uid, one.c), await markerFor(uid, two.c)];
  assert.equal(before[0].review, 'dismissed');
  assert.equal(before[1].review, 'confirmed');
  await scan(uid);
  assert.deepEqual([await markerFor(uid, one.c), await markerFor(uid, two.c)], before, 'a later scan re-created or rewrote a reviewed marker');
});

test('R1 marker: a pass makes at most 20 marker writes, and later passes write the rest (first enable backfills 30 days, owner decision 2)', async () => {
  const uid = await begin();
  const titles = Array.from({ length: 25 }, (_, index) => `Backfill task number ${index + 1}`);
  for (const title of titles) await dropAt(uid, title, daysAgo(20));
  await learn(uid);
  const cs: string[] = [];
  for (const title of titles) cs.push(await confirmAt(uid, title, daysAgo(10)));
  let writes = 0;
  const proxy = spyStorage(currentStorage(), {
    onWrite: (method, path, value) => {
      if ((method.endsWith('create') || method.endsWith('set')) && path.includes('/intelligenceObservations/') && isMarker(value as any)) writes += 1;
    },
  });
  await withStorage(proxy, () => scan(uid, proxy));
  const first = (await markers(uid)).length;
  assert.ok(first >= 1, 'the first pass wrote no marker');
  assert.ok(writes <= 20 && first <= 20, `one pass made ${writes} marker writes (${first} markers)`);
  for (let pass = 0; pass < 4 && (await markers(uid)).length < 25; pass += 1) {
    writes = 0;
    await withStorage(proxy, () => scan(uid, proxy));
    assert.ok(writes <= 20, `a later pass made ${writes} marker writes`);
  }
  assert.equal((await markers(uid)).length, 25, 'later passes did not finish the backfill');
  for (const c of cs) assert.equal((await markersFor(uid, c)).length, 1);
});

test('R1 marker: the marker transaction re-reads the matched outcome and writes nothing when it was dismissed after detection read it', async () => {
  const uid = await begin();
  const control = await droppedThenReadded(uid, 'Pick up the parcel');
  await scan(uid);
  await markerFor(uid, control.c, 'control: the scan wrote no re-add marker');
  const d = await dropAt(uid, 'Phone the landlord', daysAgo(2));
  await learn(uid);
  const target = await outcomeFor(uid, d, 'commitment_dropped');
  const c = await confirmAt(uid, 'Phone the landlord', plusMinutes(NOW(), -30));
  let fired = false;
  const proxy = spyStorage(currentStorage(), {
    afterRead: async (method, path, _result, options) => {
      if (fired || !method.endsWith('list') || path !== `users/${uid}/intelligenceObservations`) return;
      const clause = (options?.where ?? []).find((where: any[]) => where[0] === 'observedAt' && where[1] === '>=');
      if (!clause || Date.parse(clause[2]) > Date.now() - 30 * DAY_MS) return;
      fired = true;
      await dismissDirectly(uid, target.id);
    },
  });
  await withStorage(proxy, () => scan(uid, proxy));
  assert.ok(fired, 'the scan never read outcomes for re-adds (observedAt >= now − 60 days)');
  assert.deepEqual(await markersFor(uid, c), [], 'a marker was written for an outcome dismissed before the write');
});
