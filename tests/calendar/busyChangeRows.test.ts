/**
 * Every busy-block write announces itself to the replan tick (#611).
 *
 * The replan tick can only react to a calendar change it is told about: a
 * `PlanningStateChange` row with `source: 'calendar'` whose `entityId` is the
 * block's id (#605 resolves it from there). Until #611 nothing wrote one, so a
 * meeting landing on a scheduled task never replanned anything.
 *
 * What is pinned here, writer by writer:
 *
 *  - **Add, move, remove.** A new block is one row, a removed block is one row,
 *    and a moved meeting is **two** rows, because its id hashes its start: the
 *    old id (which now resolves as deleted and frees the time) and the new id
 *    (which resolves to the new interval).
 *  - **Nothing changed, nothing written.** A re-sync of an identical calendar
 *    writes no row, however large. A 28-day phone window or a semester feed is
 *    re-sent many times a day; a producer that announced every block every time
 *    would bury the one change that matters.
 *  - **Content-free.** A row carries the contract's keys and nothing else: no
 *    source id, no title.
 *  - **A row is never ahead of its block.** Each block and its row commit
 *    together, and additions commit before removals, so a tick running mid-sync
 *    never resolves one of this sync's rows as a deletion it is not.
 *
 * And the census: every module that can write busy blocks, found in the syntax
 * tree, so a writer added later without rows fails here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createMemoryStorage, type MemoryStorageAdapter } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { BUSY_BLOCKS, PLANNING_STATE_CHANGES, userCol, userDoc } from '../../lib/storage/paths.ts';
import { applyTrustAction } from '../../lib/pilot/pilotTrustStore.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import {
  BUSY_CHANGE_ID_PREFIX,
  busyBlockId,
  deleteBusySource,
  replaceBusyBlocks,
  type BusyBlock,
} from '../../lib/calendar/busyBlocks.ts';
import { acceptLectureSessionsAsBusyBlocks, manualBusySourceId } from '../../lib/calendar/manualBusy.ts';
import { resolveChangedEntityFacts } from '../../lib/services/dailyPlan/changedEntityFacts.ts';
import { DELETE as busyDelete, POST as busyPost } from '../../src/app/api/mobile/calendar/busy/route.ts';
import {
  DELETE as manualDelete,
  POST as manualPost,
} from '../../src/app/api/mobile/calendar/manual/route.ts';
import type { PlanningStateChange } from '../../src/contracts/v1/watcherContracts.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE = 'http://127.0.0.1:4321';
const UID = 'user_busy_rows';
const SOURCE = 'device:6f1d1a2e-2c5f-4a7b-9f0e-3b2d4c5e6f70';
const DAY = '2026-09-15';
const WINDOW = { startsAt: `${DAY}T00:00:00.000Z`, endsAt: '2026-10-13T00:00:00.000Z' };

function at(hhmm: string, day = DAY): string {
  return `${day}T${hhmm}:00.000Z`;
}

/** A timed block from a native event id and a time: the id hashes the start, as the phone's does. */
function block(nativeId: string, from: string, to: string, options: { allDay?: boolean; sourceId?: string } = {}): BusyBlock {
  const sourceId = options.sourceId ?? SOURCE;
  return {
    blockId: busyBlockId(sourceId, nativeId, from),
    sourceId,
    sourceKind: sourceId.startsWith('manual') ? 'manual' : 'device',
    startAt: from,
    endAt: to,
    allDay: options.allDay ?? false,
  };
}

/** A live account: rows are only written for one (see `commitTransitions`). */
async function liveAccount(storage: StorageAdapter, uid = UID): Promise<void> {
  await storage.set(userDoc(uid), { timezone: 'UTC', locale: 'en' });
}

async function rows(storage: StorageAdapter, uid = UID): Promise<PlanningStateChange[]> {
  return (await storage.list<PlanningStateChange>(userCol(uid, PLANNING_STATE_CHANGES))).map((row) => row.data);
}

/** The rows written since the last call, and the collection emptied (what a tick's drain does). */
async function drain(storage: StorageAdapter, uid = UID): Promise<PlanningStateChange[]> {
  const found = await storage.list<PlanningStateChange>(userCol(uid, PLANNING_STATE_CHANGES));
  for (const row of found) await storage.delete(`${userCol(uid, PLANNING_STATE_CHANGES)}/${row.id}`);
  return found.map((row) => row.data);
}

/** What each row resolves to now, as the tick reads it (#605). */
async function resolved(storage: StorageAdapter, changes: readonly PlanningStateChange[], uid = UID) {
  const facts = await resolveChangedEntityFacts(uid, changes, { storage });
  return new Map(changes.map((change) => [change.entityId, facts.get(change.changeId) ?? null] as const));
}

function sync(storage: StorageAdapter, blocks: readonly BusyBlock[], sourceId = SOURCE, uid = UID) {
  return replaceBusyBlocks(uid, sourceId, WINDOW, blocks, { storage, now: new Date(at('05:00')) });
}

const MEETING = block('evt-meeting', at('06:00'), at('06:30'));
const MOVED = block('evt-meeting', at('09:00'), at('09:30'));
const LUNCH = block('evt-lunch', at('10:00'), at('11:00'));

/* ══ replaceBusyBlocks: what a sync announces ══════════════════════ */

test('a new meeting is one calendar row that resolves to its interval', async () => {
  const storage = createMemoryStorage();
  await liveAccount(storage);
  await sync(storage, [MEETING]);

  const written = await rows(storage);
  assert.equal(written.length, 1);
  const [row] = written;
  assert.equal(row!.source, 'calendar');
  assert.equal(row!.scopeId, UID);
  assert.equal(row!.entityId, MEETING.blockId);
  assert.ok(row!.changeId.startsWith(BUSY_CHANGE_ID_PREFIX));
  assert.equal(row!.beforeDigest, null, 'nothing stood there before');
  assert.deepEqual(row!.changedFields, ['interval', 'blocking']);
  assert.deepEqual((await resolved(storage, written)).get(MEETING.blockId), {
    interval: { startsAt: MEETING.startAt, endsAt: MEETING.endAt },
    blocking: true,
  });
});

test('a moved meeting is two rows: the old id resolves as deleted, the new id as its new interval', async () => {
  const storage = createMemoryStorage();
  await liveAccount(storage);
  await sync(storage, [MEETING, LUNCH]);
  await drain(storage);

  await sync(storage, [MOVED, LUNCH]);
  const written = await rows(storage);
  assert.deepEqual(written.map((row) => row.entityId).sort(), [MEETING.blockId, MOVED.blockId].sort(),
    'one row per id, and none for the lunch that did not move');
  assert.notEqual(written[0]!.changeId, written[1]!.changeId);
  const facts = await resolved(storage, written);
  assert.deepEqual(facts.get(MEETING.blockId), { interval: null, blocking: false }, 'the old time is free');
  assert.deepEqual(facts.get(MOVED.blockId), { interval: { startsAt: MOVED.startAt, endsAt: MOVED.endAt }, blocking: true });
  const removal = written.find((row) => row.entityId === MEETING.blockId)!;
  assert.notEqual(removal.beforeDigest, null);
  assert.notEqual(removal.beforeDigest, removal.afterDigest);
});

test('a removed meeting is one row that resolves as deleted', async () => {
  const storage = createMemoryStorage();
  await liveAccount(storage);
  await sync(storage, [MEETING, LUNCH]);
  await drain(storage);

  await sync(storage, [LUNCH]);
  const written = await rows(storage);
  assert.deepEqual(written.map((row) => row.entityId), [MEETING.blockId]);
  assert.deepEqual((await resolved(storage, written)).get(MEETING.blockId), { interval: null, blocking: false });
});

test('a meeting whose end moves keeps its id and is one row', async () => {
  const storage = createMemoryStorage();
  await liveAccount(storage);
  await sync(storage, [MEETING]);
  await drain(storage);

  const longer = { ...MEETING, endAt: at('07:00') };
  await sync(storage, [longer]);
  const written = await rows(storage);
  assert.deepEqual(written.map((row) => [row.entityId, row.changedFields]), [[MEETING.blockId, ['interval']]]);
  assert.deepEqual((await resolved(storage, written)).get(MEETING.blockId)?.interval, { startsAt: MEETING.startAt, endsAt: at('07:00') });
});

test('a re-sync of an identical calendar writes no row, even at the upload limit', async () => {
  const storage = createMemoryStorage();
  await liveAccount(storage);
  const month = Array.from({ length: 1000 }, (_, index) => {
    const start = Date.parse(WINDOW.startsAt) + index * 30 * 60_000;
    return block(`evt-${index}`, new Date(start).toISOString(), new Date(start + 20 * 60_000).toISOString());
  });
  await sync(storage, month);
  assert.equal((await drain(storage)).length, 1000, 'the first sync announces every block once');

  await sync(storage, month);
  await sync(storage, [...month].reverse());
  assert.deepEqual(await rows(storage), [], 'an unchanged calendar announces nothing');
  assert.equal((await storage.list(userCol(UID, BUSY_BLOCKS))).length, 1000);
});

test('an all-day entry changes no plan and writes no row; turning it into a timed event does', async () => {
  const storage = createMemoryStorage();
  await liveAccount(storage);
  const holiday = block('evt-holiday', at('00:00'), at('00:00', '2026-09-16'), { allDay: true });
  await sync(storage, [holiday]);
  assert.deepEqual(await rows(storage), [], 'the planner does not read an all-day entry, so nothing it reads moved');
  assert.equal((await storage.list(userCol(UID, BUSY_BLOCKS))).length, 1, 'it is still stored, for the conflict hint');

  await sync(storage, [{ ...holiday, allDay: false }]);
  const written = await rows(storage);
  assert.deepEqual(written.map((row) => [row.entityId, row.changedFields, row.beforeDigest === null]), [
    [holiday.blockId, ['interval', 'blocking'], false],
  ]);
});

test('a row carries exactly the contract\'s keys, and no source id or title', async () => {
  const storage = createMemoryStorage();
  await liveAccount(storage);
  await sync(storage, [{ ...MEETING, title: 'Oncology, Dr Haddad' } as BusyBlock]);
  const [row] = await rows(storage);
  assert.deepEqual(Object.keys(row!).sort(), [
    'afterDigest', 'beforeDigest', 'changeId', 'changedFields', 'entityId', 'occurredAt', 'provenanceRef', 'schemaVersion', 'scopeId', 'source',
  ]);
  const text = JSON.stringify(row);
  assert.doesNotMatch(text, /Oncology|Haddad/);
  assert.ok(!text.includes(SOURCE) && !text.includes(SOURCE.slice('device:'.length)), `the source id leaked: ${text}`);
});

test('no row is written for an account that is gone or being deleted', async () => {
  const storage = createMemoryStorage();
  await sync(storage, [MEETING]);
  assert.deepEqual(await rows(storage), [], 'no account document: nothing a tick could ever read');

  await storage.set(userDoc(UID), { trust: { deletedAt: at('04:00') } });
  await sync(storage, [MOVED]);
  await deleteBusySource(UID, SOURCE, { storage });
  assert.deepEqual(await rows(storage), [], 'a row would be a document written into a tree deletion is removing');
  assert.equal((await storage.list(userCol(UID, BUSY_BLOCKS))).length, 0);
});

test('disconnecting a source announces each timed block it removes', async () => {
  const storage = createMemoryStorage();
  await liveAccount(storage);
  await sync(storage, [MEETING, LUNCH]);
  await drain(storage);

  assert.deepEqual(await deleteBusySource(UID, SOURCE, { storage }), { deleted: 2 });
  const written = await rows(storage);
  assert.deepEqual(written.map((row) => row.entityId).sort(), [MEETING.blockId, LUNCH.blockId].sort());
  const facts = await resolved(storage, written);
  assert.ok(Array.from(facts.values()).every((fact) => fact?.interval === null));
});

/* ══ Mid-sync: a row is never ahead of its block ═══════════════════ */

/**
 * A storage that stops after every write the sync makes and lets the test look
 * at what a concurrent reader would see at that instant.
 */
function pausingAfterEachWrite(raw: MemoryStorageAdapter, at: () => Promise<void>): StorageAdapter {
  return {
    get: (path) => raw.get(path),
    list: (path, options) => raw.list(path, options),
    listGroup: (id, options) => raw.listGroup(id, options),
    deleteTree: (path) => raw.deleteTree(path),
    async set(path, value) { await raw.set(path, value); await at(); },
    async delete(path) { await raw.delete(path); await at(); },
    async runTransaction(fn) { const result = await raw.runTransaction(fn); await at(); return result; },
  };
}

/*
 * 250 meetings, every one moved a quarter of an hour: 250 new ids and 250 old
 * ones, more than one commit's worth, so the sync has instants in between.
 * At each of them:
 *  - every meeting is at its old time or its new time, never at neither — a
 *    tick in between may read the day as busier than it is, never as freer;
 *  - every row a tick can already see names a block in its final state, so a
 *    new meeting's row never resolves as a deletion.
 */
test('mid-sync, no meeting is missing and every visible row already resolves to its final state', async () => {
  const raw = createMemoryStorage();
  await liveAccount(raw);
  const COUNT = 250;
  const before = Array.from({ length: COUNT }, (_, index) => {
    const start = Date.parse(WINDOW.startsAt) + index * 60 * 60_000;
    return block(`evt-${index}`, new Date(start).toISOString(), new Date(start + 30 * 60_000).toISOString());
  });
  const after = before.map((old, index) => block(
    `evt-${index}`,
    new Date(Date.parse(old.startAt) + 15 * 60_000).toISOString(),
    new Date(Date.parse(old.endAt) + 15 * 60_000).toISOString(),
  ));
  await sync(raw, before);
  await drain(raw);

  const finalFacts = new Map<string, { startsAt: string; endsAt: string } | null>([
    ...before.map((old) => [old.blockId, null] as const),
    ...after.map((next) => [next.blockId, { startsAt: next.startAt, endsAt: next.endAt }] as const),
  ]);
  let instants = 0;
  const check = async () => {
    instants += 1;
    const stored = new Set((await raw.list<BusyBlock>(userCol(UID, BUSY_BLOCKS))).map((row) => row.data.blockId));
    const missing = before.filter((old, index) => !stored.has(old.blockId) && !stored.has(after[index]!.blockId));
    assert.deepEqual(missing.map((old) => old.startAt), [], `instant ${instants}: meetings at neither time`);
    const visible = await rows(raw);
    const facts = await resolved(raw, visible);
    for (const row of visible) {
      assert.deepEqual(facts.get(row.entityId)?.interval ?? null, finalFacts.get(row.entityId),
        `instant ${instants}: a row is visible before its block reached the state it announces`);
    }
  };
  await replaceBusyBlocks(UID, SOURCE, WINDOW, after, { storage: pausingAfterEachWrite(raw, check), now: new Date(at('05:00')) });

  assert.ok(instants >= 3, `the sync must have had instants in between to look at, had ${instants}`);
  const written = await rows(raw);
  assert.equal(written.length, 2 * COUNT, 'each moved meeting is two rows');
});

test('a sync interrupted halfway loses no row: the next identical sync announces what the first did not reach', async () => {
  const raw = createMemoryStorage();
  await liveAccount(raw);
  const blocks = Array.from({ length: 450 }, (_, index) => {
    const start = Date.parse(WINDOW.startsAt) + index * 60 * 60_000;
    return block(`evt-${index}`, new Date(start).toISOString(), new Date(start + 30 * 60_000).toISOString());
  });
  let commits = 0;
  const crashing: StorageAdapter = {
    ...pausingAfterEachWrite(raw, async () => undefined),
    async runTransaction(fn) {
      if (commits === 1) throw new Error('the instance died');
      const result = await raw.runTransaction(fn);
      commits += 1;
      return result;
    },
  };
  await assert.rejects(replaceBusyBlocks(UID, SOURCE, WINDOW, blocks, { storage: crashing, now: new Date(at('05:00')) }), /died/);
  const firstHalf = await rows(raw);
  const storedAfterCrash = (await raw.list<BusyBlock>(userCol(UID, BUSY_BLOCKS))).map((row) => row.data.blockId);
  assert.deepEqual(firstHalf.map((row) => row.entityId).sort(), storedAfterCrash.sort(),
    'what committed carries its rows, and nothing else does');
  assert.ok(storedAfterCrash.length > 0 && storedAfterCrash.length < blocks.length);

  await sync(raw, blocks);
  const all = await rows(raw);
  assert.deepEqual(new Set(all.map((row) => row.entityId)), new Set(blocks.map((b) => b.blockId)),
    'every block is announced exactly once across the two syncs');
  assert.equal(all.length, blocks.length);
});

/* ══ Per writer ═════════════════════════════════════════════════════ */

let auth: FakeAuthControls | null = null;

async function withRoutes(fn: (storage: MemoryStorageAdapter) => Promise<void>): Promise<void> {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  auth = installFakeAuth();
  try {
    await fn(storage);
  } finally {
    auth?.restore();
    auth = null;
    resetStorageForTests();
  }
}

const USER = uidFor('BusyRowsUser');

async function withConsent(uid = USER): Promise<void> {
  await applyTrustAction(uid, { type: 'record_first_value', at: at('04:00') });
  await applyTrustAction(uid, { type: 'set_calendar_consent', granted: true, at: at('04:00') });
}

function deviceUpload(blocks: readonly BusyBlock[]) {
  return new Request(`${BASE}/api/mobile/calendar/busy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authorization: `Bearer ${tokenFor(USER)}` },
    body: JSON.stringify({
      sourceId: SOURCE,
      platform: 'ios',
      windowStart: WINDOW.startsAt,
      windowEnd: WINDOW.endsAt,
      blocks: blocks.map((entry) => ({ blockId: entry.blockId, startAt: entry.startAt, endAt: entry.endAt, allDay: entry.allDay })),
    }),
  });
}

test('writer: the device busy route announces an add, a move (two rows), a removal, and nothing for a re-sync', async () => {
  await withRoutes(async (storage) => {
    await withConsent();
    assert.equal((await busyPost(deviceUpload([MEETING, LUNCH]))).status, 200);
    assert.deepEqual((await drain(storage, USER)).map((row) => row.entityId).sort(), [MEETING.blockId, LUNCH.blockId].sort());

    assert.equal((await busyPost(deviceUpload([MEETING, LUNCH]))).status, 200);
    assert.deepEqual(await drain(storage, USER), [], 'an identical upload announces nothing');

    assert.equal((await busyPost(deviceUpload([MOVED, LUNCH]))).status, 200);
    const moved = await drain(storage, USER);
    assert.deepEqual(moved.map((row) => row.entityId).sort(), [MEETING.blockId, MOVED.blockId].sort());
    assert.ok(moved.every((row) => row.source === 'calendar' && row.scopeId === USER));

    assert.equal((await busyPost(deviceUpload([MOVED]))).status, 200);
    assert.deepEqual((await drain(storage, USER)).map((row) => row.entityId), [LUNCH.blockId]);
  });
});

test('writer: the device disconnect route announces every block it deletes', async () => {
  await withRoutes(async (storage) => {
    await withConsent();
    await busyPost(deviceUpload([MEETING, LUNCH]));
    await drain(storage, USER);
    const response = await busyDelete(new Request(`${BASE}/api/mobile/calendar/busy?sourceId=${encodeURIComponent(SOURCE)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${tokenFor(USER)}` },
    }));
    assert.equal(response.status, 200);
    const written = await drain(storage, USER);
    assert.deepEqual(written.map((row) => row.entityId).sort(), [MEETING.blockId, LUNCH.blockId].sort());
    const facts = await resolved(storage, written, USER);
    assert.ok(Array.from(facts.values()).every((fact) => fact?.interval === null));
  });
});

const SESSION = { weekday: 2, start: '10:00', end: '12:00', label: 'Lecture' };

test('writer: accepted lecture sessions (#191) announce their blocks once, a changed session as a move, and a re-accept as nothing', async () => {
  const storage = createMemoryStorage();
  await liveAccount(storage);
  const options = { storage, timezone: 'Asia/Jerusalem', referenceTime: '2026-09-01T09:00:00.000Z', now: new Date('2026-09-01T09:00:00.000Z') };

  const first = await acceptLectureSessionsAsBusyBlocks(UID, 'prop-1', [SESSION], options);
  assert.equal(first.written, 16);
  const announced = await drain(storage);
  assert.equal(announced.length, 16);
  assert.ok(announced.every((row) => row.source === 'calendar'));

  await acceptLectureSessionsAsBusyBlocks(UID, 'prop-1', [SESSION], options);
  assert.deepEqual(await drain(storage), [], 're-accepting the same sessions announces nothing');

  await acceptLectureSessionsAsBusyBlocks(UID, 'prop-1', [{ ...SESSION, start: '11:00', end: '13:00' }], options);
  const moved = await drain(storage);
  assert.equal(moved.length, 32, 'sixteen lectures moved: sixteen old ids freed and sixteen new ones taken');
  const facts = await resolved(storage, moved);
  assert.equal(Array.from(facts.values()).filter((fact) => fact?.interval === null).length, 16);
  assert.equal(Array.from(facts.values()).filter((fact) => fact?.blocking === true).length, 16);
});

test('writer: the manual busy route announces what it stores and what its delete removes', async () => {
  await withRoutes(async (storage) => {
    await storage.set(userDoc(USER), { timezone: 'Asia/Jerusalem' });
    const proposalId = 'prop-route';
    const posted = await manualPost(new Request(`${BASE}/api/mobile/calendar/manual`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenFor(USER)}` },
      body: JSON.stringify({ proposalId, sessions: [SESSION], timezone: 'Asia/Jerusalem', referenceTime: '2026-09-01T09:00:00.000Z' }),
    }));
    assert.equal(posted.status, 200);
    const stored = (await storage.list<BusyBlock>(userCol(USER, BUSY_BLOCKS))).map((row) => row.data.blockId).sort();
    assert.equal(stored.length, 16);
    assert.deepEqual((await drain(storage, USER)).map((row) => row.entityId).sort(), stored);

    const deleted = await manualDelete(new Request(`${BASE}/api/mobile/calendar/manual?proposalId=${proposalId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${tokenFor(USER)}` },
    }));
    assert.equal(deleted.status, 200);
    assert.deepEqual((await drain(storage, USER)).map((row) => row.entityId).sort(), stored);
    assert.equal(manualBusySourceId(proposalId), `manual-${proposalId}`);
  });
});

/* ══ The census: every busy-block writer ═══════════════════════════ */

/**
 * Every call of a busy-block writer in production code, and the test that
 * proves its rows. A new caller fails this test until it is listed here with
 * a test of its own; a module that writes the collection by any other route
 * fails the checks below it.
 *
 * Football fixtures are not here on purpose: they land as `scheduled_event`
 * commitments (`lib/football/projectFixtures.ts`), not as busy blocks, and the
 * scan below would list them the day they started writing one. Account
 * deletion removes the whole tree, rows included, and announces nothing: there
 * is no plan left to replan.
 */
const WRITERS: ReadonlyArray<readonly [file: string, inside: string, callee: string, provedBy: string]> = [
  ['lib/calendar/icsFeeds.ts', 'applyClassification', 'replaceBusyBlocks', 'icsFeedLifecycle: #611 subscribe/refresh rows'],
  ['lib/calendar/icsFeeds.ts', 'removeFeedData', 'deleteBusySource', 'icsFeedLifecycle: #611 unsubscribe rows'],
  ['lib/calendar/manualBusy.ts', 'acceptLectureSessionsAsBusyBlocks', 'replaceBusyBlocks', 'writer: accepted lecture sessions (#191)'],
  ['src/app/api/mobile/calendar/busy/route.ts', 'DELETE', 'deleteBusySource', 'writer: the device disconnect route'],
  ['src/app/api/mobile/calendar/busy/route.ts', 'POST', 'replaceBusyBlocks', 'writer: the device busy route'],
  ['src/app/api/mobile/calendar/manual/route.ts', 'DELETE', 'deleteBusySource', 'writer: the manual busy route'],
];

interface Source { readonly file: string; readonly tree: ts.SourceFile }

function productionSources(): Source[] {
  const found: Source[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const relative = join(dir, entry.name);
      if (entry.isDirectory()) walk(relative);
      else if (/\.tsx?$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
        const text = readFileSync(join(ROOT, relative), 'utf8');
        found.push({ file: relative, tree: ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true, relative.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS) });
      }
    }
  };
  walk('lib');
  walk('src');
  return found;
}

/** Each node, with the name of the function declaration (or exported const) it sits in. */
function visitNamed(source: Source, visit: (node: ts.Node, inside: string | null) => void): void {
  const step = (node: ts.Node, inside: string | null): void => {
    const name = ts.isFunctionDeclaration(node) && node.name
      ? node.name.text
      : ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
        && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
        ? node.name.text
        : inside;
    visit(node, name);
    ts.forEachChild(node, (child) => step(child, name));
  };
  step(source.tree, null);
}

const WRITER_FUNCTIONS = new Set(['replaceBusyBlocks', 'deleteBusySource']);
const BUSY_MODULE = join('lib', 'calendar', 'busyBlocks.ts');

test('census: every production caller of a busy-block writer is listed, with the test that proves its rows', () => {
  const calls: string[][] = [];
  for (const source of productionSources()) {
    if (source.file === BUSY_MODULE) continue;
    visitNamed(source, (node, inside) => {
      // A call, or a writer passed along as a value (`const write = replaceBusyBlocks`).
      if (ts.isIdentifier(node) && WRITER_FUNCTIONS.has(node.text)
        && !ts.isImportSpecifier(node.parent) && !ts.isExportSpecifier(node.parent)) {
        calls.push([source.file, inside ?? '<module>', node.text]);
      }
    });
  }
  assert.deepEqual(
    calls.sort(),
    WRITERS.map(([file, inside, callee]) => [join(...file.split('/')), inside, callee]).sort(),
    'a busy-block writer was added or moved: give it a row test and list it in WRITERS',
  );
});

test('census: nothing outside busyBlocks.ts names the busy-blocks collection', () => {
  const offenders: string[] = [];
  for (const source of productionSources()) {
    if (source.file === BUSY_MODULE || source.file === join('lib', 'storage', 'paths.ts')) continue;
    visitNamed(source, (node) => {
      if (ts.isIdentifier(node) && node.text === 'BUSY_BLOCKS') offenders.push(`${source.file}: BUSY_BLOCKS`);
      if (!node.parent) return;
      const moduleName = ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)
        || (ts.isCallExpression(node.parent) && node.parent.expression.kind === ts.SyntaxKind.ImportKeyword);
      if (ts.isStringLiteralLike(node) && !moduleName && /(^|\/)busyBlocks(\/|$)/.test(node.text)) {
        offenders.push(`${source.file}: '${node.text}'`);
      }
    });
  }
  assert.deepEqual(offenders, [], 'busy blocks are written only through replaceBusyBlocks / deleteBusySource, which announce them');
});

test('census: inside busyBlocks.ts, a block path is written only by the function that writes its row in the same commit', () => {
  const [source] = productionSources().filter((entry) => entry.file === BUSY_MODULE);
  assert.ok(source);
  const pathUsers = new Set<string>();
  const collectionUsers = new Set<string>();
  const committers = new Set<string>();
  visitNamed(source, (node, inside) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === 'blockPath') pathUsers.add(inside ?? '<module>');
      if (node.expression.text === 'commitTransitions') committers.add(inside ?? '<module>');
    }
    if (ts.isIdentifier(node) && node.text === 'BUSY_BLOCKS' && !ts.isImportSpecifier(node.parent) && !ts.isExportSpecifier(node.parent)) {
      collectionUsers.add(inside ?? '<module>');
    }
  });
  assert.deepEqual(Array.from(pathUsers).sort(), ['commitTransitions'], 'a block document is reached only inside commitTransitions');
  assert.deepEqual(Array.from(collectionUsers).sort(), ['allBlocks', 'blockPath'], 'the collection is otherwise only listed, never written');
  assert.deepEqual(Array.from(committers).sort(), ['deleteBusySource', 'replaceBusyBlocks']);
});
