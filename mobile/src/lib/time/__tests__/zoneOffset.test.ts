/**
 * Zone conversion on the engine the app actually runs on.
 *
 * The sibling suites for `postpone`, `localInstant` and `diffEdits` already
 * assert the right answers — and they pass on Node while the device saves the
 * wrong instant, because Node's `Intl` reports a zone offset as one part and
 * Hermes does not. These are the same assertions asked of Hermes' `Intl`.
 *
 * Observed on the 2026-09-14 product audit: "tomorrow morning" was stored as
 * 09:00Z for a UTC+3 user (noon, not morning), and a date-only edit of a 15:45
 * item saved 18:45Z (21:45 local).
 */
import { describe, expect, it } from '@jest/globals';
import { withHermesIntl } from '../../../testing/hermesIntl';
import { postponeTo } from '../../../features/commitments/postpone';
import { instantForLocalDateTime } from '../../../features/capture/localInstant';
import { instantFromLocalEdit } from '../../../features/capture/diffEdits';
import { offsetMinutes } from '../zoneOffset';

const HEBRON = 'Asia/Hebron';
const NEW_YORK = 'America/New_York';

describe('the zone offset', () => {
  it('is read from the clock, not from a formatted offset name', () => {
    const at = new Date('2026-09-15T09:00:00.000Z');
    expect(withHermesIntl(() => offsetMinutes(at, HEBRON))).toBe(180);
    expect(withHermesIntl(() => offsetMinutes(at, NEW_YORK))).toBe(-240);
  });

  it('follows the zone across a clock change', () => {
    // New York is -05:00 in January and -04:00 in July.
    expect(withHermesIntl(() => offsetMinutes(new Date('2026-01-15T12:00:00.000Z'), NEW_YORK)))
      .toBe(-300);
    expect(withHermesIntl(() => offsetMinutes(new Date('2026-07-15T12:00:00.000Z'), NEW_YORK)))
      .toBe(-240);
  });
});

describe('postponing on Hermes', () => {
  it('puts tomorrow morning at 09:00 where the user is, not 09:00 UTC', () => {
    const now = new Date('2026-09-14T01:37:05.504Z');
    expect(withHermesIntl(() => postponeTo('tomorrowMorning', now, HEBRON)))
      .toBe('2026-09-15T06:00:00.000Z');
  });

  it('puts this evening at 18:00 where the user is', () => {
    const now = new Date('2026-09-14T06:00:00.000Z');
    expect(withHermesIntl(() => postponeTo('thisEvening', now, HEBRON)))
      .toBe('2026-09-14T15:00:00.000Z');
  });
});

describe('editing a wall-clock time on Hermes', () => {
  it('resolves the typed time in the user zone', () => {
    expect(withHermesIntl(() => instantForLocalDateTime('2026-09-15T15:45', HEBRON))?.toISOString())
      .toBe('2026-09-15T12:45:00.000Z');
  });

  it('sends the edit as the instant the user meant', () => {
    expect(withHermesIntl(() => instantFromLocalEdit('2026-09-15T15:45', HEBRON)))
      .toBe('2026-09-15T12:45:00.000Z');
  });

  it('does not move the time when only the day changes', () => {
    const before = withHermesIntl(() => instantForLocalDateTime('2026-09-14T15:45', HEBRON));
    const after = withHermesIntl(() => instantForLocalDateTime('2026-09-15T15:45', HEBRON));
    const dayMs = 24 * 60 * 60 * 1000;
    expect(after!.getTime() - before!.getTime()).toBe(dayMs);
  });
});
