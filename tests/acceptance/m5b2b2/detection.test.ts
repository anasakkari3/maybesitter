/**
 * M5b-2b-2 Gate B, R1 Server: detection (the join at scan time, the 30-day
 * window, D17's normalization, full titles through the outcome's event,
 * the resolver's fail-closed cases, the pass order, both enabled modes, the
 * one single-field outcome read).
 * PLAN-M5b-2b-2 R1, D17, D19, R2-002, R3-001, R4-001, REV-003. See support.ts
 * for the harness and the gate rules.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DAY_MS, NOW, begin, completeAt, confirmAt, currentStorage, daysAgo, dropAt, droppedThenReadded, end, eventFor,
  eventsCol, floodEvents, learn, markerFor, markersFor, minusMs, outcomeFor, plusMinutes, reviewH, scan, setMode, show,
  spyStorage, userDoc, withStorage,
} from './support.ts';

test.afterEach(() => end());

const HOUR_AGO = () => plusMinutes(NOW(), -60);

/* ── the join ───────────────────────────────────────────────────────── */

test('R1 detection: confirming within 30 days of a learned drop of the same title writes one marker bound to that outcome', async () => {
  const uid = await begin();
  const { c, outcome } = await droppedThenReadded(uid, 'Call the dentist');
  await scan(uid);
  const marker = await markerFor(uid, c);
  assert.equal(marker.matchedOutcomeId, outcome.id, show(marker));
});

test('R1 detection: the same after a learned completion', async () => {
  const uid = await begin();
  const { c, outcome } = await droppedThenReadded(uid, 'Water the plants', { verb: 'completed' });
  await scan(uid);
  const marker = await markerFor(uid, c);
  assert.equal(marker.matchedOutcomeId, outcome.id, show(marker));
});

test('D19 detection: a re-add is not memory provenance, so on_nobasis writes markers as on_basis does', async () => {
  for (const mode of ['on_basis', 'on_nobasis'] as const) {
    const uid = await begin();
    setMode(mode);
    const { c } = await droppedThenReadded(uid, 'Renew the passport');
    await scan(uid);
    await markerFor(uid, c, `${mode}: the scan wrote no re-add marker`);
    end();
  }
});

/* ── the window (D17) ───────────────────────────────────────────────── */

test('D17 detection: an outcome exactly 30 days before the confirm matches; 30 days + 1 ms, one after the confirm, or a confirm older than 30 days do not', async () => {
  const uid = await begin();
  const confirmed = HOUR_AGO();
  // Control: exactly 30 days before the confirm (the window is closed at its start).
  await dropAt(uid, 'Edge exactly thirty days', minusMs(confirmed, 30 * DAY_MS));
  // 30 days + 1 ms before the confirm.
  await dropAt(uid, 'Edge one ms too old', minusMs(confirmed, 30 * DAY_MS + 1));
  // The confirm came first, the drop a day later.
  const laterConfirm = daysAgo(2);
  await dropAt(uid, 'Edge dropped after the confirm', daysAgo(1));
  // A confirm older than 30 days, after a drop a day before it.
  const oldConfirm = minusMs(NOW(), 30 * DAY_MS + 1);
  await dropAt(uid, 'Edge confirm too old', minusMs(oldConfirm, DAY_MS));
  await learn(uid);
  const exact = await confirmAt(uid, 'Edge exactly thirty days', confirmed);
  const tooOld = await confirmAt(uid, 'Edge one ms too old', confirmed);
  const before = await confirmAt(uid, 'Edge dropped after the confirm', laterConfirm);
  const stale = await confirmAt(uid, 'Edge confirm too old', oldConfirm);
  await scan(uid);
  await markerFor(uid, exact, 'control: an outcome exactly 30 days before the confirm wrote no marker');
  assert.deepEqual(await markersFor(uid, tooOld), [], 'an outcome 30 days + 1 ms before the confirm matched');
  assert.deepEqual(await markersFor(uid, before), [], 'an outcome observed after the confirm matched');
  assert.deepEqual(await markersFor(uid, stale), [], 'a confirm older than 30 days was treated as a re-add');
});

/* ── which outcomes count ───────────────────────────────────────────── */

test('R1 detection: an outcome the person dismissed («مش صحيح») supports no re-add', async () => {
  const uid = await begin();
  const control = await droppedThenReadded(uid, 'Book the train');
  const d = await dropAt(uid, 'Clean the garage', daysAgo(3));
  await learn(uid);
  const rejected = await outcomeFor(uid, d, 'commitment_dropped');
  assert.equal((await reviewH(uid, rejected.id, 'dismissed')).status, 200, 'fixture: the outcome could not be dismissed');
  const c = await confirmAt(uid, 'Clean the garage', HOUR_AGO());
  await scan(uid);
  await markerFor(uid, control.c, 'control: the scan wrote no re-add marker');
  assert.deepEqual(await markersFor(uid, c), [], 'a dismissed outcome supported a re-add');
});

test('R1 detection: a drop that never became an outcome (consent off at the time: no observation) supports no re-add, even though domain state holds it', async () => {
  const uid = await begin();
  const control = await droppedThenReadded(uid, 'Pay the electricity bill');
  // Dropped, never learned: the outcome pass will not see its event again
  // (more than 100 newer events), exactly as a drop made with consent off.
  const d = await dropAt(uid, 'Fix the bike', daysAgo(3));
  const c = await confirmAt(uid, 'Fix the bike', HOUR_AGO());
  await floodEvents(uid, 101, plusMinutes(NOW(), -50));
  await scan(uid);
  await markerFor(uid, control.c, 'control: the scan wrote no re-add marker');
  const state = await currentStorage().get<any>(`${userDoc(uid)}/commitments/${d}`);
  assert.ok(state?.droppedAt, 'fixture: the drop is not in domain state');
  assert.deepEqual(await markersFor(uid, c), [], 'a drop with no learned outcome (domain state only) supported a re-add');
});

/* ── titles (D17, R2-002) ───────────────────────────────────────────── */

test('D17 detection: titles match after NFKC, lowercase, trim, collapsed whitespace and removed Arabic diacritics and tatweel; a near-duplicate does not', async () => {
  const uid = await begin();
  await dropAt(uid, 'Call the Dentist', daysAgo(3));
  await dropAt(uid, 'اتصل بالدكتور', daysAgo(3));
  await learn(uid);
  const spaced = await confirmAt(uid, '  call  THE   dentist ', HOUR_AGO());
  const wide = await confirmAt(uid, 'Ｃａｌｌ the dentist', HOUR_AGO());
  const arabic = await confirmAt(uid, 'اتّصـــل   بالدكتورْ', HOUR_AGO());
  const near = await confirmAt(uid, 'Call the dentists', HOUR_AGO());
  await scan(uid);
  await markerFor(uid, spaced, 'case and whitespace: no marker');
  await markerFor(uid, wide, 'NFKC (full-width letters): no marker');
  await markerFor(uid, arabic, 'Arabic diacritics and tatweel: no marker');
  assert.deepEqual(await markersFor(uid, near), [], 'a near-duplicate title matched (D17 is exact; fuzzy matching is out of scope)');
});

test('R2-002 detection: titles are compared in full through the outcome\'s commitment: equal up to the 240-character evidence cut and different after it do not match', async () => {
  const uid = await begin();
  const stem = `Prepare the quarterly report ${'and its appendix '.repeat(18)}`;
  assert.ok(stem.length > 240, 'fixture: the shared stem must pass the evidence cut');
  await dropAt(uid, `${stem}for the board`, daysAgo(3));
  await learn(uid);
  const same = await confirmAt(uid, `${stem}for the board`, HOUR_AGO());
  const differentTail = await confirmAt(uid, `${stem}for the auditors`, HOUR_AGO());
  await scan(uid);
  await markerFor(uid, same, 'control: the full, equal title wrote no marker');
  assert.deepEqual(await markersFor(uid, differentTail), [], 'titles equal only up to the evidence cut matched');
});

/* ── resolving the outcome's commitment (R3-001, R4-001) ────────────── */

/** A learned drop of `title`, then its stored event changed by `mutate` (or removed), then C «title». */
async function resolverCase(uid: string, title: string, mutate: ((event: any) => any) | 'remove'): Promise<string> {
  const d = await dropAt(uid, title, daysAgo(3));
  await learn(uid);
  await outcomeFor(uid, d, 'commitment_dropped');
  const event = await eventFor(uid, d, 'commitment_dropped');
  const path = `${eventsCol(uid)}/${event.id}`;
  if (mutate === 'remove') await currentStorage().delete(path);
  else await currentStorage().set(path, mutate({ ...event }));
  return confirmAt(uid, title, HOUR_AGO());
}

test('R3-001 detection: an outcome resolves only through its stored event: a missing event, a wrong type, a mismatched verb, no aggregateId or an unknown commitment each fail closed', async () => {
  const uid = await begin();
  const normal = await resolverCase(uid, 'Resolver normal case', (event) => event);
  const missing = await resolverCase(uid, 'Resolver missing event', 'remove');
  const wrongType = await resolverCase(uid, 'Resolver wrong type', (event) => ({ ...event, type: 'commitment_postponed' }));
  const mismatched = await resolverCase(uid, 'Resolver mismatched verb', (event) => ({ ...event, type: 'commitment_completed' }));
  const noAggregate = await resolverCase(uid, 'Resolver no aggregate', ({ aggregateId: _gone, ...event }) => event);
  const unknown = await resolverCase(uid, 'Resolver unknown commitment', (event) => ({ ...event, aggregateId: 'no-such-commitment' }));
  await scan(uid);
  await markerFor(uid, normal, 'control: a normally resolved outcome wrote no marker');
  for (const [name, c] of Object.entries({ missing, wrongType, mismatched, noAggregate, unknown })) {
    assert.deepEqual(await markersFor(uid, c), [], `${name}: an unresolvable outcome supported a re-add (the evidence text must never be used)`);
  }
});

test('R4-001 detection: the persisted literals the state machine writes resolve, for drops and completions; CamelCase variants are rejected', async () => {
  const uid = await begin();
  const d = await dropAt(uid, 'Literal dropped', daysAgo(3));
  const k = await completeAt(uid, 'Literal completed', daysAgo(3));
  await learn(uid);
  assert.equal((await eventFor(uid, d, 'commitment_dropped')).type, 'commitment_dropped');
  assert.equal((await eventFor(uid, k, 'commitment_completed')).type, 'commitment_completed');
  const dropped = await confirmAt(uid, 'Literal dropped', HOUR_AGO());
  const completed = await confirmAt(uid, 'Literal completed', HOUR_AGO());
  const camel = await resolverCase(uid, 'Literal camel case', (event) => ({ ...event, type: 'CommitmentDropped' }));
  const lowerCamel = await resolverCase(uid, 'Literal lower camel', (event) => ({ ...event, type: 'commitmentDropped' }));
  await scan(uid);
  await markerFor(uid, dropped, 'a real commitment_dropped event did not resolve');
  await markerFor(uid, completed, 'a real commitment_completed event did not resolve');
  assert.deepEqual(await markersFor(uid, camel), [], 'CommitmentDropped resolved');
  assert.deepEqual(await markersFor(uid, lowerCamel), [], 'commitmentDropped resolved');
});

/* ── pass order and reads (REV-003, R1 Reads) ───────────────────────── */

test('REV-003 detection: the re-add pass runs under the gate even when the newest 100 events hold no outcome', async () => {
  const uid = await begin();
  const { c, outcome } = await droppedThenReadded(uid, 'Send the invoice');
  await floodEvents(uid, 101, plusMinutes(NOW(), -50));
  await scan(uid);
  const marker = await markerFor(uid, c, 'no marker when the newest 100 events hold no outcome');
  assert.equal(marker.matchedOutcomeId, outcome.id);
});

test('R1 reads: re-add outcomes are read with one single-field query, observedAt >= now − 60 days', async () => {
  const uid = await begin();
  const { c } = await droppedThenReadded(uid, 'Order the books');
  const queries: any[] = [];
  const proxy = spyStorage(currentStorage(), {
    onRead: (method, path, options) => {
      if (method.endsWith('list') && path === `users/${uid}/intelligenceObservations`) queries.push(options ?? null);
    },
  });
  await withStorage(proxy, () => scan(uid, proxy));
  await markerFor(uid, c);
  const since = new Date(Date.now() - 60 * DAY_MS).toISOString();
  const readd = queries.filter((options) => JSON.stringify(options?.where) === JSON.stringify([['observedAt', '>=', since]]));
  assert.equal(readd.length, 1, `expected one observedAt >= ${since} query, saw ${show(queries)}`);
  assert.equal(readd[0].orderBy, undefined, 'the re-add outcome read orders by a second field (a composite index)');
});
