/**
 * M4b Gate B — a calendar feed's auto-accept never accepts a timed clash
 * (condition 24, D5; PLAN-M4b R1.4, M4B-REV-002/008, M4B-R5-001/002,
 * M4B-R6-001/002; WIRE-M4b "ICS").
 *
 * The real feed handlers with an injected fetch (the harness of
 * tests/calendar/icsFeedLifecycle.test.ts, reduced), memory storage, the clock
 * pinned to REFERENCE (Wednesday 2026-10-07 10:00 Jerusalem). A deadline is a
 * VEVENT with DTSTART = DTEND at a clock time (timed) or a DATE (all-day). For
 * collisions a timed `due_by` occupies 30 minutes and clashes with fixed
 * events only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getStorage } from '../../../lib/storage/index.ts';
import { ICS_FEED_ITEMS, userCol } from '../../../lib/storage/paths.ts';
import { applyTrustAction } from '../../../lib/pilot/pilotTrustStore.ts';
import { createInMemoryKms } from '../../../lib/security/inMemoryKms.ts';
import { KMS_KEY_ENV_VAR, resetFieldEncryptionForTests } from '../../../lib/security/fieldEncryption.ts';
import type { SafeFetchOptions, SafeFetchResult } from '../../../lib/net/safeFetch.ts';
import { MANUAL_REFRESH_COOLDOWN_MS, type IcsFeedItemDocument } from '../../../lib/calendar/icsFeeds.ts';
import { handleCreateFeed, handleDeadlineDecision, handleListFeeds, handleRefreshFeed, type IcsRouteDeps } from '../../../lib/calendar/icsFeedRoutes.ts';
import { tokenFor } from '../../support/fakeAuth.ts';
import {
  REFERENCE,
  addEvent,
  addWeekly,
  allCommitments,
  begin,
  dropCommitment,
  end,
  plusMinutes,
  raceAt,
  show,
  type M4bSwitches,
} from './support.ts';

const HOUR = 3_600_000;
const FEED_URL = 'https://moodle.univ.example/calendar/export_execute.php?userid=42&authtoken=SECRETTOKEN0123456789abcdef&preset_what=all';
const BASE = 'http://127.0.0.1:4321';

type Deadline = { uid: string; title: string; dueInHours: number; allDay?: string; sequence?: number };

function fmt(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function calendar(items: Deadline[]): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN'];
  for (const item of items) {
    const due = Date.parse(REFERENCE) + item.dueInHours * HOUR;
    const when = item.allDay ? [`DTSTART;VALUE=DATE:${item.allDay}`, `DTEND;VALUE=DATE:${item.allDay}`] : [`DTSTART:${fmt(due)}`, `DTEND:${fmt(due)}`];
    lines.push('BEGIN:VEVENT', `UID:${item.uid}`, `SUMMARY:${item.title}`, `SEQUENCE:${item.sequence ?? 0}`, 'DTSTAMP:20260915T080000Z', ...when, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR', '');
  return lines.join('\r\n');
}

interface World { uid: string; deps: IcsRouteDeps; body: { value: string }; notModified: { value: boolean }; clock: { now: Date } }

async function world(switches: M4bSwitches = {}): Promise<World> {
  const uid = begin(switches);
  resetFieldEncryptionForTests();
  const kms = createInMemoryKms();
  const body = { value: '' };
  const notModified = { value: false };
  const clock = { now: new Date(REFERENCE) };
  await applyTrustAction(uid, { type: 'record_first_value', at: REFERENCE });
  await applyTrustAction(uid, { type: 'set_calendar_consent', granted: true, at: REFERENCE });
  const deps: IcsRouteDeps = {
    env: { NODE_ENV: 'test', ICS_FEEDS_ENABLED: 'true', [KMS_KEY_ENV_VAR]: kms.keyName } as NodeJS.ProcessEnv,
    now: () => clock.now,
    encryption: { kms, env: { NODE_ENV: 'test', [KMS_KEY_ENV_VAR]: kms.keyName } as NodeJS.ProcessEnv },
    log: () => {},
    classifyTimeoutMs: 15_000,
    fetch: async (_url: string, _options: SafeFetchOptions): Promise<SafeFetchResult> => (notModified.value
      ? { notModified: true, body: '', etag: '"e1"', lastModified: null } as any
      : { notModified: false, body: body.value, etag: '"e1"', lastModified: null }),
  } as IcsRouteDeps;
  return { uid, deps, body, notModified, clock };
}

test.afterEach(() => { end(); resetFieldEncryptionForTests(); });

function request(uid: string, method: string, path: string, payload?: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', authorization: `Bearer ${tokenFor(uid)}` },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
}

async function json(response: Response): Promise<any> {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

async function subscribe(w: World, auto = true): Promise<string> {
  const response = await handleCreateFeed(request(w.uid, 'POST', '/api/mobile/calendar/ics', { url: FEED_URL, autoAcceptDeadlines: auto }), w.uid, w.deps);
  const body = await json(response);
  assert.equal(response.status < 300, true, show(body));
  return body.feed.feedId;
}

async function refresh(w: World, feedId: string): Promise<void> {
  w.clock.now = new Date(w.clock.now.getTime() + MANUAL_REFRESH_COOLDOWN_MS);
  const response = await handleRefreshFeed(request(w.uid, 'POST', `/api/mobile/calendar/ics/${feedId}/refresh`), w.uid, feedId, w.deps);
  assert.ok(response.status < 300, show(await json(response)));
}

async function rows(w: World): Promise<any[]> {
  const listed = await json(await handleListFeeds(request(w.uid, 'GET', '/api/mobile/calendar/ics'), w.uid, w.deps));
  return listed.deadlines;
}

async function stored(w: World): Promise<IcsFeedItemDocument[]> {
  return (await getStorage().list<IcsFeedItemDocument>(userCol(w.uid, ICS_FEED_ITEMS))).map((row) => row.data);
}

async function decide(w: World, feedId: string, itemKey: string, payload: Record<string, unknown>) {
  const response = await handleDeadlineDecision(request(w.uid, 'POST', `/api/mobile/calendar/ics/${feedId}/deadlines/${itemKey}`, payload), w.uid, feedId, itemKey, w.deps);
  return { status: response.status, body: await json(response) };
}

const DUE_48 = () => new Date(Date.parse(REFERENCE) + 48 * HOUR).toISOString(); // Friday 10:00 local

async function activeTitled(w: World, title: string) {
  return (await allCommitments(w.uid)).filter((c) => c.status === 'active' && c.title === title);
}

/* ── auto-accept ────────────────────────────────────────────────────── */

test('R1.4 parity: a timed deadline that clashes with nothing is auto-accepted as today', async () => {
  const w = await world();
  w.body.value = calendar([{ uid: 'essay', title: 'Essay due', dueInHours: 48 }]);
  await subscribe(w);
  assert.equal((await activeTitled(w, 'Essay due')).length, 1);
});

test('R1.4 D5: a timed deadline over a fixed event stays pending with its clash, never auto-accepted', async () => {
  const w = await world();
  await addEvent(w.uid, 'محاضرة', plusMinutes(DUE_48(), -15), plusMinutes(DUE_48(), 45)); // a lecture
  w.body.value = calendar([{ uid: 'essay', title: 'Essay due', dueInHours: 48 }]);
  await subscribe(w);
  assert.equal((await activeTitled(w, 'Essay due')).length, 0, 'a clashing deadline was auto-accepted silently');
  const [row] = await rows(w);
  assert.equal(row.state, 'pending');
  assert.equal(row.held?.reason, 'clash', show(row));
  assert.ok(row.held.clashes.some((c: any) => c.title === 'محاضرة'), show(row.held));
  assert.equal(typeof row.decisionVersion, 'string');
});

test('R1.4 parity: an all-day deadline is auto-accepted as today, whatever the day holds', async () => {
  const w = await world();
  await addEvent(w.uid, 'محاضرة', plusMinutes(DUE_48(), -60), plusMinutes(DUE_48(), 60));
  w.body.value = calendar([{ uid: 'essay', title: 'Essay due', dueInHours: 48, allDay: '20261009' }]);
  await subscribe(w);
  assert.equal((await activeTitled(w, 'Essay due')).length, 1);
});

test('R1.4: a timed deadline under a weekly block stays pending', async () => {
  const w = await world();
  await addWeekly(w.uid, 'تمرين', [5], '09:30', '11:00'); // Friday training
  w.body.value = calendar([{ uid: 'essay', title: 'Essay due', dueInHours: 48 }]);
  await subscribe(w);
  assert.equal((await activeTitled(w, 'Essay due')).length, 0);
  assert.equal((await rows(w))[0].held?.reason, 'clash');
});

test('M4B-R5-001: a held row is accepted on the next refresh once its clash is gone (passes on base by design: base never holds)', async () => {
  const w = await world();
  const lecture = await addEvent(w.uid, 'محاضرة', plusMinutes(DUE_48(), -15), plusMinutes(DUE_48(), 45));
  w.body.value = calendar([{ uid: 'essay', title: 'Essay due', dueInHours: 48 }]);
  const feedId = await subscribe(w);
  await dropCommitment(w.uid, lecture);
  await refresh(w, feedId);
  assert.equal((await activeTitled(w, 'Essay due')).length, 1, 'the held row stayed pending forever');
});

test('M4B-R6-002: a held row is retried even when the feed answers 304 (passes on base by design: base never holds)', async () => {
  const w = await world();
  const lecture = await addEvent(w.uid, 'محاضرة', plusMinutes(DUE_48(), -15), plusMinutes(DUE_48(), 45));
  w.body.value = calendar([{ uid: 'essay', title: 'Essay due', dueInHours: 48 }]);
  const feedId = await subscribe(w);
  await dropCommitment(w.uid, lecture);
  w.notModified.value = true;
  await refresh(w, feedId);
  assert.equal((await activeTitled(w, 'Essay due')).length, 1, 'a 304 skipped the held-row retry');
});

test('M4B-R5-001: a held row the feed moves is re-evaluated (old clash cleared) (passes on base by design: base never holds)', async () => {
  const w = await world();
  await addEvent(w.uid, 'محاضرة', plusMinutes(DUE_48(), -15), plusMinutes(DUE_48(), 45));
  w.body.value = calendar([{ uid: 'essay', title: 'Essay due', dueInHours: 48 }]);
  const feedId = await subscribe(w);
  w.body.value = calendar([{ uid: 'essay', title: 'Essay due', dueInHours: 72, sequence: 1 }]);
  await refresh(w, feedId);
  assert.equal((await activeTitled(w, 'Essay due')).length, 1, 'a moved held row kept its stale clash');
});

test('M4B-R2-002: a fixed event written mid-accept keeps the row pending', async () => {
  const w = await world();
  w.body.value = calendar([{ uid: 'essay', title: 'Essay due', dueInHours: 48 }]);
  const release = await raceAt('ics', async () => { await addEvent(w.uid, 'زيارة', plusMinutes(DUE_48(), -10), plusMinutes(DUE_48(), 50)); });
  try { await subscribe(w); } finally { release(); }
  assert.equal((await activeTitled(w, 'Essay due')).length, 0, 'auto-accepted over an event written during the decision');
});

/* ── the person's tap ───────────────────────────────────────────────── */

test('M4B-R5-002: accept with the version the person saw saves the held deadline knowingly (passes on base by design: base never holds)', async () => {
  const w = await world();
  await addEvent(w.uid, 'محاضرة', plusMinutes(DUE_48(), -15), plusMinutes(DUE_48(), 45));
  w.body.value = calendar([{ uid: 'essay', title: 'Essay due', dueInHours: 48 }]);
  const feedId = await subscribe(w);
  const [row] = await rows(w);
  const result = await decide(w, feedId, row.itemKey, { action: 'accept', expectedDecisionVersion: row.decisionVersion });
  assert.equal(result.status, 200, show(result.body));
  assert.equal((await activeTitled(w, 'Essay due')).length, 1);
});

test('M4B-R5-002: accept without the version the person saw is refused', async () => {
  const w = await world();
  await addEvent(w.uid, 'محاضرة', plusMinutes(DUE_48(), -15), plusMinutes(DUE_48(), 45));
  w.body.value = calendar([{ uid: 'essay', title: 'Essay due', dueInHours: 48 }]);
  const feedId = await subscribe(w);
  const [row] = await rows(w);
  const result = await decide(w, feedId, row.itemKey, { action: 'accept' });
  assert.equal(result.status, 400, `accept without expectedDecisionVersion must be refused: ${show(result.body)}`);
});

test('M4B-R5-002: the feed moved the held row after render → 409 item_changed with the current row', async () => {
  const w = await world();
  await addEvent(w.uid, 'محاضرة', plusMinutes(DUE_48(), -15), plusMinutes(DUE_48(), 45));
  await addEvent(w.uid, 'محاضرة', plusMinutes(DUE_48(), 24 * 60 - 15), plusMinutes(DUE_48(), 24 * 60 + 45)); // keeps the moved row held
  w.body.value = calendar([{ uid: 'essay', title: 'Essay due', dueInHours: 48 }]);
  const feedId = await subscribe(w);
  const [seen] = await rows(w);
  w.body.value = calendar([{ uid: 'essay', title: 'Essay due', dueInHours: 72, sequence: 1 }]);
  await refresh(w, feedId);
  const result = await decide(w, feedId, seen.itemKey, { action: 'accept', expectedDecisionVersion: seen.decisionVersion });
  assert.equal(result.status, 409, show(result.body));
  assert.equal(result.body.error, 'item_changed');
  assert.ok(result.body.row, show(result.body));
  assert.equal((await activeTitled(w, 'Essay due')).length, 0);
});

test('M4B-R6-001: a new clash after render → 409 item_changed, nothing accepted', async () => {
  const w = await world();
  await addEvent(w.uid, 'محاضرة', plusMinutes(DUE_48(), -15), plusMinutes(DUE_48(), 45));
  w.body.value = calendar([{ uid: 'essay', title: 'Essay due', dueInHours: 48 }]);
  const feedId = await subscribe(w);
  const [seen] = await rows(w);
  await addEvent(w.uid, 'اجتماع', plusMinutes(DUE_48(), 0), plusMinutes(DUE_48(), 60)); // not shown to the person
  const result = await decide(w, feedId, seen.itemKey, { action: 'accept', expectedDecisionVersion: seen.decisionVersion });
  assert.equal(result.status, 409, `accepted over a clash the person never saw: ${show(result.body)}`);
  assert.equal(result.body.error, 'item_changed');
});

test('M4B-REV-008: a move from all-day to a timed 10:00 stores proposedAllDay and its clashes', async () => {
  const w = await world();
  w.body.value = calendar([{ uid: 'essay', title: 'Essay due', dueInHours: 48, allDay: '20261009' }]);
  const feedId = await subscribe(w);
  assert.equal((await activeTitled(w, 'Essay due')).length, 1);
  await addEvent(w.uid, 'محاضرة', plusMinutes(DUE_48(), -15), plusMinutes(DUE_48(), 45));
  w.body.value = calendar([{ uid: 'essay', title: 'Essay due', dueInHours: 48, sequence: 1 }]);
  await refresh(w, feedId);
  const row = (await rows(w)).find((r) => r.notice === 'moved');
  assert.ok(row, show(await rows(w)));
  assert.equal(row.proposedAllDay, false);
  assert.ok(row.proposedClashes?.some((c: any) => c.title === 'محاضرة'), `the move into a clash is not shown: ${show(row)}`);
  const storedRow = (await stored(w)).find((r) => r.itemKey === row.itemKey) as any;
  assert.equal(storedRow.proposedAllDay, false, 'proposedAllDay is not stored with proposedDueAt');
});

/* ── release ────────────────────────────────────────────────────────── */

for (const [name, switches] of [['off', { hold: false }], ['killed', { holdKilled: true }]] as const) {
  test(`R1.4 release parity (${name}): a clashing timed deadline is auto-accepted exactly as today`, async () => {
    const w = await world(switches);
    await addEvent(w.uid, 'محاضرة', plusMinutes(DUE_48(), -15), plusMinutes(DUE_48(), 45));
    w.body.value = calendar([{ uid: 'essay', title: 'Essay due', dueInHours: 48 }]);
    await subscribe(w);
    assert.equal((await activeTitled(w, 'Essay due')).length, 1);
    const [row] = await rows(w);
    assert.equal('held' in row, false);
    assert.equal('decisionVersion' in row, false);
  });
}
