/**
 * M6a-1 Gate B — R54.1 `POST /api/mobile/commitments/search` (D54-1, R5-001)
 * with the binding dispositions M6A-010, R2-011, R2-012, R3-009, R4-005,
 * R5-001, R5-002.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import {
  REFERENCE, addAt, addCommitment, at, begin, end, idsOf, loadModule, minusDays, minusMs, postpone, search, searchOk, settleAt, show,
} from './support.ts';

afterEach(() => end());

const DAY = 24 * 60 * 60_000;
const fixtures = JSON.parse(readFileSync(new URL('../../../mobile/src/text/foldForSearch.fixtures.json', import.meta.url), 'utf8')) as {
  fold: [string, string][];
  wordPrefix: [string, string, boolean][];
  emptyAfterFold: string[];
};

/* ── the shared folding (one fixture file, read by both suites) ─────── */

test('R54.1 foldForSearch folds every fixture pair exactly (server copy)', async () => {
  const { foldForSearch } = await loadModule('src/text/foldForSearch.ts') as { foldForSearch: (s: string) => string };
  for (const [input, folded] of fixtures.fold) assert.equal(foldForSearch(input), folded, `fold(${input})`);
});

test('M6A-R4-005 isWordPrefixMatch: a match starts at 0 or after a non-letter/digit (Arabic comma, Hebrew maqaf, Latin punctuation)', async () => {
  const mod = await loadModule('src/text/foldForSearch.ts') as { foldForSearch: (s: string) => string; isWordPrefixMatch: (h: string, n: string) => boolean };
  for (const [haystack, needle, expected] of fixtures.wordPrefix) {
    assert.equal(mod.isWordPrefixMatch(mod.foldForSearch(haystack), mod.foldForSearch(needle)), expected, `${haystack} ⟵ ${needle}`);
  }
});

test('R54.1 the app copy of foldForSearch is byte-identical to the server copy', () => {
  const server = readFileSync(new URL('../../../src/text/foldForSearch.ts', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../../../mobile/src/text/foldForSearch.ts', import.meta.url), 'utf8');
  assert.equal(app, server);
});

/* ── matching ───────────────────────────────────────────────────────── */

test('R54.1 folding on both sides: «احمد» finds «أحمد», «مدرسه» finds «مدرسة», «3» finds «٣»', async () => {
  const uid = await begin();
  const hamza = await addCommitment(uid, 'اتصل بأحمد', { kind: 'due_by', dueAt: at('2026-10-08', '12:00') });
  const taa = await addCommitment(uid, 'اجتماع المدرسة', { kind: 'due_by', dueAt: at('2026-10-09', '12:00') });
  const digit = await addCommitment(uid, 'غرفة ٣', { kind: 'due_by', dueAt: at('2026-10-10', '12:00') });
  assert.deepEqual(idsOf(await searchOk(uid, 'احمد')), [hamza]);
  assert.deepEqual(idsOf(await searchOk(uid, 'مدرسه')), [taa]);
  assert.deepEqual(idsOf(await searchOk(uid, '3')), [digit]);
});

test('D54-1 done and dropped items within 90 days are found, with their status', async () => {
  const uid = await begin();
  const done = await addAt(uid, minusDays(REFERENCE, 30), 'Dentist visit', { kind: 'due_by', dueAt: minusDays(REFERENCE, 29) });
  await settleAt(uid, done, 'Complete', minusDays(REFERENCE, 29));
  const dropped = await addAt(uid, minusDays(REFERENCE, 20), 'Dentist call', { kind: 'due_by', dueAt: minusDays(REFERENCE, 19) });
  await settleAt(uid, dropped, 'Drop', minusDays(REFERENCE, 19));
  const body = await searchOk(uid, 'dentist');
  const byId = new Map((body.items as any[]).map((item) => [item.id, item]));
  assert.ok(byId.has(done), show(body));
  assert.ok(byId.has(dropped), show(body));
  assert.equal(byId.get(done).status, 'completed'); // GB-M6-AMEND-1: the commitment DTO's own status vocabulary
  assert.equal(byId.get(dropped).status, 'dropped');
});

test('M6A-R2-012 / M6A-010 the 90-day cutoff applies to settled items only, by completedAt/droppedAt (89d23h in, 90d+1m out)', async () => {
  const uid = await begin();
  const inside = await addAt(uid, minusDays(REFERENCE, 100), 'Passport inside', { kind: 'due_by', dueAt: minusDays(REFERENCE, 95) });
  await settleAt(uid, inside, 'Complete', minusMs(REFERENCE, 90 * DAY - 60 * 60_000));
  const outside = await addAt(uid, minusDays(REFERENCE, 100), 'Passport outside', { kind: 'due_by', dueAt: minusDays(REFERENCE, 95) });
  await settleAt(uid, outside, 'Drop', minusMs(REFERENCE, 90 * DAY + 60_000));
  const ids = idsOf(await searchOk(uid, 'passport'));
  assert.ok(ids.includes(inside), 'completed 89d23h ago is missing');
  assert.ok(!ids.includes(outside), 'dropped 90d+1m ago was returned');
});

test('M6A-R2-012 live items match regardless of age: an old undated live item and an old overdue live item are included', async () => {
  const uid = await begin();
  const undated = await addAt(uid, minusDays(REFERENCE, 200), 'Renew licence someday', { kind: 'due_by', dueAt: null, allDay: false });
  const overdue = await addAt(uid, minusDays(REFERENCE, 200), 'Renew licence overdue', { kind: 'due_by', dueAt: minusDays(REFERENCE, 150) });
  const ids = idsOf(await searchOk(uid, 'renew'));
  assert.ok(ids.includes(undated), 'old undated live item missing');
  assert.ok(ids.includes(overdue), 'old overdue live item missing');
});

test('M6A-010 a live item postponed into the future from an old due date ranks by its resolved (postponed) time', async () => {
  const uid = await begin();
  const old = await addAt(uid, minusDays(REFERENCE, 120), 'Gym plan A', { kind: 'due_by', dueAt: minusDays(REFERENCE, 110) });
  await postpone(uid, old, at('2026-10-08', '09:00'));
  const later = await addCommitment(uid, 'Gym plan B', { kind: 'due_by', dueAt: at('2026-10-20', '09:00') });
  assert.deepEqual(idsOf(await searchOk(uid, 'gym')).slice(0, 2), [old, later], 'the postponed item (tomorrow) must rank before one due on the 20th');
});

/* ── ranking ────────────────────────────────────────────────────────── */

test('R54.1 ranking: word-prefix matches before substrings; inside each, live/future first by nearest time, then most recently settled', async () => {
  const uid = await begin();
  const substring = await addCommitment(uid, 'Accident report', { kind: 'due_by', dueAt: at('2026-10-08', '09:00') }); // "dent" inside a word → substring tier
  const prefixFar = await addCommitment(uid, 'Dentist far', { kind: 'due_by', dueAt: at('2026-10-30', '09:00') });
  const prefixNear = await addCommitment(uid, 'Dentist near', { kind: 'due_by', dueAt: at('2026-10-09', '09:00') });
  const prefixDone = await addAt(uid, minusDays(REFERENCE, 10), 'Dentist done', { kind: 'due_by', dueAt: minusDays(REFERENCE, 9) });
  await settleAt(uid, prefixDone, 'Complete', minusDays(REFERENCE, 9));
  const ids = idsOf(await searchOk(uid, 'dent'));
  assert.deepEqual(ids, [prefixNear, prefixFar, prefixDone, substring]);
});

/* ── bounds ─────────────────────────────────────────────────────────── */

test('M6A-R3-009 limit: an integer 1–50; anything else is 400 invalid_limit; absent means 30', async () => {
  const uid = await begin();
  for (let i = 0; i < 40; i += 1) await addCommitment(uid, `Errand ${i}`, { kind: 'due_by', dueAt: at('2026-10-12', '09:00') });
  for (const bad of [-1, 0, 1.5, 51, 'NaN', '10', '', null, [5]]) {
    const result = await search(uid, { q: 'errand', limit: bad });
    assert.equal(result.status, 400, `limit=${JSON.stringify(bad)}: ${show(result.body)}`);
    assert.equal(result.body.reason ?? result.body.error, 'invalid_limit');
  }
  const defaulted = await searchOk(uid, 'errand');
  assert.equal(defaulted.items.length, 30);
  assert.equal(defaulted.truncated, true);
  const fifty = await searchOk(uid, 'errand', 50);
  assert.equal(fifty.items.length, 40);
  assert.equal(fifty.truncated, false);
});

test('M6A-R5-001 search is POST only: there is no GET handler (nothing typed rides in a URL)', async () => {
  const module = await loadModule('src/app/api/mobile/commitments/search/route.ts');
  assert.equal(typeof module.POST, 'function');
  assert.equal(module.GET, undefined);
});

test('M6A-R5-002 raw q is capped before folding: 5000 tatweel + a letter, 500 combining marks + a letter, and NFKC expansion over the cap are 400 invalid_query', async () => {
  const uid = await begin();
  await addCommitment(uid, 'ب', { kind: 'due_by', dueAt: at('2026-10-12', '09:00') });
  for (const q of ['\u0640'.repeat(5000) + 'ب', '\u064B'.repeat(500) + 'ب', 'a'.repeat(201)]) {
    const result = await search(uid, { q });
    assert.equal(result.status, 400, `raw length ${q.length}`);
    assert.equal(result.body.reason ?? result.body.error, 'invalid_query');
  }
  const expanded = await search(uid, { q: '\uFDFA'.repeat(10) });
  assert.equal(expanded.status, 400, 'ten ligatures expand to 180 letters under NFKC: within the raw cap but over the folded 80');
});

test('M6A-R2-011 q is validated after folding: tatweel-only, niqqud-only and harakat-only queries are 400 invalid_query, never "match everything"', async () => {
  const uid = await begin();
  await addCommitment(uid, 'anything', { kind: 'due_by', dueAt: at('2026-10-12', '09:00') });
  for (const q of fixtures.emptyAfterFold) {
    const result = await search(uid, { q });
    assert.equal(result.status, 400, `q=${JSON.stringify(q)}: ${show(result.body)}`);
    assert.equal(result.body.reason ?? result.body.error, 'invalid_query');
  }
  for (const q of ['', '   ', 'x'.repeat(81), 42, null]) {
    const result = await search(uid, { q });
    assert.equal(result.status, 400, `q ${JSON.stringify(q)}`);
  }
});

test('R54.1 a query full of regex metacharacters is matched literally (no regex built from q)', async () => {
  const uid = await begin();
  const literal = await addCommitment(uid, 'Pay (a+b)* invoice', { kind: 'due_by', dueAt: at('2026-10-12', '09:00') });
  await addCommitment(uid, 'Pay aab invoice', { kind: 'due_by', dueAt: at('2026-10-12', '09:00') });
  assert.deepEqual(idsOf(await searchOk(uid, '(a+b)*')), [literal]);
});

test('R54.1 account isolation: B never sees A\'s commitments', async () => {
  const a = await begin();
  await addCommitment(a, 'Secret dentist', { kind: 'due_by', dueAt: at('2026-10-12', '09:00') });
  const b = 'm6-account-b';
  const result = await search(b, { q: 'dentist' });
  assert.equal(result.status, 200, show(result.body));
  assert.deepEqual(result.body.items, []);
});

/* ── release ────────────────────────────────────────────────────────── */

test('R54.1 off, killed, or production: 404 feature_unavailable and nothing read', async () => {
  for (const switches of [{ on: false }, { killed: true }, { on: null }, { environment: 'production' }] as const) {
    const uid = await begin(switches as any);
    const result = await search(uid, { q: 'x1' });
    assert.equal(result.status, 404, `${JSON.stringify(switches)}: ${show(result.body)}`);
    end();
  }
});
