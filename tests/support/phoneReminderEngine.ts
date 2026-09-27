/**
 * The phone's reminder engine, loaded as it ships, for server tests that have
 * to check a claim against what the phone will actually ring (CL5a I-3).
 *
 * The server decides when a meeting's prep step is reminded; only the phone
 * rings (`mobile/src/features/reminders/softAwarenessEngine.ts`). A server test
 * that compared the claim to its own model of the phone would prove nothing, so
 * these run the phone's `desiredRequests` itself.
 *
 * Loaded by a computed specifier on purpose: a static import would put the
 * mobile modules — and, through `awarenessStore`, React Native's global types —
 * into the root `tsc` program, which excludes `mobile/` and targets ES5. The
 * shapes below are the few fields these tests touch.
 */

export interface PhoneReminderCommitment {
  readonly id: string;
  readonly startsAt: string | null;
  readonly status: string;
  readonly priority: 'must' | 'should' | 'nice';
  readonly allDay: boolean;
  readonly postponedUntil: string | null;
}

export interface PhoneReminderSettings {
  readonly softEnabled: boolean;
  readonly softLeadMinutes: number;
  readonly intensity: 'none' | 'softAwareness' | 'followUp' | 'strongReminder';
  readonly escalationCeiling: 'soft' | 'followUp' | 'hard';
  readonly hardEnabled: boolean;
  readonly mustThroughQuietHours: boolean;
}

export interface PhoneReminderEngine {
  /** Every ring the phone would schedule, earliest first, in epoch ms. */
  ringsFor(input: {
    commitments: readonly PhoneReminderCommitment[];
    now: Date;
    settings: PhoneReminderSettings;
    quietHours: { start: string; end: string } | null;
    timeZone: string;
  }): number[];
  /** `toReminderCommitments`, on commitments as the list routes return them. */
  toReminderCommitments(items: readonly unknown[]): PhoneReminderCommitment[];
  /** `toEngineSettings`, `quietWindowOf` and `quietTimeZone`, on the settings route's DTO. */
  fromSettingsDto(dto: unknown, intensity: PhoneReminderSettings['intensity']): {
    settings: PhoneReminderSettings;
    quietHours: { start: string; end: string } | null;
    timeZone: string;
  };
}

let loaded: Promise<PhoneReminderEngine> | null = null;

async function load(): Promise<PhoneReminderEngine> {
  const base = new URL('../../mobile/src/', import.meta.url);
  const specifier = (path: string) => new URL(path, base).href;
  const [engine, inputs, awareness] = await Promise.all([
    import(specifier('features/reminders/softAwarenessEngine.ts')),
    import(specifier('features/reminders/reminderInputs.ts')),
    import(specifier('lib/deviceSettings/awarenessStore.ts')),
  ]);
  return {
    ringsFor(input) {
      const { desired } = engine.desiredRequests({
        ...input,
        awareness: awareness.EMPTY_AWARENESS,
        copy: { title: '', body: '' },
        hardCopy: { title: '', body: '' },
        exactAlarms: true,
      }) as { desired: Array<{ at: number }> };
      return desired.map((request) => request.at).sort((left, right) => left - right);
    },
    toReminderCommitments: (items) => inputs.toReminderCommitments(items),
    fromSettingsDto: (dto, intensity) => ({
      settings: inputs.toEngineSettings(dto, intensity),
      quietHours: inputs.quietWindowOf(dto),
      timeZone: inputs.quietTimeZone(dto),
    }),
  };
}

export function phoneReminderEngine(): Promise<PhoneReminderEngine> {
  loaded ??= load();
  return loaded;
}
