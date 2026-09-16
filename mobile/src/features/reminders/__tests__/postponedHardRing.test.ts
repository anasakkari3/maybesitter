import { describe, expect, it } from '@jest/globals';
import table from '../__fixtures__/postponedHardRing.json';
import { planFor, type ReminderSettings } from '../policy';

/**
 * Postponed Must commitments, phone side (council verdict B, #198).
 *
 * The cases are data shared with the server's test
 * (`tests/reminders/postponedHardRing.test.ts`). Neither side has its own copy
 * of what a postponement means, so the two cannot drift without one of these
 * files going red.
 */
const RING: ReminderSettings = {
  softEnabled: true,
  softLeadMinutes: 60,
  intensity: 'softAwareness',
  escalationCeiling: 'hard',
  hardEnabled: true,
  mustThroughQuietHours: false,
};

describe('the shared postponement table, on the phone', () => {
  it('has the cases the council asked for', () => {
    expect(table.cases.length).toBeGreaterThanOrEqual(10);
    expect(table.cases.some(c => c.rings)).toBe(true);
    expect(table.cases.some(c => !c.rings)).toBe(true);
  });

  it.each(table.cases.map(c => [c.name, c] as const))('%s', (_name, c) => {
    const strong = planFor({
      id: 'm1',
      startsAt: c.startsAt,
      status: 'active',
      priority: 'must',
      allDay: c.allDay,
      postponedUntil: c.postponedUntil,
    }, RING).find(stage => stage.stage === 'strong');
    expect({ rings: strong !== undefined, fireAt: strong ? new Date(strong.at).toISOString() : null })
      .toEqual({ rings: c.rings, fireAt: c.fireAt });
  });

  it('leaves the gentle stages alone', () => {
    const postponedPastEverything = table.cases.find(c => c.name === 'postponed until after the start itself')!;
    const stages = planFor({
      id: 'm1', startsAt: postponedPastEverything.startsAt, status: 'active', priority: 'must',
      allDay: false, postponedUntil: postponedPastEverything.postponedUntil,
    }, RING).map(stage => stage.stage);
    expect(stages).toEqual(['soft', 'followUp']);
  });
});
