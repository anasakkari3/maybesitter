import { describe, expect, it } from '@jest/globals';
import { prepRingAfterEdit, type PrepRingInput } from '../prepRing';

/**
 * What rings for a prep step edited in Review (FX1 re-review Minor 5), with
 * the phone's own planning. A meeting at 12:00 UTC; now is 08:00.
 */
const START = '2026-09-28T12:00:00.000Z';
const base: PrepRingInput = {
  at: '2026-09-28T11:00:00.000Z',
  meetingStart: START,
  priority: 'should',
  settings: { softEnabled: true, softLeadMinutes: 60, intensity: 'softAwareness', escalationCeiling: 'soft', hardEnabled: false, mustThroughQuietHours: false },
  quietHours: null,
  timeZone: 'UTC',
  now: new Date('2026-09-28T08:00:00.000Z'),
};

describe('the prep step as it will be confirmed', () => {
  it('moved to any time before the meeting, it rings at that time, whatever the lead', () => {
    for (const softLeadMinutes of [15, 30, 60]) {
      expect(prepRingAfterEdit({ ...base, at: '2026-09-28T11:30:00.000Z', settings: { ...base.settings, softLeadMinutes } }))
        .toEqual({ kind: 'rings', at: Date.parse('2026-09-28T11:30:00.000Z') });
    }
  });

  it('moved to the start or after it, it is an ordinary step: it rings a lead before', () => {
    expect(prepRingAfterEdit({ ...base, at: '2026-09-28T13:30:00.000Z' })).toEqual({ kind: 'rings', at: Date.parse('2026-09-28T12:30:00.000Z') });
  });

  it('with no time, nothing rings, and that is why', () => {
    expect(prepRingAfterEdit({ ...base, at: null })).toEqual({ kind: 'silent', because: 'no_time' });
  });

  it('says why nothing rings: reminders off, the silent choice, quiet hours, too close', () => {
    expect(prepRingAfterEdit({ ...base, settings: { ...base.settings, softEnabled: false } })).toEqual({ kind: 'silent', because: 'reminders_off' });
    expect(prepRingAfterEdit({ ...base, settings: { ...base.settings, intensity: 'none' } })).toEqual({ kind: 'silent', because: 'silent_choice' });
    expect(prepRingAfterEdit({ ...base, quietHours: { start: '10:00', end: '12:00' } })).toEqual({ kind: 'silent', because: 'quiet_hours' });
    expect(prepRingAfterEdit({ ...base, at: '2026-09-28T07:30:00.000Z' })).toEqual({ kind: 'silent', because: 'too_close' });
  });

  it('made a Must with quiet hours over its opening, it rings hard through them when the person allowed it', () => {
    const hard = { ...base.settings, intensity: 'strongReminder' as const, escalationCeiling: 'hard' as const, hardEnabled: true, mustThroughQuietHours: true };
    expect(prepRingAfterEdit({ ...base, at: '2026-09-28T11:55:00.000Z', priority: 'must', settings: hard, quietHours: { start: '11:00', end: '12:00' } }))
      .toEqual({ kind: 'rings', at: Date.parse('2026-09-28T11:55:00.000Z') });
  });
});
