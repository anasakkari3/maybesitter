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

describe('the zone this suite runs in', () => {
  it('is pinned, so a machine and CI are running the same test', () => {
    expect(process.env.TZ).toBe(process.env.MAYBESITTER_TEST_TZ || 'UTC');
  });

  it('is applied to the runtime, not merely written into the environment', () => {
    if (process.env.MAYBESITTER_TEST_TZ) return; // deliberately run under another zone

    // UTC has no offset, in either half of the year. Both are asserted because
    // a host zone that happens to sit at +00:00 in winter — Europe/London,
    // Africa/Abidjan's neighbours, Atlantic/Reykjavik — would satisfy the
    // January check alone and still shift the suite by an hour in July. A pin
    // that only holds outside DST is the failure mode this test exists for.
    expect(new Date('2026-01-01T12:00:00Z').getTimezoneOffset()).toBe(0);
    expect(new Date('2026-07-01T12:00:00Z').getTimezoneOffset()).toBe(0);

    // And the formatter agrees with the clock: `Intl` reads the zone
    // separately from `Date`'s offset, and this app formats every time through
    // it. Hermes has disagreed with Node about `Intl` in this repo before.
    expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('UTC');
  });
});
