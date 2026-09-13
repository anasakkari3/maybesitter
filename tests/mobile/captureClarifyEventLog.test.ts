/**
 * The answer to the one question is actually written down (UC-2.5, #165).
 *
 * ── Why this file exists ─────────────────────────────────────────
 *
 * `answerClarification` ended by handing a `clarification_answered` event to a
 * port. The port was optional, the call was optional-chained, and the single
 * production construction site never passed an implementation — so the event
 * was assembled on every answer and thrown away, and no test in the suite
 * could go red about it, because a no-op is exactly what an unimplemented
 * optional port looks like from the outside.
 *
 * So these assertions are deliberately about *storage*, reached through the
 * real route. A test that stubs `recordEvent` and checks it was called proves
 * only that the service calls its own port, which was never the thing that was
 * broken.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { getStorage, resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { CLARIFICATION_EVENTS, userCol } from '../../lib/storage/paths.ts';
import {
  appendClarificationEvent,
  listClarificationEvents,
  type ClarificationAnsweredRecord,
} from '../../lib/services/captureBoundary/clarificationEventLog.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { POST as capturePost } from '../../src/app/api/mobile/capture/route.ts';
import { POST as clarifyPost } from '../../src/app/api/mobile/capture/clarify/route.ts';

const BASE = 'http://127.0.0.1:4321';
const UID = uidFor('ClarifyEventUser');
const OTHER = uidFor('OtherAccount');
const ZONE = 'Asia/Jerusalem';
const NOW = '2026-09-13T06:00:00.000Z'; // 09:00 local

interface Asking {
  itemId: string;
  clarification: { questionId: string; field: string; options: Array<{ optionId: string }> };
}

function setup(): () => void {
  setStorageForTests(createMemoryStorage());
  const auth: FakeAuthControls = installFakeAuth();
  return () => {
    auth.restore();
    resetStorageForTests();
  };
}

function request(path: string, body: unknown, uid: string = UID): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: new Headers({
      authorization: `Bearer ${tokenFor(uid)}`,
      'content-type': 'application/json',
    }),
    body: JSON.stringify(body),
  });
}

async function json(response: Response, expected = 200): Promise<Record<string, unknown>> {
  const body = await response.json() as Record<string, unknown>;
  assert.equal(response.status, expected, `unexpected status — ${JSON.stringify(body)}`);
  return body;
}

/**
 * A capture the extractor cannot pin down, proposed through the route the app
 * calls. `Remind me to call Dana` has an action and no time, so the
 * disposition is `needs_clarification` and the builder asks about `time`.
 */
async function proposeAmbiguous(uid: string = UID) {
  const proposal = await json(await capturePost(request(
    '/api/mobile/capture',
    { text: 'Remind me to call Dana', referenceTime: NOW, timezone: ZONE },
    uid,
  )));
  const asking = (proposal.items as Asking[]).find((item) => item.clarification);
  assert.ok(asking, 'expected an item carrying a clarification');
  return { proposalId: proposal.proposalId as string, asking };
}

/** What is actually on disk under that account, at the path production writes. */
async function storedFor(uid: string): Promise<ClarificationAnsweredRecord[]> {
  const rows = await getStorage().list<ClarificationAnsweredRecord>(userCol(uid, CLARIFICATION_EVENTS));
  return rows.map((row) => row.data);
}

test('answering through the route puts the answer in the user own tree', async () => {
  const cleanup = setup();
  try {
    const { proposalId, asking } = await proposeAmbiguous();
    assert.deepEqual(await storedFor(UID), [], 'nothing recorded before the answer');

    await json(await clarifyPost(request('/api/mobile/capture/clarify', {
      proposalId,
      itemId: asking.itemId,
      questionId: asking.clarification.questionId,
      optionId: asking.clarification.options[0]!.optionId,
      referenceTime: NOW,
      timezone: ZONE,
    })));

    const stored = await storedFor(UID);
    assert.equal(stored.length, 1, 'the answer never reached storage');
    const event = stored[0]!;
    assert.equal(event.type, 'clarification_answered');
    assert.equal(event.uid, UID);
    assert.equal(event.proposalId, proposalId);
    assert.equal(event.itemId, asking.itemId);
    // The field the question was about, not a sentence. `ask_time` asks about
    // `time`, and the ledger is only useful if it says which part was unclear.
    assert.equal(event.field, asking.clarification.field);
    assert.equal(event.answerKind, 'option');
    assert.ok(Number.isFinite(Date.parse(event.at)), 'the answer needs an instant');

    // And it is this account's row, not a global one. Somebody else's tree is
    // untouched.
    assert.deepEqual(await storedFor(OTHER), []);
  } finally {
    cleanup();
  }
});

test('a free-text answer is recorded as free text, and the words are not in it', async () => {
  const cleanup = setup();
  try {
    const { proposalId, asking } = await proposeAmbiguous();
    // Distinctive enough that a substring scan cannot pass by accident, and in
    // the script a real user of this product types in.
    const words = 'بالمسا الساعة تسعة';

    await json(await clarifyPost(request('/api/mobile/capture/clarify', {
      proposalId,
      itemId: asking.itemId,
      questionId: asking.clarification.questionId,
      freeText: words,
      referenceTime: NOW,
      timezone: ZONE,
    })));

    const stored = await storedFor(UID);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.answerKind, 'free_text');

    // The sentence a person wrote about their own commitment has no business
    // in an event log. Checked over the whole serialised row rather than a
    // named field, so a field added later cannot smuggle it back in.
    const serialised = JSON.stringify(stored[0]);
    assert.ok(!serialised.includes(words), `the free text is in the event: ${serialised}`);
    for (const fragment of words.split(' ')) {
      assert.ok(!serialised.includes(fragment), `part of the free text is in the event: ${serialised}`);
    }
  } finally {
    cleanup();
  }
});

test('the same answer written twice is one row, a different one is two', async () => {
  const cleanup = setup();
  try {
    const event = {
      type: 'clarification_answered' as const,
      proposalId: 'p-1',
      itemId: 'i-1',
      field: 'time',
      answerKind: 'option' as const,
      at: NOW,
    };
    // The document id is derived from the answer, so a retry above the
    // idempotency layer cannot make the history show two answers to one
    // question.
    await appendClarificationEvent(UID, event);
    await appendClarificationEvent(UID, event);
    assert.equal((await storedFor(UID)).length, 1);

    // And the id is not simply constant: a second, genuinely different answer
    // is its own row.
    await appendClarificationEvent(UID, { ...event, itemId: 'i-2', at: '2026-09-13T06:05:00.000Z' });
    const all = await listClarificationEvents(UID);
    assert.equal(all.length, 2);
    assert.deepEqual(all.map((row) => row.itemId), ['i-1', 'i-2'], 'oldest first');
  } finally {
    cleanup();
  }
});

test('the record port is required and called unconditionally', () => {
  // The defect was never the absence of a store: it was that the absence could
  // not be noticed. An optional port reached by `?.` is a call site that
  // cannot fail, so this file is worth nothing if either comes back.
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib/services/captureBoundary/clarifyService.ts'),
    'utf8',
  );
  assert.ok(/recordEvent:\s*\(event: ClarificationAnsweredEvent\)/.test(source), 'recordEvent must stay a required dependency');
  assert.ok(!source.includes('recordEvent?'), 'recordEvent must not be optional or optional-chained again');
  assert.ok(source.includes('await dependencies.recordEvent({'), 'the event must be recorded on every answer');
});
