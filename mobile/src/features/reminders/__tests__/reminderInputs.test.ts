import { describe, expect, it, jest } from '@jest/globals';
import { getCalendars } from 'expo-localization';
import { deviceTimeZone } from '../../../i18n/timezone';
import {
  mergeById,
  quietTimeZone,
  quietWindowOf,
  startOf,
  toEngineSettings,
  toReminderCommitments,
} from '../reminderInputs';
import { desiredRequests } from '../softAwarenessEngine';
import { withHermesIntl } from '../../../testing/hermesIntl';
import { EMPTY_AWARENESS } from '../../../lib/deviceSettings/awarenessStore';
import type { ReminderSettingsDto } from '../../../api/schemas/reminders';
import type { Commitment } from '../../../api/schemas/common';
import settingsFixture from '../../../api/__fixtures__/reminders.settingsSaved.json';
import commitmentFixture from '../../../api/__fixtures__/commitments.one.json';

// The phone is in Berlin. Every zone the server sends in this file is
// Asia/Jerusalem, so an implementation that reached for the device's zone is
// visible rather than coincidentally equal.
jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Europe/Berlin' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

/**
 * The read path for quiet hours (UC-3.11, #196).
 *
 * The write path — the settings screen choosing which zone to *send* — is
 * covered in `features/settings/__tests__/reminderSettings.test.tsx`. This is
 * the other half, and it was the half with no assertion at all: swapping
 * `quietTimeZone` from the profile's zone to the device's left the whole mobile
 * suite green.
 *
 * It matters because the phone and the server have to agree. The device
 * schedules the local reminder and `lib/push/quietHours.ts` decides whether to
 * push, both from the same window; if the phone read that window in Berlin
 * while the server read it in Tel Aviv, one of them would be speaking during
 * the hours the other was silent, and the user would see a reminder arrive at
 * an hour they had explicitly forbidden.
 */

const dto = (overrides: Partial<ReminderSettingsDto> = {}): ReminderSettingsDto =>
  ({ ...settingsFixture.reminderSettings, ...overrides }) as ReminderSettingsDto;

describe('the zone a quiet window is read in', () => {
  it('is the profile s, not the phone s', () => {
    expect(deviceTimeZone()).toBe('Europe/Berlin');
    expect(quietTimeZone(dto())).toBe('Asia/Jerusalem');
    expect(quietTimeZone(dto())).not.toBe(deviceTimeZone());
  });

  it('follows the window when the account has since been read in another zone', () => {
    // The traveller. The window was answered in Tel Aviv and still means Tel
    // Aviv; the server says so on the window itself, and this must not second
    // guess it from the handset.
    const travelling = dto({ quietHours: { start: '22:00', end: '07:00', timezone: 'Pacific/Chatham' } });
    expect(quietTimeZone(travelling)).toBe('Pacific/Chatham');
  });

  it('reaches the engine, so a stage is deferred on the profile s clock', () => {
    withHermesIntl(() => {
      /*
       * The two zones are separated by *outcome*, not by an hour.
       *
       * In September Jerusalem is UTC+3, so 22:00–07:00 there is 19:00 → 04:00
       * UTC. Berlin is UTC+2, so the same window is 20:00 → 05:00 UTC.
       *
       * A commitment at 04:20 UTC puts its 30-minute stage at 03:50 UTC, which
       * is inside both windows. Jerusalem's window ends at 04:00 UTC, fifteen
       * minutes clear of the start, so the stage is **deferred** to 04:00.
       * Berlin's ends at 05:00 UTC, *after* the commitment has begun, so the
       * stage is **dropped** entirely. Reading the phone's zone would not move
       * the reminder — it would delete it.
       */
      const now = new Date('2026-09-15T20:00:00.000Z');
      const settings = dto();
      const commitment: Commitment = {
        ...(commitmentFixture as unknown as Commitment),
        timeSpec: {
          ...(commitmentFixture as unknown as Commitment).timeSpec,
          dueAt: '2026-09-16T04:20:00.000Z',
        },
      };
      const input = {
        commitments: toReminderCommitments([commitment]),
        now,
        settings: toEngineSettings(settings, 'softAwareness' as const),
        quietHours: quietWindowOf(settings),
        awareness: EMPTY_AWARENESS,
        copy: { title: 't', body: 'b' },
        hardCopy: { title: 'T', body: 'B' },
        exactAlarms: true,
      };

      const onTheProfilesClock = desiredRequests({ ...input, timeZone: quietTimeZone(settings) });
      expect(onTheProfilesClock.desired).toHaveLength(1);
      expect(new Date(onTheProfilesClock.desired[0]!.at).toISOString()).toBe('2026-09-16T04:00:00.000Z');
      expect(onTheProfilesClock.droppedForQuietHours).toEqual([]);

      // And the same input read on the handset's clock, which is what the
      // mutation of `quietTimeZone` does.
      const onThePhonesClock = desiredRequests({ ...input, timeZone: deviceTimeZone() });
      expect(onThePhonesClock.desired).toEqual([]);
      expect(onThePhonesClock.droppedForQuietHours).toHaveLength(1);
    });
  });

  it('is the same string the server publishes beside the window', () => {
    // The DTO mirrors the profile's zone into both places, so the two are
    // always equal. Asserted rather than assumed: if the route ever stops
    // mirroring them, the phone and the server would silently disagree about
    // which clock the window is on, and this is the only place that would say so.
    const settings = dto();
    expect(settings.quietHours?.timezone).toBe(settings.timezone);
  });
});

describe('what the engine is given about a commitment', () => {
  it('carries an id, an instant, a status and a priority, and no words', () => {
    const [narrowed] = toReminderCommitments([commitmentFixture as unknown as Commitment]);
    expect(Object.keys(narrowed!).sort()).toEqual(['id', 'priority', 'startsAt', 'status']);
    expect(JSON.stringify(narrowed)).not.toContain('dentist');
  });

  it('reads the start from dueAt rather than the reminder the server derived', () => {
    // `remindAt` already has a lead applied. Scheduling a stage relative to it
    // would apply the lead twice and fire an hour early.
    const commitment = commitmentFixture as unknown as Commitment;
    expect(startOf(commitment)).toBe(commitment.timeSpec.dueAt);
  });

  it('keeps one copy of a commitment that is in both Today and Upcoming', () => {
    const commitment = commitmentFixture as unknown as Commitment;
    expect(mergeById([commitment], [commitment])).toHaveLength(1);
  });

  it('reads Must, Should and Nice exactly as the cards do', () => {
    const base = commitmentFixture as unknown as Commitment;
    const at = (level: string) => toReminderCommitments([
      { ...base, priority: { ...base.priority, level } } as unknown as Commitment,
    ])[0]!.priority;
    expect(at('high')).toBe('must');
    expect(at('medium')).toBe('should');
    expect(at('low')).toBe('nice');
    // A level this build does not know is not Must — it cannot ring.
    expect(at('urgent')).toBe('should');
  });

  it('answers with no window when the account has none', () => {
    expect(quietWindowOf(dto({ quietHours: null }))).toBeNull();
  });
});

describe('the mock the rest of this file leans on', () => {
  it('is the one the device timezone actually reads', () => {
    // If `getCalendars` were not the source, the first test's inequality would
    // hold for the wrong reason and prove nothing.
    expect(getCalendars).toHaveBeenCalled();
  });
});

describe('the Must-reminder settings the engine is given (#197)', () => {
  // What a server from before #197 answers: the same response, minus the three.
  const legacyShape: ReminderSettingsDto = { ...dto() };
  delete legacyShape.hardEnabled;
  delete legacyShape.escalationCeiling;
  delete legacyShape.mustThroughQuietHours;

  it('takes the server s answer when it sends one, whatever the survey said', () => {
    const settings = toEngineSettings(
      { ...dto(), hardEnabled: false, escalationCeiling: 'followUp', mustThroughQuietHours: true },
      'strongReminder',
    );
    expect(settings).toMatchObject({ hardEnabled: false, escalationCeiling: 'followUp', mustThroughQuietHours: true });
  });

  it('maps an older server s silence through the survey, the way the server does', () => {
    expect(toEngineSettings(legacyShape, 'strongReminder'))
      .toMatchObject({ hardEnabled: true, escalationCeiling: 'hard', mustThroughQuietHours: false });
    expect(toEngineSettings(legacyShape, 'followUp'))
      .toMatchObject({ hardEnabled: false, escalationCeiling: 'followUp', mustThroughQuietHours: false });
    expect(toEngineSettings(legacyShape, 'softAwareness'))
      .toMatchObject({ hardEnabled: false, escalationCeiling: 'soft', mustThroughQuietHours: false });
    expect(toEngineSettings(legacyShape, 'none'))
      .toMatchObject({ hardEnabled: false, escalationCeiling: 'soft', mustThroughQuietHours: false });
  });
});
