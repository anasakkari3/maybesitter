/**
 * M4a Gate B — the server busy read (`GET /api/mobile/calendar/busy`), its
 * release gate, readiness, bounds and fail-closed rules; and the manual-route
 * input hardening (PLAN-M4a R003/R004; M4A-R9-001, R10-001/002, R11-002,
 * R12-001/002/003, R13-001/002, R14-001/002, R15-001, R16-001, R17-001,
 * R18-001/002, R19-001, R20-001).
 *
 * Blocks are written through the real writers: the manual route, and
 * `replaceBusyBlocks` (the one block writer every source uses). ICS feed
 * documents use the real `IcsFeedDocument` shape. The Firestore-backed
 * scan-work assertions live in Task B's emulator test (named in the build
 * prompt); this file pins the contract on the memory adapter.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { replaceBusyBlocks } from '../../../lib/calendar/busyBlocks.ts';
import { getStorage } from '../../../lib/storage/index.ts';
import { ICS_FEEDS, userSubDoc } from '../../../lib/storage/paths.ts';
import { TODAY, TOMORROW, TZ, at, begin, call, end, show } from './support.ts';

const FROM = at(TODAY, '00:00');
const TO = at('2026-11-04', '00:00'); // 28 days

function busy(uid: string, query: Record<string, string> = { from: FROM, to: TO }) {
  return call(uid, 'calendar/busy', 'GET', { query });
}

async function icsFeed(uid: string, feedId: string, status: 'ok' | 'paused' | 'error', lastFetchedAt: string | null): Promise<void> {
  const now = new Date().toISOString();
  await getStorage().set(userSubDoc(uid, ICS_FEEDS, feedId), {
    feedId, label: null, encryptedUrl: { v: 1, keyName: 'test', ciphertext: 'x', iv: 'x', tag: 'x' } as any, hostHash: 'h',
    autoAcceptDeadlines: false, status, consecutiveFailures: status === 'ok' ? 0 : 5, lastErrorCode: status === 'error' ? 'timeout' : null,
    etag: null, lastModified: null, lastFetchedAt, lastFullFetchAt: lastFetchedAt, lastManualRefreshAt: null,
    nextFetchAt: now, createdAt: now, busyBlocks: 1,
  });
}

function block(sourceId: string, kind: string, id: string, startAt: string, endAt: string) {
  return { blockId: id, sourceId, sourceKind: kind, startAt, endAt, allDay: false } as any;
}

async function icsBlocks(uid: string, feedId: string, blocks: Array<[string, string]>): Promise<void> {
  const sourceId = `ics:${feedId}`;
  await replaceBusyBlocks(uid, sourceId, { startsAt: FROM, endsAt: TO },
    blocks.map(([start, endAt], index) => block(sourceId, 'ics', `${feedId}-${index}`, start, endAt)), { platform: null, now: new Date() });
}

async function manualSessions(uid: string, sessions: Array<Record<string, unknown>>, proposalId = 'gate-m4a-manual') {
  return call(uid, 'calendar/manual', 'POST', { body: { proposalId, sessions, timezone: TZ } });
}

/* ── release (M4A-R10-001) ─────────────────────────────────────────── */

for (const [label, switches] of [['off', { freeSlots: false }], ['killed', { killed: true }], ['production', { environment: 'production' }]] as const) {
  test(`M4A-R10-001 flag ${label}: the busy GET answers 404 feature_unavailable before any read`, async () => {
    const uid = begin(switches);
    try {
      const storage = getStorage() as any;
      let reads = 0;
      for (const method of ['get', 'list', 'listGroup', 'query']) {
        if (typeof storage[method] === 'function') {
          const original = storage[method].bind(storage);
          storage[method] = async (...args: unknown[]) => { reads += 1; return original(...args); };
        }
      }
      const result = await busy(uid);
      assert.equal(result.status, 404, show(result.body));
      assert.equal(result.body.reason ?? result.body.error, 'feature_unavailable', show(result.body));
      assert.equal(reads, 0, 'storage was read with the capability off');
    } finally { end(); }
  });
}

/* ── shape and range (M4A-R9-001) ──────────────────────────────────── */

test('M4A-R9-001 the busy GET returns the account\'s ICS and manual blocks, title-free, with ICS readiness', async () => {
  const uid = begin();
  try {
    await icsFeed(uid, 'feed1', 'ok', new Date().toISOString());
    await icsBlocks(uid, 'feed1', [[at(TOMORROW, '14:00'), at(TOMORROW, '16:00')]]);
    const manual = await manualSessions(uid, [{ weekday: 4, start: '10:00', end: '11:00', label: 'محاضرة' }]); // a lecture
    assert.equal(manual.status, 200, show(manual.body));
    const result = await busy(uid);
    assert.equal(result.status, 200, show(result.body));
    const kinds = new Set(result.body.blocks.map((row: any) => row.sourceKind));
    assert.ok(kinds.has('ics') && kinds.has('manual'), show(result.body.blocks));
    for (const row of result.body.blocks) {
      assert.deepEqual(Object.keys(row).sort(), ['allDay', 'blockId', 'endAt', 'sourceId', 'sourceKind', 'startAt'], `not title-free: ${show(row)}`);
    }
    assert.equal(result.body.complete, true);
    assert.equal(result.body.cutoff, null);
    assert.deepEqual(result.body.unknownRanges, []);
    assert.equal(result.body.sources.length, 1, 'ICS feeds only; manual sources have no entry');
    assert.equal(result.body.sources[0].status, 'ok');
    assert.equal(result.body.sources[0].kind, 'ics');
  } finally { end(); }
});

test('M4A-R9-001 a range over 29 days is 400 invalid_range', async () => {
  const uid = begin();
  try {
    const result = await busy(uid, { from: FROM, to: at('2026-11-06', '00:00') });
    assert.equal(result.status, 400, show(result.body));
    assert.equal(result.body.reason, 'invalid_range', show(result.body));
  } finally { end(); }
});

/* ── ICS readiness (M4A-R10-002, R13-002, R14-002) ─────────────────── */

test('M4A-R10-002 ICS readiness: paused, error and stale (26 h) feeds are incomplete', async () => {
  const uid = begin();
  try {
    await icsFeed(uid, 'paused1', 'paused', new Date().toISOString());
    await icsBlocks(uid, 'paused1', []);
    await icsFeed(uid, 'error1', 'error', new Date().toISOString());
    await icsBlocks(uid, 'error1', []);
    await icsFeed(uid, 'stale1', 'ok', new Date(Date.now() - 27 * 3_600_000).toISOString());
    await icsBlocks(uid, 'stale1', []);
    const result = await busy(uid);
    assert.equal(result.status, 200, show(result.body));
    const status = Object.fromEntries(result.body.sources.map((source: any) => [source.sourceId, source.status]));
    assert.equal(status['ics:paused1'], 'paused', show(result.body.sources));
    assert.equal(status['ics:error1'], 'error');
    assert.equal(status['ics:stale1'], 'stale');
  } finally { end(); }
});

test('M4A-R13-002 an interrupted subscription (feed, no source) is uninitialized with null windows', async () => {
  const uid = begin();
  try {
    await icsFeed(uid, 'half1', 'ok', new Date().toISOString());
    const result = await busy(uid);
    assert.equal(result.status, 200, show(result.body));
    const source = result.body.sources.find((entry: any) => entry.sourceId === 'ics:half1');
    assert.ok(source, show(result.body.sources));
    assert.equal(source.status, 'uninitialized');
    assert.equal(source.windowStart, null);
    assert.equal(source.windowEnd, null);
  } finally { end(); }
});

test('M4A-R14-002 an orphan source (an interrupted unsubscribe) is neither returned nor counted', async () => {
  const uid = begin();
  try {
    await icsBlocks(uid, 'gone1', [[at(TOMORROW, '14:00'), at(TOMORROW, '16:00')]]);
    const result = await busy(uid);
    assert.equal(result.status, 200, show(result.body));
    assert.ok(!result.body.blocks.some((row: any) => row.sourceId === 'ics:gone1'), 'orphan blocks returned');
    assert.ok(!result.body.sources.some((entry: any) => entry.sourceId === 'ics:gone1'), 'orphan source listed');
  } finally { end(); }
});

test('M4A-R12-002 a timed ICS block longer than 24 hours that runs into the window is returned', async () => {
  const uid = begin();
  try {
    await icsFeed(uid, 'long1', 'ok', new Date().toISOString());
    // Friday 20:00 to Sunday 10:00; the window starts Sunday 00:00.
    await icsBlocks(uid, 'long1', [[at('2026-10-09', '20:00'), at('2026-10-11', '10:00')]]);
    const result = await busy(uid, { from: at('2026-10-11', '00:00'), to: at('2026-10-12', '00:00') });
    assert.equal(result.status, 200, show(result.body));
    assert.equal(result.body.blocks.filter((row: any) => row.sourceId === 'ics:long1').length, 1, show(result.body));
  } finally { end(); }
});

/* ── bounds (M4A-R12-003, R15-001, R16-001, R17-001) ──────────────── */

test('M4A-R15-001 more than 2000 in-window manual blocks: at most 2000 returned, complete false, cutoff = first omitted start', async () => {
  const uid = begin();
  try {
    const sourceId = 'manual-gate-dense';
    const rows = Array.from({ length: 2100 }, (_, index) => {
      const startAt = new Date(Date.parse(at(TOMORROW, '00:00')) + index * 10 * 60_000).toISOString();
      return block(sourceId, 'manual', `dense-${index}`, startAt, new Date(Date.parse(startAt) + 5 * 60_000).toISOString());
    });
    await replaceBusyBlocks(uid, sourceId, { startsAt: FROM, endsAt: TO }, rows, { platform: null, now: new Date() });
    const result = await busy(uid);
    assert.equal(result.status, 200, show(result.body));
    assert.equal(result.body.blocks.length, 2000);
    assert.equal(result.body.complete, false);
    assert.equal(result.body.cutoff, rows[2000].startAt, 'the cutoff is the first omitted start');
  } finally { end(); }
});

test('M4A-R16-001 R17-001 thousands of expired carry-in rows never hide a live in-window row', async () => {
  const uid = begin();
  try {
    const sourceId = 'manual-gate-carry';
    const from = at(TOMORROW, '00:00');
    const expired = Array.from({ length: 2100 }, (_, index) => {
      const startAt = new Date(Date.parse(from) - 25 * 3_600_000 + index * 30_000).toISOString();
      return block(sourceId, 'manual', `old-${index}`, startAt, new Date(Date.parse(startAt) + 20_000).toISOString());
    });
    const live = block(sourceId, 'manual', 'live', at(TOMORROW, '01:00'), at(TOMORROW, '02:00'));
    await replaceBusyBlocks(uid, sourceId, { startsAt: FROM, endsAt: TO }, [...expired, live], { platform: null, now: new Date() });
    const result = await busy(uid, { from, to: at(TOMORROW, '23:59') });
    assert.equal(result.status, 200, show(result.body));
    assert.ok(result.body.blocks.some((row: any) => row.blockId === 'live'), 'the live row is hidden');
    assert.ok(!result.body.blocks.some((row: any) => String(row.blockId).startsWith('old-')), 'expired rows returned');
  } finally { end(); }
});

test('M4A-R12-003 many empty manual sources keep the answer bounded (no sources entries for manual)', async () => {
  const uid = begin();
  try {
    for (let index = 0; index < 60; index += 1) {
      const result = await manualSessions(uid, [], `gate-empty-${index}`);
      assert.equal(result.status, 200, show(result.body));
    }
    const result = await busy(uid);
    assert.equal(result.status, 200, show(result.body));
    assert.equal(result.body.sources.filter((entry: any) => entry.kind !== 'ics').length, 0, show(result.body.sources));
  } finally { end(); }
});

/* ── fail closed on malformed legacy rows (M4A-R19-001, R20-001) ───── */

test('M4A-R19-001 an inverted legacy manual row (spring-forward Jerusalem 02:30–03:30) makes its surroundings unknown', async () => {
  const uid = begin();
  try {
    const sourceId = 'manual-gate-legacy';
    // What the unchanged writer stores on 2027-03-26: start fell in the gap → «02:30Z», end resolved → ~00:30Z.
    await replaceBusyBlocks(uid, sourceId, { startsAt: '2027-03-20T00:00:00.000Z', endsAt: '2027-04-10T00:00:00.000Z' },
      [block(sourceId, 'manual', 'inverted', '2027-03-26T02:30:00.000Z', '2027-03-26T00:30:00.000Z')], { platform: null, now: new Date() });
    const result = await busy(uid, { from: '2027-03-26T00:00:00.000Z', to: '2027-03-27T00:00:00.000Z' });
    assert.equal(result.status, 200, show(result.body));
    assert.ok(result.body.unknownRanges.length >= 1, show(result.body));
    const covers = result.body.unknownRanges.some((range: any) =>
      Date.parse(range.from) <= Date.parse('2027-03-26T01:00:00.000Z') && Date.parse(range.to) >= Date.parse('2027-03-26T01:30:00.000Z'));
    assert.ok(covers, `03:00–03:30 local (01:00–01:30Z) is not inside an unknown range: ${show(result.body.unknownRanges)}`);
  } finally { end(); }
});

test('M4A-R20-001 an unparseable legacy stamp makes its date-prefix day unknown', async () => {
  const uid = begin();
  try {
    const sourceId = 'manual-gate-broken';
    await replaceBusyBlocks(uid, sourceId, { startsAt: '2027-03-20T00:00:00.000Z', endsAt: '2027-04-10T00:00:00.000Z' },
      [block(sourceId, 'manual', 'broken', '2027-03-26T02:30:00:00.000Z', '2027-03-26T03:30:00.000Z')], { platform: null, now: new Date() });
    const result = await busy(uid, { from: '2027-03-26T00:00:00.000Z', to: '2027-03-27T00:00:00.000Z' });
    assert.equal(result.status, 200, show(result.body));
    assert.ok(result.body.unknownRanges.length >= 1, show(result.body));
  } finally { end(); }
});

test('M4A-R20-001 the manual route refuses malformed times: extra colon components, out-of-range, end not after start', async () => {
  const uid = begin({ freeSlots: false });
  try {
    for (const session of [
      { weekday: 4, start: '02:30:00', end: '03:30' },
      { weekday: 4, start: '24:00', end: '25:00' },
      { weekday: 4, start: '11:00', end: '10:00' },
      { weekday: 4, start: '9:00', end: '10:00' },
    ]) {
      const result = await manualSessions(uid, [session]);
      assert.equal(result.status, 400, `${show(session)} → ${show(result.body)}`);
      assert.equal(result.body.reason, 'invalid_session', show(result.body));
    }
  } finally { end(); }
});

test('M4A-R18-002 flag-off parity of the manual route for well-formed input', async () => {
  const uid = begin({ freeSlots: false });
  try {
    const result = await manualSessions(uid, [{ weekday: 4, start: '10:00', end: '11:00' }]);
    assert.equal(result.status, 200, show(result.body));
    assert.deepEqual(Object.keys(result.body).sort(), ['blocks', 'sourceId', 'success', 'windowEnd', 'windowStart']);
    assert.equal(result.body.blocks, 16, 'a weekly session still expands over 16 weeks');
  } finally { end(); }
});
