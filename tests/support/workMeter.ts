/**
 * Deterministic meters for tests that guard an *order of growth* (#380).
 *
 * Several tests in this suite defend an algorithmic property — "overlap
 * checking is not quadratic in spans", "the detector does not rescan the source
 * once per marker" — and defended it with a wall-clock budget:
 *
 * ```ts
 * const started = Date.now();
 * doTheWork();
 * assert.ok(Date.now() - started < 400, `took ${Date.now() - started} ms`);
 * ```
 *
 * A millisecond budget measures the machine at least as much as the code. It
 * passes on an idle laptop and fails when several suites share a box, which is
 * the worst shape a flake can take here: `npm test` is supposed to be
 * deterministic after #209, so red is supposed to mean a regression, and these
 * assertions quietly made that untrue exactly when parallel lanes make
 * attribution hardest.
 *
 * The meters below count *operations* instead. They are immune to load, and
 * they say something stronger than "under 400 ms on this machine": they say how
 * much work the algorithm did, per unit of input, so a bound written against
 * them is a statement about the growth curve rather than about a CPU.
 *
 * Two shapes are offered because the code under test takes two shapes of input.
 *
 *  - {@link metered} — for algorithms whose input is *data the test builds*
 *    (spans, steps, evidence nodes). Every field read is counted, so a pass
 *    that revisits the same span N times is visible as N reads.
 *  - {@link measureCharacterWork} — for algorithms whose input is a *string*.
 *    A primitive string cannot carry an accessor, so the meter counts the work
 *    the language does on its behalf: characters copied out by `slice` and
 *    pattern matches run by a `RegExp`. A scan that restarts at the beginning
 *    of the source once per marker shows up as quadratic character work, which
 *    is precisely the defect those tests exist to catch.
 *
 * Neither meter touches production code, and neither is a timer.
 */

import assert from 'node:assert/strict';

/** A running count of observed operations. */
export interface WorkMeter {
  count: number;
}

export function createWorkMeter(): WorkMeter {
  return { count: 0 };
}

/**
 * A structural copy of `record` whose own enumerable properties are counting
 * getters over the original values.
 *
 * The copy is still a plain object, still spreads, still `JSON.stringify`s, and
 * still satisfies the same `readonly` interface — the contract types in this
 * repository describe shapes, not classes — so production code cannot tell it
 * from the literal it replaces. What it cannot do is hide a re-read: reading
 * `span.start` twice costs two.
 *
 * Deliberately shallow. Nesting the meter would count a parent's read of a
 * child object and the child's own reads as separate events, which makes a
 * bound harder to reason about than the defect it is guarding.
 */
export function metered<T extends object>(record: T, meter: WorkMeter): T {
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    Object.defineProperty(copy, key, {
      enumerable: true,
      configurable: true,
      get() {
        meter.count += 1;
        return (record as Record<string, unknown>)[key];
      },
    });
  }
  return copy as T;
}

/** Character-level work done inside a measured call. */
export interface CharacterWork {
  /** Characters copied out of a string by `slice`. */
  readonly slicedCharacters: number;
  /** Pattern matches run — `RegExp.prototype.test` and `.exec`. */
  readonly patternTests: number;
  /** The two together: one number to write a bound against. */
  readonly total: number;
}

/**
 * Runs `work` with `String.prototype.slice`, `RegExp.prototype.test` and
 * `RegExp.prototype.exec` counting themselves, and restores them afterwards.
 *
 * Patching a builtin is heavy-handed and is done for one reason: a primitive
 * string cannot be proxied. Boxing it does not help either — `RegExp.exec` and
 * every string method unbox their argument immediately, so an accessor would
 * see one read and miss the whole scan. These three are where a text algorithm
 * actually spends itself, so counting them measures the scan.
 *
 * The patch is installed and removed around a single call, in a `finally`, so a
 * throwing subject cannot leak it into the rest of the file.
 */
export function measureCharacterWork<T>(work: () => T): { value: T; work: CharacterWork } {
  const nativeSlice = String.prototype.slice;
  const nativeTest = RegExp.prototype.test;
  const nativeExec = RegExp.prototype.exec;
  let slicedCharacters = 0;
  let patternTests = 0;

  String.prototype.slice = function countingSlice(this: string, start?: number, end?: number): string {
    const out = nativeSlice.call(this, start as number, end as number);
    slicedCharacters += out.length;
    return out;
  };
  RegExp.prototype.test = function countingTest(this: RegExp, value: string): boolean {
    patternTests += 1;
    return nativeTest.call(this, value);
  };
  RegExp.prototype.exec = function countingExec(this: RegExp, value: string): RegExpExecArray | null {
    patternTests += 1;
    return nativeExec.call(this, value);
  };

  try {
    const value = work();
    return { value, work: { slicedCharacters, patternTests, total: slicedCharacters + patternTests } };
  } finally {
    String.prototype.slice = nativeSlice;
    RegExp.prototype.test = nativeTest;
    RegExp.prototype.exec = nativeExec;
  }
}

/**
 * Runs `work` at `size` and at `2 * size` and asserts the second cost no more
 * than `tolerance` times the first.
 *
 * This is the load-immune replacement for "it finished in under 400 ms". A
 * linear pass doubles when the input doubles; a quadratic one quadruples. A
 * tolerance between the two separates them, and it separates them the same way
 * on an idle laptop and on a box running thirty other things, because nothing
 * here reads a clock.
 *
 * Both sizes are measured after a warm-up call at `size`, so the comparison is
 * between two warm runs rather than between a cold one and a warm one. That
 * matters even for a counter: a first call can take a different branch through
 * lazily-built module state.
 */
export function assertGrowsLinearly(
  work: (size: number) => number,
  options: { readonly size: number; readonly what: string; readonly tolerance?: number },
): void {
  const { size, what, tolerance = 2.5 } = options;
  work(size);
  const small = work(size);
  const large = work(size * 2);
  assert.ok(
    small > 0,
    `${what}: the measurement at ${size} counted no work at all, so the comparison below is between two empty runs`,
  );
  const factor = large / small;
  assert.ok(
    factor <= tolerance,
    `${what}: doubling the input from ${size} to ${size * 2} multiplied the work by `
      + `${factor.toFixed(2)} (${small} -> ${large}); linear is 2, quadratic is 4`,
  );
}
