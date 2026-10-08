/**
 * M4a Gate B — the Google busy read's window (WIRE-M4a "Google busy window";
 * PLAN-M4a R004, M4A-R2-007 and M4A-R3-002, the honest window).
 *
 * `GET /api/mobile/integrations/google/calendar` adds `windowStart` and
 * `windowEnd` of the last synchronisation, both `null` when nothing was ever
 * synced. When the 1000-interval limit truncates, `windowEnd` is the start of
 * the first omitted interval and nothing at or after it is stored.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { REFERENCE, begin, end, show } from './support.ts';
import { beginGoogle, connectGoogleCalendar, denseIntervals, endGoogle, readGoogle, syncGoogle } from './google.ts';

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const NOW = Date.parse(REFERENCE);

test('R004 never synced: windowStart and windowEnd are null, the existing fields unchanged', async () => {
  const uid = begin();
  beginGoogle();
  try {
    await connectGoogleCalendar(uid);
    const read = await readGoogle(uid);
    assert.equal(read.status, 200, show(read.body));
    assert.equal(read.body.success, true);
    assert.deepEqual(read.body.blocks, []);
    assert.ok('windowStart' in read.body && 'windowEnd' in read.body, `no window fields: ${show(read.body)}`);
    assert.equal(read.body.windowStart, null);
    assert.equal(read.body.windowEnd, null);
  } finally { endGoogle(); end(); }
});

test('M4A-R2-007 a normal sync: the window is now → now + 14 × 24h, an instant', async () => {
  const uid = begin();
  beginGoogle();
  try {
    await connectGoogleCalendar(uid);
    const synced = await syncGoogle(uid, [{ start: iso(NOW + DAY), end: iso(NOW + DAY + 3_600_000) }]);
    assert.equal(synced.body.source.windowEnd, iso(NOW + 14 * DAY));
    const read = await readGoogle(uid);
    assert.equal(read.body.windowStart, iso(NOW), show(read.body));
    assert.equal(read.body.windowEnd, iso(NOW + 14 * DAY), show(read.body));
    assert.equal(read.body.blocks.length, 1);
    assert.deepEqual(Object.keys(read.body.blocks[0]).sort(), ['allDay', 'blockId', 'endAt', 'sourceId', 'sourceKind', 'startAt']);
  } finally { endGoogle(); end(); }
});

test('M4A-R3-002 over 1000 intervals: windowEnd is the first omitted interval, and nothing at or after it is stored', async () => {
  const uid = begin();
  beginGoogle();
  try {
    await connectGoogleCalendar(uid);
    const intervals = denseIntervals(iso(NOW + 3_600_000), 1100);
    const firstOmitted = intervals[1000]!.start;
    const synced = await syncGoogle(uid, intervals);
    assert.equal(synced.body.blocks, 1000, show(synced.body));
    assert.equal(synced.body.source.windowEnd, firstOmitted, `the sync reports the stored 14 days, not its coverage: ${show(synced.body.source)}`);
    const read = await readGoogle(uid);
    assert.equal(read.body.windowStart, iso(NOW));
    assert.equal(read.body.windowEnd, firstOmitted, `the read claims coverage past the omitted tail: ${read.body.windowEnd}`);
    assert.equal(read.body.blocks.length, 1000);
    for (const block of read.body.blocks) {
      assert.ok(Date.parse(block.startAt) < Date.parse(firstOmitted), `a block at or after the honest window end: ${show(block)}`);
    }
  } finally { endGoogle(); end(); }
});

test('M4A-R3-002 a later sync under the limit restores the full window', async () => {
  const uid = begin();
  beginGoogle();
  try {
    await connectGoogleCalendar(uid);
    await syncGoogle(uid, denseIntervals(iso(NOW + 3_600_000), 1100));
    await syncGoogle(uid, denseIntervals(iso(NOW + 3_600_000), 10));
    const read = await readGoogle(uid);
    assert.equal(read.body.windowEnd, iso(NOW + 14 * DAY), show({ windowStart: read.body.windowStart, windowEnd: read.body.windowEnd }));
    assert.equal(read.body.blocks.length, 10);
  } finally { endGoogle(); end(); }
});
