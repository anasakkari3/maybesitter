/**
 * The two email detectors, held to one answer (UC-3.8, #192 step 8).
 *
 * The same idea as `tests/mobile/exportMobileApiFixtures.test.ts`: a thing that
 * exists twice is written down once and both copies are checked against the
 * writing. There the two copies are a route and a Zod schema; here they are
 * `looksLikeEmail` on the server and `looksLikeEmail` in the app, which cannot
 * import each other across the workspace boundary.
 *
 * This file does two things and they are both necessary:
 *
 *  1. asserts the **backend** detector against the hand-declared expectations
 *     in `tests/fixtures/share/email/detectorCases.ts`;
 *  2. writes those cases and expectations to
 *     `mobile/src/features/share/__fixtures__/emailDetectorCases.json`, which
 *     `mobile/src/features/share/__tests__/emailTextDetector.test.ts` runs the
 *     **RN** detector over.
 *
 * Order matters: the assertion comes first, so a backend detector that
 * disagreed with the hand-written answers cannot launder its disagreement into
 * the fixture and make the RN suite green against a defect. The exported file
 * carries the declared expectation, never a computed one.
 *
 * The acceptance criterion is "the RN detector and the backend detector agree
 * on 100% of the shared cases". Agreement with each other is not enough — two
 * detectors can agree and both be wrong — so both agree with a person instead.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emailSignals, looksLikeEmail } from '../../lib/services/share/emailDetector.ts';
import { EMAIL_DETECTOR_CASES } from '../fixtures/share/email/detectorCases.ts';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'mobile',
  'src',
  'features',
  'share',
  '__fixtures__',
);

test('the backend detector answers every declared case the way a person did', () => {
  for (const shared of EMAIL_DETECTOR_CASES) {
    assert.equal(
      looksLikeEmail(shared.text),
      shared.expected,
      `${shared.name}: ${shared.because} — signals were [${emailSignals(shared.text).join(', ')}]`,
    );
  }
});

test('the case list is worth running', () => {
  // A list that is all positives passes against `() => true`, and a list that
  // is all negatives passes against `() => false`. Either is a parity fixture
  // that proves nothing about either detector.
  const positives = EMAIL_DETECTOR_CASES.filter((shared) => shared.expected).length;
  const negatives = EMAIL_DETECTOR_CASES.length - positives;
  assert.ok(positives >= 5, `expected several emails, got ${positives}`);
  assert.ok(negatives >= 5, `expected several non-emails, got ${negatives}`);
  const names = new Set(EMAIL_DETECTOR_CASES.map((shared) => shared.name));
  assert.equal(names.size, EMAIL_DETECTOR_CASES.length, 'two cases share a name');
});

test('the cases are exported for the RN suite to run the app detector over', () => {
  mkdirSync(FIXTURES, { recursive: true });
  const exported = EMAIL_DETECTOR_CASES.map((shared) => ({
    name: shared.name,
    text: shared.text,
    // Declared, never computed. See the note at the top of this file.
    expected: shared.expected,
    /*
     * The backend's *reasons*, which — unlike `expected` — are computed.
     *
     * The boolean alone is a weak parity check: `looksLikeEmail` is "two of
     * four signals", so a pattern edited on one side and not the other can go
     * on returning the same answer for every case in this list while the two
     * implementations have quietly stopped being the same predicate. The RN
     * suite asserts its own `emailSignals` against this, so a dead Arabic
     * pattern is a red run rather than a boolean that still happens to agree.
     *
     * It is safe for this one to be computed because `expected` is not: the
     * assertion above has already refused to let a wrong backend reach here.
     */
    signals: emailSignals(shared.text),
    because: shared.because,
  }));
  writeFileSync(
    join(FIXTURES, 'emailDetectorCases.json'),
    `${JSON.stringify(exported, null, 2)}\n`,
    'utf8',
  );
  assert.equal(exported.length, EMAIL_DETECTOR_CASES.length);
});
