/**
 * The server-side length limit on a capture (#508).
 *
 * `mobile/src/features/capture/captureMachine.ts:182` caps a typed capture at
 * 2000 characters, and that cap is real protection for the person using the
 * app and none at all for the server: it lives in the client, so anybody
 * holding a valid token can post a megabyte to `/api/mobile/capture` and skip
 * it entirely. `splitInput` in the capture boundary then walks that megabyte
 * with a regex whose leading `\s+` backtracks across a whitespace run, which is
 * quadratic — 3.4 seconds at 100k characters, on the one thread that serves
 * every other request.
 *
 * So the claim these tests defend is not "long captures are rejected". It is
 * **the boundary that refuses them is the server's, and it sits below every
 * route that can reach the parser** — the typed capture, the share intake, and
 * anything added next. Test B is the one that matters: it never touches the
 * mobile reducer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { CAPTURE_INPUT_MAX_CHARACTERS } from '../../src/contracts/v1/captureContracts.ts';
import {
  CaptureInputTooLargeError,
  MemoryCaptureProposalStore,
  TransactionalCapturePersistenceAdapter,
  proposeCapture,
} from '../../lib/services/captureBoundary/index.ts';
import { proposeMobileCapture } from '../../lib/services/mobile/mobileCaptureService.ts';
import { MAX_SHARE_TEXT_CHARACTERS } from '../../lib/services/share/shareIntakeService.ts';
import { POST as capturePost } from '../../src/app/api/mobile/capture/route.ts';
import type { ExtractionResult } from '../../src/extraction/extractionTypes.ts';

const now = new Date('2026-08-17T08:00:00.000Z');

let auth: FakeAuthControls | null = null;

function begin(): void {
  auth = installFakeAuth();
  setStorageForTests(createMemoryStorage());
}

function end(): void {
  resetStorageForTests();
  auth?.restore();
  auth = null;
}

function extracted(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    type: 'task',
    action: 'Call the doctor',
    title: 'Call the doctor',
    person: null,
    dueAt: '2026-08-17T12:00:00.000Z',
    remindAt: '2026-08-17T12:00:00.000Z',
    localTimeSpec: { date: '2026-08-17', time: '12:00', timezone: 'UTC' },
    timeEvidence: 'hhmm',
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureImplied: false },
    flexibility: 'movable',
    category: null,
    categoryConfidence: 0,
    confidence: { overall: 0.95, type: 0.95, action: 0.95, time: 0.95, priority: 0.8 },
    missingFields: [],
    ambiguityFlags: [],
    explicitReminderRequest: true,
    explicitPressureRequest: false,
    rawText: 'Call the doctor at noon',
    parserVersion: 'test-v1',
    ...overrides,
  };
}

/**
 * The boundary's two injectable seams, with counters.
 *
 * `extractor` is the production dependency the service already accepts, not a
 * hook added for these tests: `proposeCapture` reads it from
 * `CaptureBoundaryDependencies`, and every other capture test supplies it the
 * same way. Counting its calls is therefore an honest measure of whether the
 * parsing half of the function ran.
 */
function spyHarness() {
  const calls = { extract: 0, persist: 0 };
  return {
    calls,
    dependencies: {
      store: new MemoryCaptureProposalStore(),
      persistence: {
        snapshot: async () => createEmptyDomainState(),
        async persistAtomically() {
          calls.persist += 1;
          return { state: createEmptyDomainState() };
        },
      },
      extractor: async () => {
        calls.extract += 1;
        return { result: extracted(), engine: 'ollama' as const, fallbackReason: null };
      },
    },
  };
}

/**
 * A real memory adapter that counts the reads through it.
 *
 * `getStorage()` is an existing production seam, overridden with
 * `setStorageForTests`, so nothing test-only is added to the service to make
 * this observable. What it buys is the one assertion `calls.extract` cannot
 * make: `proposeCapture` reads storage at `readCategoryPreferences` *before* it
 * calls `splitInput`, so zero reads means the guard ran above the regex.
 */
function countingStorage() {
  const inner = createMemoryStorage();
  const counts = { reads: 0 };
  const adapter = new Proxy(inner, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      if (property !== 'get' && property !== 'list' && property !== 'listGroup') return value.bind(target);
      return (...args: unknown[]) => {
        counts.reads += 1;
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { counts, adapter };
}

function propose(text: string, dependencies: ReturnType<typeof spyHarness>['dependencies']) {
  return proposeCapture(text, { now, timezone: 'UTC', scopeId: 'scope-508', requestedEngine: 'rules' }, dependencies as never);
}

/**
 * A capture of exactly `length` characters that is a single ordinary sentence,
 * padded with letters rather than spaces so the padding is not itself the
 * hostile shape case D covers.
 */
function sentenceOf(length: number): string {
  const head = 'Call the doctor at noon ';
  return head + 'x'.repeat(length - head.length);
}

// ── A. The boundary itself ───────────────────────────────────────

test('A: a capture of exactly the maximum length is accepted, and one character more is refused', async () => {
  const atLimit = spyHarness();
  const accepted = await propose(sentenceOf(CAPTURE_INPUT_MAX_CHARACTERS), atLimit.dependencies);
  assert.equal(accepted.status, 'proposed', 'a capture at exactly the limit was refused');
  assert.equal(atLimit.calls.extract, 1, 'the capture at the limit never reached the extractor');

  const overLimit = spyHarness();
  await assert.rejects(
    () => propose(sentenceOf(CAPTURE_INPUT_MAX_CHARACTERS + 1), overLimit.dependencies),
    (error: unknown) => error instanceof CaptureInputTooLargeError
      && error.maxCharacters === CAPTURE_INPUT_MAX_CHARACTERS,
    'one character over the limit was accepted by the server boundary',
  );
});

test('A: the limit is counted after trimming, so surrounding whitespace cannot fail a legal capture', async () => {
  const harness = spyHarness();
  const padded = `\n\n   ${sentenceOf(CAPTURE_INPUT_MAX_CHARACTERS)}   \n\n`;
  const proposal = await propose(padded, harness.dependencies);
  assert.equal(proposal.status, 'proposed', 'trimmed length is not what the guard counts');
});

// ── B. The bypass a client-side cap cannot close ─────────────────

test('B: the HTTP route refuses oversized text that never went through the mobile reducer', async () => {
  begin();
  try {
    const uid = uidFor('OversizedDirectPost');
    const response = await capturePost(new Request('http://localhost:3000/api/mobile/capture', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenFor(uid)}`, 'Content-Type': 'application/json' },
      // One character past the boundary. The point is not the size: it is that
      // the composer's cap was never consulted, because this request did not
      // come from the composer.
      body: JSON.stringify({ text: sentenceOf(CAPTURE_INPUT_MAX_CHARACTERS + 1), timezone: 'UTC' }),
    }));

    assert.equal(response.status, 413, 'the route accepted a capture larger than the server limit');
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.success, false);
    // The taxonomy is the one already in the product: `mobile/src/api/client.ts:248`
    // turns a 413 carrying `maxCharacters` into `InputTooLargeError`, which
    // `userFacingMessage.ts:118` renders as `aiInputTooLong` in all three
    // locales. `text_too_long` is the reason code the share route already mints
    // for the same refusal (shareIntakeService.ts:354) — not a new one.
    assert.equal(body.reason, 'text_too_long');
    assert.equal(body.maxCharacters, CAPTURE_INPUT_MAX_CHARACTERS);
  } finally {
    end();
  }
});

test('B: the backend service refuses oversized text when called directly', async () => {
  begin();
  try {
    await assert.rejects(
      () => proposeMobileCapture(
        { text: sentenceOf(CAPTURE_INPUT_MAX_CHARACTERS + 1), timezone: 'UTC' },
        { participantId: uidFor('OversizedDirectService') },
      ),
      (error: unknown) => error instanceof CaptureInputTooLargeError,
      'proposeMobileCapture has no length boundary of its own',
    );
  } finally {
    end();
  }
});

// ── C. The guard runs before the expensive half ──────────────────

test('C: oversized input never reaches extraction or persistence', async () => {
  const harness = spyHarness();
  await assert.rejects(
    () => propose(sentenceOf(CAPTURE_INPUT_MAX_CHARACTERS + 1), harness.dependencies),
    CaptureInputTooLargeError,
  );
  assert.equal(harness.calls.extract, 0, 'the extractor ran on input the server had already refused');
  assert.equal(harness.calls.persist, 0, 'persistence ran on input the server had already refused');
});

test('C: the guard runs above splitInput, not merely above the extractor', async () => {
  /*
   * The assertion that was missing, and the reason #510 came back from Gate 3.
   *
   * `calls.extract === 0` pins the guard above the *extractor*. It does not pin
   * it above `splitInput`, which is CodeQL #39 — the quadratic regex this issue
   * exists to bound, 3555ms at 100,000 characters. A guard moved one statement
   * below the split reopens #508 in full, and every other test here stays
   * green.
   *
   * `proposeCapture` reads storage at `readCategoryPreferences(options.scopeId)`
   * and only afterwards calls `splitInput(raw)`. So **zero storage reads** puts
   * the guard above both. No clock, nothing to flake.
   */
  const { counts, adapter } = countingStorage();
  setStorageForTests(adapter);
  try {
    const harness = spyHarness();
    await assert.rejects(
      () => propose(sentenceOf(CAPTURE_INPUT_MAX_CHARACTERS + 1), harness.dependencies),
      CaptureInputTooLargeError,
    );
    assert.equal(
      counts.reads,
      0,
      'oversized input reached the category read, so the guard is below it — and therefore below splitInput',
    );

    /*
     * The positive control, without which the assertion above is worthless: a
     * counter that never increments would satisfy it no matter where the guard
     * sat. A legal capture must drive it past zero.
     */
    const legal = spyHarness();
    await propose('Remind me to call the doctor at noon', legal.dependencies);
    assert.ok(counts.reads > 0, 'the read counter never counted anything, so the zero above proves nothing');
  } finally {
    resetStorageForTests();
  }
});

// ── D. The shape that made the parser quadratic ──────────────────

test('D: a whitespace run past the limit is refused, and one at the limit is still handled', async () => {
  const hostile = spyHarness();
  await assert.rejects(
    () => propose(`a${' '.repeat(CAPTURE_INPUT_MAX_CHARACTERS)}b`, hostile.dependencies),
    CaptureInputTooLargeError,
    'the whitespace run that produced the quadratic behaviour was accepted',
  );
  // `calls.extract` is downstream of `splitInput`, so this says the *extractor*
  // was not reached. That the split itself was not reached is a separate claim
  // with its own test — see 'C: the guard runs above splitInput' below.
  assert.equal(hostile.calls.extract, 0, 'the extractor ran on input past the limit');

  // The same shape at exactly the limit is a legal capture and must still be
  // read. The wall-clock bound on it lives in
  // tests/perf/captureSplitBounds.perf.test.ts, for the reason UC-0.3 (#136)
  // keeps clocks out of the gate.
  const legal = spyHarness();
  const run = `a${' '.repeat(CAPTURE_INPUT_MAX_CHARACTERS - 2)}b`;
  const proposal = await propose(run, legal.dependencies);
  assert.equal(proposal.status, 'proposed');
  assert.equal(legal.calls.extract, 1, 'a whitespace run at the limit was split into more than one segment');
});

test('D: the payload that makes the rule-based extractor quadratic is refused at the door', async () => {
  /*
   * The shape that actually reaches `ruleBasedExtractor.ts:386` — CodeQL alert
   * #2, the same defect through a different regex, and the worse of the two.
   * `i need to follow up with` gets past the message-kind gate; the repeated
   * ` at ` maximises the optional tail's retries; and the trailing U+2028 makes
   * the final `$` unreachable, so the lazy `(.+?)` retries at every offset.
   *
   * Measured on that regex alone: 3.9ms at 2k, 294.8ms at 20k, 7233.6ms at
   * 100k. It is the reason the cap is 2,000 and not 20,000, and this asserts
   * the refusal rather than the timing — the clock lives in
   * tests/perf/captureSplitBounds.perf.test.ts.
   */
  const hostile = `i need to follow up with bob about ${' at '.repeat(CAPTURE_INPUT_MAX_CHARACTERS)}\u2028`;
  assert.ok(hostile.length > CAPTURE_INPUT_MAX_CHARACTERS);
  const harness = spyHarness();
  await assert.rejects(
    () => propose(hostile, harness.dependencies),
    CaptureInputTooLargeError,
    'the payload that drives the extractor quadratic was accepted',
  );
  // Here `calls.extract` is the right instrument rather than an approximation:
  // this payload's quadratic regex lives *inside* the extractor
  // (ruleBasedExtractor.ts:386), which is exactly what the spy replaces.
  assert.equal(harness.calls.extract, 0, 'the extractor carrying the quadratic follow-up match was reached');
});

// ── E. The ordinary capture is untouched ─────────────────────────

test('E: a realistic capture below the limit still produces a proposal', async () => {
  const harness = spyHarness();
  const proposal = await propose('Remind me to call the doctor at noon', harness.dependencies);
  assert.equal(proposal.status, 'proposed');
  assert.equal(proposal.items.length, 1);
  assert.equal(harness.calls.extract, 1);
});

test('E: multi-segment splitting still works, in all three languages', async () => {
  for (const [text, segments] of [
    ['First; and then Second; then Third', 3],
    ['بكرة الساعة 9 دكتور وبعدين الساعة 3 الجامعة', 2],
    ['a ואז b וגם c', 3],
  ] as const) {
    const harness = spyHarness();
    await propose(text, harness.dependencies);
    assert.equal(harness.calls.extract, segments, `"${text}" no longer splits into ${segments} segments`);
  }
});

// ── F. The share path reaches the same boundary ──────────────────

test('F: the shared boundary refuses oversized text whichever door it came through', async () => {
  // Share is the second door onto `proposeMobileCapture`
  // (lib/services/share/shareIntakeService.ts:398), so it reaches this guard.
  // Its own ingress limit is larger than the boundary's — that is deliberate
  // and documented on the constant — so the boundary is what actually decides,
  // and the share route maps the refusal to the same 413 `text_too_long` it
  // already uses. What is NOT exercised here is the share route end to end:
  // share is flag-disabled in this suite and 404s on every deployed
  // environment.
  assert.ok(
    MAX_SHARE_TEXT_CHARACTERS > CAPTURE_INPUT_MAX_CHARACTERS,
    'this test is pinning the inheritance; if share is ever lowered to the cap, say so here',
  );
  const harness = spyHarness();
  await assert.rejects(
    () => propose(sentenceOf(CAPTURE_INPUT_MAX_CHARACTERS + 1), harness.dependencies),
    CaptureInputTooLargeError,
  );
  assert.equal(harness.calls.extract, 0);
});

// ── G. Characters, not bytes ─────────────────────────────────────

test('G: the cap counts characters, so Arabic and Hebrew get the same allowance as English', async () => {
  // A byte-based cap would halve the right-to-left scripts — two UTF-8 bytes
  // per character against English's one — and Arabic is this app's default
  // language. Every ASCII test would still pass, which is exactly why this one
  // is written in three alphabets.
  for (const [language, filler] of [['en', 'x'], ['ar', 'ب'], ['he', 'ש']] as const) {
    const text = `Remind me to call the doctor at noon ${filler.repeat(CAPTURE_INPUT_MAX_CHARACTERS)}`
      .slice(0, CAPTURE_INPUT_MAX_CHARACTERS);
    assert.equal(text.length, CAPTURE_INPUT_MAX_CHARACTERS);
    assert.ok(
      Buffer.byteLength(text, 'utf8') > CAPTURE_INPUT_MAX_CHARACTERS || language === 'en',
      `${language} at the cap should cost more bytes than characters`,
    );
    const harness = spyHarness();
    const proposal = await propose(text, harness.dependencies);
    assert.equal(proposal.status, 'proposed', `${language} was refused at exactly the character cap — the cap is counting bytes`);
  }
});

test('G: an astral emoji costs two code units, the same unit the composer counts', async () => {
  // Stated rather than left implicit. `String.length` is UTF-16 code units, so
  // 1000 astral emoji are exactly at the cap and 1001 are past it — which is
  // what the client's own counter does, so the two never disagree.
  const emoji = '🎉';
  assert.equal(emoji.length, 2);
  const atLimit = spyHarness();
  await propose(emoji.repeat(CAPTURE_INPUT_MAX_CHARACTERS / 2), atLimit.dependencies);
  await assert.rejects(
    () => propose(emoji.repeat(CAPTURE_INPUT_MAX_CHARACTERS / 2 + 1), spyHarness().dependencies),
    CaptureInputTooLargeError,
  );
});

// ── H. The server and the client agree ───────────────────────────

test('H: the server cap and the mobile composer cap are the same number', () => {
  // The client's 2000 is a UX affordance and this is the boundary, but if they
  // ever drift the user gets a capture the app accepted and the server refused,
  // which is a failure they cannot explain. Read the same way
  // tests/mobile/captureTitleBounds.test.ts reads it, because mobile/ is a
  // separate TS project this suite does not import from.
  const source = readFileSync(new URL('../../mobile/src/features/capture/captureMachine.ts', import.meta.url), 'utf8');
  const declared = source.match(/export const MAX_CAPTURE_LENGTH = (\d+);/);
  assert.ok(declared, 'MAX_CAPTURE_LENGTH is no longer declared as a literal in the composer');
  assert.equal(
    Number(declared[1]),
    CAPTURE_INPUT_MAX_CHARACTERS,
    'the composer and the server boundary have drifted apart',
  );
});

// ── I. A capture at the cap is usable, not merely accepted ───────

test('I: a capture at exactly the cap yields a confirmable item, in English and Arabic', async () => {
  // "Accepted" is not enough: an item that comes back needing clarification is
  // one the user cannot confirm without answering a question, which is not a
  // capture that worked. Run through the real rule-based extractor, not the spy.
  const dependencies = {
    store: new MemoryCaptureProposalStore(),
    persistence: {
      snapshot: async () => createEmptyDomainState(),
      persistAtomically: async () => ({ state: createEmptyDomainState() }),
    },
  };
  const openings = {
    en: 'Remind me to call the doctor tomorrow at 2pm. ',
    ar: 'ذكرني اتصل بالدكتور بكرة الساعة 2 بعد الضهر. ',
  };
  // Hebrew is deliberately not here. «תזכיר לי להתקשר לרופא מחר בשתיים» comes
  // back needing clarification at *34* characters on unmodified main, so it is
  // a rule-based extractor gap in Hebrew time parsing and has nothing to do
  // with this cap. Asserting it here would attribute a pre-existing defect to
  // #508.
  for (const [language, opening] of Object.entries(openings)) {
    const text = `${opening}${'x'.repeat(CAPTURE_INPUT_MAX_CHARACTERS)}`.slice(0, CAPTURE_INPUT_MAX_CHARACTERS);
    const proposal = await proposeCapture(
      text,
      { now, timezone: 'UTC', scopeId: `at-cap-${language}`, requestedEngine: 'rules' },
      dependencies as never,
    );
    assert.equal(proposal.status, 'proposed', `${language} at the cap was not proposed`);
    assert.equal(proposal.items.length, 1);
    assert.equal(proposal.items[0]?.needsClarification, false, `${language} at the cap needs clarification, so it is not confirmable`);
  }
});
