/**
 * The app's email detector, graded by the same person the server's is
 * (UC-3.8, #192 step 8).
 *
 * ── Neither detector grades itself ───────────────────────────────
 *
 * `emailTextDetector.ts` here and `lib/services/share/emailDetector.ts` at the
 * repository root are two copies of one predicate, because the RN workspace has
 * its own toolchain and cannot import across the boundary. Two copies of a
 * decision drift, and this drift is silent: the phone would route a paste one
 * way and the server would read it another, and the only symptom a user would
 * see is their school email coming back as one run-on commitment.
 *
 * So `__fixtures__/emailDetectorCases.json` is written by
 * `tests/share/exportEmailDetectorCases.test.ts` from a hand-declared list,
 * after that suite has asserted the *backend* against it. This file asserts the
 * app's detector against the same file. The two are therefore held to one
 * written answer rather than to each other — two detectors can agree and both
 * be wrong.
 *
 * ── Why the signals are asserted as well as the boolean ──────────
 *
 * `looksLikeEmail` is "two of four signals". A pattern edited here and not on
 * the server can keep answering the same boolean for every case in the list
 * while the two have stopped being the same predicate — and the case that then
 * differs is the one nobody wrote down. The exported `signals` are the
 * backend's reasons, so a pattern that has quietly died on one side is a red
 * run here.
 */
import { describe, expect, it, jest } from '@jest/globals';
import cases from '../__fixtures__/emailDetectorCases.json';
import { emailSignals, looksLikeEmail } from '../emailTextDetector';

interface DetectorCase {
  name: string;
  text: string;
  expected: boolean;
  signals: string[];
  because: string;
}

const CASES = cases as DetectorCase[];

describe('the app detector answers what the backend detector answers', () => {
  it('has a case list worth running at all', () => {
    // A list that is all positives passes against `() => true`, and one that is
    // all negatives passes against `() => false`. Either is a parity fixture
    // that proves nothing about either detector. The backend suite asserts the
    // same thing; it is asserted again here because this suite can run when
    // that one has not, and a fixture is a file on disk that could be anything.
    const positives = CASES.filter((shared) => shared.expected).length;
    expect(positives).toBeGreaterThanOrEqual(5);
    expect(CASES.length - positives).toBeGreaterThanOrEqual(5);
    expect(new Set(CASES.map((shared) => shared.name)).size).toBe(CASES.length);
  });

  it.each(CASES.map((shared) => [shared.name, shared] as const))(
    'agrees on %s',
    (_name, shared) => {
      expect({
        answer: looksLikeEmail(shared.text),
        signals: emailSignals(shared.text),
      }).toEqual({
        answer: shared.expected,
        signals: shared.signals,
      });
    },
  );
});

describe('the detector is a pure predicate', () => {
  it('says no to nothing at all, whatever shape the nothing has', () => {
    for (const nothing of ['', '   ', '\n\n']) {
      expect(looksLikeEmail(nothing)).toBe(false);
    }
    expect(looksLikeEmail(undefined as unknown as string)).toBe(false);
    expect(looksLikeEmail(42 as unknown as string)).toBe(false);
  });

  it('gives the same answer twice for the same text', () => {
    // Every pattern in this module is built without the `g` flag, and that is
    // load-bearing: a global regex carries `lastIndex` between calls, so the
    // second `test` of the same string answers differently from the first. A
    // detector that changed its mind on a retry would route one share two ways.
    for (const shared of CASES) {
      expect(looksLikeEmail(shared.text)).toBe(looksLikeEmail(shared.text));
      expect(emailSignals(shared.text)).toEqual(emailSignals(shared.text));
    }
  });

  it('logs nothing, whatever it is handed', () => {
    // It is given whatever was on somebody's pasteboard. The rule
    // `clipboardImport.ts` lives by is the rule here.
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      jest.spyOn(console, level).mockImplementation(() => {}));
    try {
      for (const shared of CASES) emailSignals(shared.text);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
