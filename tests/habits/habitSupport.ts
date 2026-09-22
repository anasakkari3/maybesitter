/**
 * Shared fixtures for the #520 habit tests.
 *
 * Every date here is chosen and named, never "some Monday": the DST tests
 * depend on which week they land in, and a fixture nobody can read is how a
 * transition test quietly stops crossing a transition.
 */
import {
  applyHabitPatch,
  buildHabitDefinition,
  type HabitDefinition,
  type HabitDefinitionInput,
  type HabitStatus,
} from '../../src/contracts/v1/habitContracts.ts';

export const NOW = '2026-03-01T09:00:00.000Z';
export const SCOPE = 'habitOwner';

/** A Monday. The four weeks from here to 2026-03-29 (a Sunday) are whole. */
export const MARCH_MONDAY = '2026-03-02';
export const MARCH_SUNDAY = '2026-03-29';

/** North American spring-forward, a Sunday inside the horizon above. */
export const US_SPRING_FORWARD = '2026-03-08';
/** European spring-forward — the last day of the same horizon. */
export const EU_SPRING_FORWARD = '2026-03-29';
/** North American fall-back, where a local day is 25 hours long. */
export const US_FALL_BACK = '2026-11-01';

export function habitInput(overrides: Partial<HabitDefinitionInput> = {}): HabitDefinitionInput {
  return {
    scopeId: SCOPE,
    title: 'Gym',
    cadence: { kind: 'weekly_count', count: 3 },
    durationMinutes: 60,
    preferredWindows: [{ start: '18:00', end: '21:00' }],
    minimumOccurrences: 3,
    maximumOccurrences: 3,
    flexibility: 'flexible',
    recoveryPolicy: 'recover_within_period',
    source: 'user_created',
    confirmation: { confirmedByUserAt: NOW, sourceRef: null, acceptedSuggestedValues: false },
    ...overrides,
  };
}

export function habit(overrides: Partial<HabitDefinitionInput> = {}, habitId = 'habit-1'): HabitDefinition {
  return buildHabitDefinition(habitId, habitInput(overrides), NOW);
}

/** Pause or archive through the real patch path, never by hand-building one. */
export function withStatus(definition: HabitDefinition, status: HabitStatus): HabitDefinition {
  return applyHabitPatch(definition, { status }, '2026-03-05T09:00:00.000Z');
}
