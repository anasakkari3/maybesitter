/**
 * The suite runs in a known zone (#413).
 *
 * The mobile mirror of the backend's `the zone is pinned` in
 * `tests/support/isolation.test.ts`. `mobile/`'s Jest config did not pin `TZ`
 * while the backend's did, so a zone-dependent test could be green on every
 * developer's machine and red in CI, and the only place anyone found out was a
 * PR. #413 measured exactly that: one test, green under five real zones,
 * red under UTC — the one zone CI runs.
 *
 * Asserting the variable alone would not be enough. Jest sets up its own
 * environment per worker, and a pin that is written but never applied to the
 * runtime is the same as no pin at all, so the offsets below ask the clock
 * rather than the configuration.
 */
import { describe, expect, it } from '@jest/globals';

const ZONE = process.env.MAYBESITTER_TEST_TZ || 'UTC';

/**
 * The offset `getTimezoneOffset()` would report at `at` in `zone`, worked out
 * from `Intl` with the zone named explicitly — so it does not depend on the
 * zone the runtime happens to be in, which is the thing under test.
 */
function expectedOffset(zone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  const wallClockAsUtc = Date.UTC(
    part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'),
  );
  return (at.getTime() - wallClockAsUtc) / 60_000;
}

describe('the zone this suite runs in', () => {
  it('is pinned, so a machine and CI are running the same test', () => {
    expect(process.env.TZ).toBe(ZONE);
  });

  it('is applied to the runtime, not merely written into the environment', () => {
    // Asked of whichever zone is in effect — the UTC pin, or the second zone
    // CI runs the suite under (`MAYBESITTER_TEST_TZ`). This used to return
    // early under the override, so a second-zone run whose zone never reached
    // the runtime would have run the whole suite in UTC again and passed:
    // twice the minutes for the same answer. A zone name `Intl` does not know
    // throws here instead of quietly falling back to UTC.
    //
    // Both halves of the year are asserted because a host zone that happens to
    // match in winter — Europe/London against UTC, say — would satisfy the
    // January check alone and still shift the suite by an hour in July. A pin
    // that only holds outside DST is the failure mode this test exists for.
    for (const at of [new Date('2026-01-01T12:00:00Z'), new Date('2026-07-01T12:00:00Z')]) {
      expect(at.getTimezoneOffset()).toBe(expectedOffset(ZONE, at));
    }
    if (ZONE === 'UTC') {
      expect(new Date('2026-01-01T12:00:00Z').getTimezoneOffset()).toBe(0);
      expect(new Date('2026-07-01T12:00:00Z').getTimezoneOffset()).toBe(0);
    }

    // And the formatter agrees with the clock: `Intl` reads the zone
    // separately from `Date`'s offset, and this app formats every time through
    // it. Hermes has disagreed with Node about `Intl` in this repo before.
    // Compared through `Intl` itself because it canonicalises some names
    // (`Asia/Kolkata` resolves as `Asia/Calcutta` here).
    expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(
      new Intl.DateTimeFormat('en-US', { timeZone: ZONE }).resolvedOptions().timeZone,
    );
  });
});
