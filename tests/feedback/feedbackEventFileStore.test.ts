/**
 * File-backed feedback event store (Sprint 03, issue #13).
 *
 * Covers what only the on-disk backend can prove: that a user's own words
 * survive a write/read cycle byte for byte, that one damaged file cannot deny
 * them the rest of their history, that a hand-placed file cannot serve one
 * scope's data to another, and that a completed write leaves nothing behind.
 *
 * Uses the mkdtempSync + MAYBESITTER_DATA_DIR override + rmSync cleanup idiom
 * from tests/runtimeMemory/runtimeMemoryFileStore.test.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FEEDBACK_EVENT_SCHEMA_VERSION,
  type AppendFeedbackEventInput,
} from '../../src/contracts/v1/feedbackContracts.ts';
import { createFileFeedbackEventStore } from '../../lib/feedback/feedbackEventStore.ts';

const OCCURRED = '2026-08-18T09:00:00.000Z';
const RECORDED = '2026-08-18T09:00:03.000Z';

const ARABIC = 'التزام: الاتصال بالطبيب قبل الساعة ٩ — لا تؤجل';
const HEBREW = 'התחייבות: להתקשר לרופא לפני 9 — לא לדחות';
/** Bidi controls and presentation forms a re-encoding pass would introduce. */
const BIDI_MARKS = /[‎‏‪-‮⁦-⁩ﭐ-﷿ﹰ-﻿]/;

let directory = '';

function setup(): () => void {
  directory = mkdtempSync(join(tmpdir(), 'maybesitter-feedback-file-'));
  const previous = process.env.MAYBESITTER_DATA_DIR;
  process.env.MAYBESITTER_DATA_DIR = directory;
  return () => {
    if (previous === undefined) delete process.env.MAYBESITTER_DATA_DIR;
    else process.env.MAYBESITTER_DATA_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  };
}

function eventDir(): string {
  return join(directory, 'feedback-events');
}

function input(overrides: Partial<AppendFeedbackEventInput> = {}): AppendFeedbackEventInput {
  return {
    scopeId: 'scope-a',
    outcome: 'complete',
    subjectId: 'commitment-1',
    actor: 'user',
    source: 'mobile_action',
    occurredAt: OCCURRED,
    ...overrides,
  };
}

test('the file store honours MAYBESITTER_DATA_DIR and writes one file per event at 0600', () => {
  const cleanup = setup();
  try {
    const store = createFileFeedbackEventStore();
    const event = store.append(input(), RECORDED);

    const files = readdirSync(eventDir());
    assert.deepEqual(files, [`${event.id}.feedback.json`]);
    assert.equal(
      statSync(join(eventDir(), files[0])).mode & 0o777,
      0o600,
      'every event is personal, so the file is owner-only',
    );
  } finally {
    cleanup();
  }
});

test('a completed write leaves no temp file behind', () => {
  const cleanup = setup();
  try {
    const store = createFileFeedbackEventStore();
    store.append(input(), RECORDED);
    store.revoke(store.list({ scopeId: 'scope-a' })[0].id, RECORDED);
    store.writeBaseline({
      version: FEEDBACK_EVENT_SCHEMA_VERSION,
      scopeId: 'scope-a',
      counters: {
        ignoredSuggestions: 1, completedActions: 2, delayedActions: 0,
        clarificationSuccesses: 0, clarificationFailures: 0,
      },
      lastUpdatedAt: null,
      timestampsUnavailable: true,
      migratedAt: RECORDED,
    });

    assert.equal(
      readdirSync(eventDir()).some((entry) => entry.endsWith('.tmp')),
      false,
      'temp-then-rename must not leave residue after a successful write',
    );
  } finally {
    cleanup();
  }
});

test('events survive a restart of the store over the same directory', () => {
  const cleanup = setup();
  try {
    const written = createFileFeedbackEventStore().append(input(), RECORDED);
    const reopened = createFileFeedbackEventStore();
    assert.deepEqual(reopened.get(written.id), written);
    // The key is derived, not remembered, so idempotency outlives the process.
    assert.deepEqual(reopened.append(input(), '2026-08-19T09:00:00.000Z'), written);
    assert.equal(reopened.list({ scopeId: 'scope-a' }).length, 1);
  } finally {
    cleanup();
  }
});

test('Arabic and Hebrew ids are stored as the user wrote them', () => {
  const cleanup = setup();
  try {
    const store = createFileFeedbackEventStore();
    const event = store.append(input({ scopeId: ARABIC, subjectId: HEBREW }), RECORDED);

    const raw = readFileSync(join(eventDir(), `${event.id}.feedback.json`), 'utf8');
    const parsed = JSON.parse(raw) as { scopeId: string; subjectId: string };
    assert.equal(parsed.scopeId, ARABIC);
    assert.equal(parsed.subjectId, HEBREW);
    assert.equal(BIDI_MARKS.test(raw), false, 'no bidi control or presentation form may be introduced on write');
    assert.equal(
      Buffer.from(parsed.subjectId, 'utf8').equals(Buffer.from(HEBREW, 'utf8')),
      true,
      'the stored bytes must be the ones the user supplied',
    );
    assert.equal(store.get(event.id)?.scopeId, ARABIC);
  } finally {
    cleanup();
  }
});

test('a corrupt event file is skipped rather than fatal', () => {
  const cleanup = setup();
  try {
    const store = createFileFeedbackEventStore();
    const healthy = store.append(input(), RECORDED);
    const damaged = store.append(input({ subjectId: 'commitment-2' }), RECORDED);
    writeFileSync(join(eventDir(), `${damaged.id}.feedback.json`), '{"scopeId":"scope-a","outcome":"comp');

    assert.deepEqual(store.list({ scopeId: 'scope-a' }).map((event) => event.id), [healthy.id]);
    assert.equal(store.get(damaged.id), null, 'a partial record must never surface as an event');
    assert.equal(store.revoke(damaged.id, RECORDED), false);
  } finally {
    cleanup();
  }
});

test('an event file written by another schema version is skipped', () => {
  const cleanup = setup();
  try {
    const store = createFileFeedbackEventStore();
    const event = store.append(input(), RECORDED);
    const stale = { ...event, version: 'feedback-event-v0' };
    writeFileSync(join(eventDir(), `${event.id}.feedback.json`), JSON.stringify(stale));

    assert.equal(store.get(event.id), null);
    assert.equal(store.list({ scopeId: 'scope-a' }).length, 0);
  } finally {
    cleanup();
  }
});

test('an event file whose id contradicts its filename is not served', () => {
  const cleanup = setup();
  try {
    const store = createFileFeedbackEventStore();
    const mine = store.append(input(), RECORDED);
    const other = store.append(input({ scopeId: 'scope-b' }), RECORDED);
    // A hand-placed file claiming to be a record it is not: the id is what a
    // revoke endpoint addresses, so serving it under the wrong path would let
    // one lookup return another event entirely.
    writeFileSync(join(eventDir(), `${mine.id}.feedback.json`), JSON.stringify({ ...other, id: other.id }));

    assert.equal(store.get(mine.id), null);
  } finally {
    cleanup();
  }
});

test('a damaged or misattributed baseline reads as absent rather than throwing', () => {
  const cleanup = setup();
  try {
    const store = createFileFeedbackEventStore();
    store.writeBaseline({
      version: FEEDBACK_EVENT_SCHEMA_VERSION,
      scopeId: 'scope-a',
      counters: {
        ignoredSuggestions: 4, completedActions: 1, delayedActions: 0,
        clarificationSuccesses: 0, clarificationFailures: 2,
      },
      lastUpdatedAt: '2026-08-10T20:00:00.000Z',
      timestampsUnavailable: true,
      migratedAt: RECORDED,
    });

    const baselineFile = readdirSync(eventDir()).find((entry) => entry.endsWith('.feedback-baseline.json'));
    assert.ok(baselineFile, 'the baseline is stored as its own file');

    // Re-point the file's contents at another scope: the filename is a digest
    // of the scopeId, but the name is never trusted over the record itself.
    writeFileSync(join(eventDir(), baselineFile), JSON.stringify({
      version: FEEDBACK_EVENT_SCHEMA_VERSION,
      scopeId: 'scope-b',
      counters: {
        ignoredSuggestions: 9, completedActions: 9, delayedActions: 9,
        clarificationSuccesses: 9, clarificationFailures: 9,
      },
      lastUpdatedAt: null,
      timestampsUnavailable: true,
      migratedAt: RECORDED,
    }));
    assert.equal(store.readBaseline('scope-a'), null, "another scope's counters must not be served here");

    writeFileSync(join(eventDir(), baselineFile), '{"scopeId":"scope-a","counters":');
    assert.equal(store.readBaseline('scope-a'), null);
  } finally {
    cleanup();
  }
});
