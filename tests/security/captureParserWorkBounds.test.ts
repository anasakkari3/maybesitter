/**
 * The capture parsers never see a string the cap did not bound (#514).
 *
 * #508 left the claim it rests on — *the cap bounds worst-case parser latency*
 * — defended only by tests/perf/captureSplitBounds.perf.test.ts, and that file
 * is deliberately outside `npm test`: its assertions are wall-clock, and a
 * clock under CI load reports the machine rather than the code (UC-0.3, #136,
 * not relitigated here). So CI had nothing that would notice a reintroduced
 * quadratic parser in the capture path.
 *
 * This closes that with the instrument #510 used for its own placement gap: not
 * a clock, a counter. #510's 'C: the guard runs above splitInput' in
 * tests/security/captureInputLimit.test.ts counts **storage reads**, because
 * `proposeCapture` reads storage before it calls `splitInput` — so zero reads
 * places the guard above the split. That works, and it is indirect: it infers
 * the parser was not reached from a landmark that sits in front of it.
 *
 * Here the parsers are observed directly. Every regex operation Node performs
 * is recorded with the length of the string it ran against, and the claim
 * becomes literal and clock-free:
 *
 *   **no regex in the capture path ever runs against a string longer than
 *   `CAPTURE_INPUT_MAX_CHARACTERS`.**
 *
 * That is the structural form of "worst-case parser latency is bounded",
 * because both quadratic parsers behind this boundary — `splitInput` (CodeQL
 * #39) and the follow-up match at `src/extraction/ruleBasedExtractor.ts:386`
 * (CodeQL #2) — are regexes, and a quadratic regex is only dangerous in
 * proportion to the subject it is handed. Bound the subject and the work is
 * bounded, on any machine, with nothing to flake.
 *
 * What it catches that the existing suite does not:
 *
 *   - a normalisation regex added to the raw input *above* the guard, which
 *     reads no storage and calls no extractor, so every test in
 *     captureInputLimit.test.ts stays green;
 *   - the guard moved below `splitInput`, below the extractor, or below any
 *     parser added next — including one reached by a path that does not touch
 *     `readCategoryPreferences`, which is the landmark #510's counter relies on;
 *   - `CAPTURE_INPUT_MAX_CHARACTERS` raised to a value the measured cost table
 *     does not support (test C below).
 *
 * This is an addition. `npm run test:perf` still owns the actual milliseconds,
 * and is still the only place that measures them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { CAPTURE_INPUT_MAX_CHARACTERS } from '../../src/contracts/v1/captureContracts.ts';
import {
  CaptureInputTooLargeError,
  MemoryCaptureProposalStore,
  proposeCapture,
} from '../../lib/services/captureBoundary/index.ts';

const now = new Date('2026-08-17T08:00:00.000Z');

function dependencies() {
  return {
    store: new MemoryCaptureProposalStore(),
    persistence: {
      snapshot: async () => createEmptyDomainState(),
      persistAtomically: async () => ({ state: createEmptyDomainState() }),
    },
  };
}

function propose(text: string) {
  return proposeCapture(
    text,
    { now, timezone: 'UTC', scopeId: 'scope-514', requestedEngine: 'rules' },
    dependencies() as never,
  );
}

/**
 * Every regex operation, with the length of the string it ran against.
 *
 * The five entry points are all of them: `RegExp.prototype.exec` and `.test`
 * for direct use, and the three well-known symbols through which
 * `String.prototype.replace`, `.split`, `.match`, `.matchAll`, `.search` and
 * `.replaceAll` dispatch to a regex. `splitInput` reaches the engine through
 * `Symbol.replace` and `Symbol.split`; `ruleBasedExtractor.ts:386` reaches it
 * through `Symbol.match`. Patching the prototype rather than the call sites
 * means a parser added next is observed without this file being touched —
 * which is the point, since the regression being guarded against is a *future*
 * parser, not either of the two known ones.
 *
 * Nothing test-only is added to production code: this instruments the language,
 * not the service.
 */
function recordRegexSubjects() {
  const proto = RegExp.prototype as unknown as Record<PropertyKey, unknown>;
  const keys: PropertyKey[] = ['exec', 'test', Symbol.replace, Symbol.split, Symbol.match];
  const originals = new Map(keys.map((key) => [key, proto[key]]));
  const seen = { operations: 0, longestSubject: 0 };

  for (const key of keys) {
    const original = originals.get(key) as (this: RegExp, ...args: unknown[]) => unknown;
    proto[key] = function instrumented(this: RegExp, ...args: unknown[]) {
      seen.operations += 1;
      // The subject is the first argument for all five. Only a primitive
      // string is measured: a non-string is coerced by the original, and its
      // length before coercion would not be the length the engine scans.
      if (typeof args[0] === 'string' && args[0].length > seen.longestSubject) {
        seen.longestSubject = args[0].length;
      }
      return original.apply(this, args);
    };
  }

  return { seen, restore: () => { for (const key of keys) proto[key] = originals.get(key); } };
}

/**
 * Run `body` with the recorder installed.
 *
 * The recorder is global, so it also counts regex work the test runner and the
 * module loader happen to do on the same tick. That is harmless in both
 * directions: `operations` is only ever asserted to be *non-zero* (a positive
 * control), and `longestSubject` is asserted to be *small*, which foreign work
 * can only push the wrong way — it cannot hide a long subject the capture path
 * scanned.
 */
async function withRecorder<T>(body: () => Promise<T>): Promise<{ result: T; seen: { operations: number; longestSubject: number } }> {
  const recorder = recordRegexSubjects();
  try {
    return { result: await body(), seen: recorder.seen };
  } finally {
    recorder.restore();
  }
}

/**
 * The two payloads whose cost is the reason the cap exists, at ten times the
 * cap, plus one merely enormous string.
 *
 * The hostile two are held at 20,000 rather than 100,000 deliberately. The
 * assertion here is structural — *was the parser handed this at all* — not a
 * measurement, so a larger payload proves nothing extra, and 20,000 keeps a
 * failing run fast: at 100,000 a regressed guard would spend ~11 seconds
 * inside the two quadratic regexes before this test could report it, which is
 * how a true failure gets mistaken for a hang.
 */
const OVERSIZED = {
  // `splitInput`'s worst case: one unbroken whitespace run, so the leading
  // `\s+` retries at every offset (CodeQL #39).
  whitespaceRun: `a${' '.repeat(20_000)}b`,
  // `ruleBasedExtractor.ts:386`'s worst case: `i need to follow up with` gets
  // past the message-kind gate, the repeated ` at ` maximises the optional
  // tail's retries, and the trailing U+2028 makes the final `$` unreachable so
  // the lazy group retries at every offset (CodeQL #2).
  followUpMatch: `i need to follow up with bob about ${' at '.repeat(5_000)} `,
  // Not hostile in shape, only in size. A cheap regex over 100,000 characters
  // is still 100,000 characters of scanning on the thread that serves every
  // other request, and it is the shape a guard-above-the-parser claim has to
  // hold for too.
  plainBulk: `Remind me to call the doctor at noon ${'x'.repeat(100_000)}`,
} as const;

// ── A. No parser is handed input the guard should have refused ───

for (const [name, payload] of Object.entries(OVERSIZED)) {
  test(`A: no regex runs on the oversized ${name} payload`, async () => {
    assert.ok(payload.length > CAPTURE_INPUT_MAX_CHARACTERS, 'this payload is not actually oversized');

    const { seen } = await withRecorder(async () => {
      await assert.rejects(() => propose(payload), CaptureInputTooLargeError, 'the boundary accepted oversized input');
    });

    assert.ok(
      seen.longestSubject <= CAPTURE_INPUT_MAX_CHARACTERS,
      `a regex ran against ${seen.longestSubject} characters of input the server had already refused `
      + `(the cap is ${CAPTURE_INPUT_MAX_CHARACTERS}), so a parser sits above the length guard and #508 is reopened`,
    );
  });
}

test('A: the recorder sees the capture path at all, so the zeros above mean something', async () => {
  /*
   * The positive control, without which every assertion in A is vacuous: an
   * instrument that observed nothing would report `longestSubject: 0` no matter
   * where the guard sat. A legal capture must drive both counters, and its
   * subject must reach the length of the text itself — which is what says the
   * recorder is watching the parsers and not merely the test harness.
   */
  const text = 'Remind me to call the doctor tomorrow at 2pm.';
  const { result, seen } = await withRecorder(() => propose(text));

  assert.equal(result.status, 'proposed', 'an ordinary capture stopped working');
  assert.ok(seen.operations > 0, 'the recorder counted no regex operations at all, so it is not installed');
  assert.ok(
    seen.longestSubject >= text.length,
    `the longest subject any regex saw was ${seen.longestSubject} characters, shorter than the ${text.length}-character `
    + 'capture itself — the recorder is not observing the parsers, so the A assertions prove nothing',
  );
});

// ── B. The bound holds at the cap, not only past it ──────────────

test('B: a capture at exactly the cap is never amplified before it is parsed', async () => {
  /*
   * A dead guard is one regression; a live guard in front of a parser that
   * *grows* its input is another, and it is invisible to A, which only ever
   * sees refusals. If anything between the guard and the regexes expands the
   * text — a repeat, a decode, an unrolled substitution — then bounding the
   * input stops bounding the work, and the cost table on
   * `CAPTURE_INPUT_MAX_CHARACTERS` stops being true.
   *
   * So: at exactly the cap, the longest string any regex sees is still the cap.
   * Run through the real rule-based extractor rather than a spy, because the
   * second quadratic regex lives inside it.
   */
  const head = 'Remind me to call the doctor tomorrow at 2pm. ';
  const text = (head + 'x'.repeat(CAPTURE_INPUT_MAX_CHARACTERS)).slice(0, CAPTURE_INPUT_MAX_CHARACTERS);
  assert.equal(text.length, CAPTURE_INPUT_MAX_CHARACTERS);

  const { result, seen } = await withRecorder(() => propose(text));

  assert.equal(result.status, 'proposed', 'a capture at exactly the cap was refused');
  assert.ok(
    seen.longestSubject <= CAPTURE_INPUT_MAX_CHARACTERS,
    `a capture of ${CAPTURE_INPUT_MAX_CHARACTERS} characters was grown to ${seen.longestSubject} before a regex read it, `
    + 'so the cap no longer bounds what the parsers scan',
  );
});

// ── C. The cap is a number the cost table supports ───────────────

test('C: the enforced cap stays within the range the measured parser cost allows', () => {
  /*
   * The other half of "the perf suite is the only thing that would notice".
   * Every assertion above is relative to `CAPTURE_INPUT_MAX_CHARACTERS`, so
   * raising the constant keeps them all green while handing both quadratic
   * parsers proportionally more to chew — which is exactly the regression
   * tests/perf/captureSplitBounds.perf.test.ts was carrying alone, and it does
   * not run in CI.
   *
   * The measured worst case per request, on the one thread that serves
   * everybody (src/contracts/v1/captureContracts.ts):
   *
   *                  splitInput      ruleBasedExtractor:386
   *     2,000 chars       2.8ms                      3.9ms
   *    20,000 chars     167.9ms                    294.8ms
   *   100,000 chars    3555.9ms                   7233.6ms
   *
   * 2,000 is the largest figure in that table that keeps both parsers in single
   * digit milliseconds. Raising this is not forbidden — it is a decision that
   * has to be taken deliberately, with new measurements, by someone who also
   * edits this line and the table it quotes. That is the whole job of this
   * assertion: to make a quiet edit to the constant loud.
   */
  assert.ok(
    CAPTURE_INPUT_MAX_CHARACTERS <= 2_000,
    `CAPTURE_INPUT_MAX_CHARACTERS is ${CAPTURE_INPUT_MAX_CHARACTERS}. Above 2,000 the measured cost of the two `
    + 'quadratic capture parsers leaves hundreds of milliseconds of blocked event loop reachable per authenticated '
    + 'request (#508). If the number is meant to change, re-measure with `npm run test:perf` and update the table on '
    + 'the constant and this bound together.',
  );
});

// ── D. The bound is the boundary's, not this harness's ───────────

test('D: the same bound holds when storage is real, so nothing here depends on the spy', async () => {
  /*
   * A: and B: supply an in-memory persistence stub. This runs the oversized
   * refusal with the production storage seam installed instead, so the claim
   * covers `readCategoryPreferences` and anything else the boundary reaches
   * on the way — the path #510's read counter measures from the other side.
   */
  setStorageForTests(createMemoryStorage());
  try {
    const { seen } = await withRecorder(async () => {
      await assert.rejects(() => propose(OVERSIZED.plainBulk), CaptureInputTooLargeError);
    });
    assert.ok(
      seen.longestSubject <= CAPTURE_INPUT_MAX_CHARACTERS,
      `a regex ran against ${seen.longestSubject} characters with real storage installed`,
    );
  } finally {
    resetStorageForTests();
  }
});
