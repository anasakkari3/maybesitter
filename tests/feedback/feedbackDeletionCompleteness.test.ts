/**
 * Deletion completeness for the feedback event log (Sprint 03, issue #13).
 *
 * A scope deletion must leave no file holding that user's behaviour, including
 * files a crash left unreadable or unrenamed, and must reach the migration
 * baseline as well — those counters are the user's history too.
 *
 * Modelled on tests/runtimeMemory/deletionCompleteness.test.ts, where this
 * exact class of gap was found twice for real. Each test asserts on the
 * filesystem rather than on the store's own API, because the failure mode is
 * precisely a file the store can no longer see.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FEEDBACK_EVENT_SCHEMA_VERSION,
  type AppendFeedbackEventInput,
  type FeedbackBaseline,
} from '../../src/contracts/v1/feedbackContracts.ts';
import { createFileFeedbackEventStore } from '../../lib/feedback/feedbackEventStore.ts';

const OCCURRED = '2026-08-18T09:00:00.000Z';
const RECORDED = '2026-08-18T09:00:03.000Z';

function input(overrides: Partial<AppendFeedbackEventInput> = {}): AppendFeedbackEventInput {
  return {
    scopeId: 'alice',
    outcome: 'complete',
    subjectId: 'commitment-1',
    actor: 'user',
    source: 'mobile_action',
    occurredAt: OCCURRED,
    ...overrides,
  };
}

function baseline(scopeId: string): FeedbackBaseline {
  return {
    version: FEEDBACK_EVENT_SCHEMA_VERSION,
    scopeId,
    counters: {
      ignoredSuggestions: 3, completedActions: 7, delayedActions: 2,
      clarificationSuccesses: 5, clarificationFailures: 1,
    },
    lastUpdatedAt: '2026-08-10T20:00:00.000Z',
    timestampsUnavailable: true,
    migratedAt: RECORDED,
  };
}

test('SECURITY: path traversal cannot read, revoke or delete outside the store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feedback-sec-'));
  const victim = join(dir, 'victim.txt');
  writeFileSync(victim, 'SENSITIVE');
  const store = createFileFeedbackEventStore({ dataDir: join(dir, 'store') });

  for (const evil of ['../victim', '../../etc/passwd', 'fbk_../../victim', '/etc/passwd', 'fbk_a/../../victim']) {
    assert.equal(store.get(evil), null, `get(${evil}) must not resolve`);
    assert.equal(store.revoke(evil, RECORDED), false, `revoke(${evil}) must not resolve`);
  }
  // A scopeId is caller text too, and it names the baseline file. Hashing it
  // keeps it inside the store; nothing above the directory may be touched.
  store.writeBaseline(baseline('../../victim'));
  assert.equal(store.deleteScope('../../victim'), 0);

  assert.equal(readFileSync(victim, 'utf8'), 'SENSITIVE', 'victim file must survive unchanged');
  rmSync(dir, { recursive: true, force: true });
});

test('SECURITY: deleteScope removes files even when their JSON is unreadable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feedback-sec2-'));
  const dataDir = join(dir, 'store');
  const store = createFileFeedbackEventStore({ dataDir });
  const event = store.append(input(), RECORDED);
  // Corrupt it in place, as a mid-crash write would.
  writeFileSync(join(dataDir, `${event.id}.feedback.json`), '{"scopeId":"alice","subjectId":"SECRET",');

  store.deleteScope('alice');
  assert.deepEqual(readdirSync(dataDir), [], 'no file holding alice content may survive deleteScope');
  rmSync(dir, { recursive: true, force: true });
});

test('SECURITY: an orphaned temp file from a crashed write is also deleted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feedback-sec3-'));
  const dataDir = join(dir, 'store');
  const store = createFileFeedbackEventStore({ dataDir });
  store.append(input({ scopeId: 'bob' }), RECORDED);
  // Simulate a crash between writeFileSync and renameSync. Nothing else can
  // reach this file afterwards: readAll() skips .tmp, so list() never sees it.
  writeFileSync(
    join(dataDir, 'fbk_orphan.feedback.json.999.tmp'),
    JSON.stringify({ scopeId: 'bob', subjectId: 'LEAKED SECRET' }),
  );

  store.deleteScope('bob');
  assert.deepEqual(readdirSync(dataDir), [], 'a crashed temp write must not survive deletion');
  rmSync(dir, { recursive: true, force: true });
});

test('SECURITY: deleteScope removes the migration baseline, not only the events', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feedback-sec4-'));
  const dataDir = join(dir, 'store');
  const store = createFileFeedbackEventStore({ dataDir });
  store.append(input({ scopeId: 'dana' }), RECORDED);
  store.writeBaseline(baseline('dana'));
  // A crash mid-baseline-write leaves this, and it holds the same counters.
  writeFileSync(
    join(dataDir, 'bsl_orphan.feedback-baseline.json.777.tmp'),
    JSON.stringify(baseline('dana')),
  );

  assert.equal(store.deleteScope('dana'), 1, 'the count reports events, and the baseline is not an event');
  assert.equal(store.readBaseline('dana'), null);
  assert.deepEqual(readdirSync(dataDir), [], 'the pre-event-log counters are the user\'s data too');
  rmSync(dir, { recursive: true, force: true });
});

test('SECURITY: a file naming a different scope is never deleted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feedback-sec5-'));
  const dataDir = join(dir, 'store');
  const store = createFileFeedbackEventStore({ dataDir });
  const carol = store.append(input({ scopeId: 'carol' }), RECORDED);
  store.writeBaseline(baseline('carol'));
  writeFileSync(join(dataDir, `${carol.id}.feedback.json`), '{"scopeId":"carol","subjectId":"CORRUPT');

  assert.equal(store.deleteScope('erin'), 0, "deleting erin must not touch carol's data");
  assert.equal(readdirSync(dataDir).length, 2, "carol's event and baseline must survive");
  assert.ok(store.readBaseline('carol'), "carol's baseline must survive another user's deletion");
  rmSync(dir, { recursive: true, force: true });
});

test('SECURITY: a sibling scope keeps its events when a neighbour is deleted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feedback-sec6-'));
  const dataDir = join(dir, 'store');
  const store = createFileFeedbackEventStore({ dataDir });
  store.append(input({ scopeId: 'alice' }), RECORDED);
  store.append(input({ scopeId: 'alice', subjectId: 'commitment-2' }), RECORDED);
  const kept = store.append(input({ scopeId: 'bob' }), RECORDED);
  store.writeBaseline(baseline('bob'));

  assert.equal(store.deleteScope('alice'), 2);
  assert.deepEqual(store.list({ scopeId: 'bob' }).map((event) => event.id), [kept.id]);
  assert.equal(existsSync(join(dataDir, `${kept.id}.feedback.json`)), true);
  assert.deepEqual(store.readBaseline('bob'), baseline('bob'));
  rmSync(dir, { recursive: true, force: true });
});
