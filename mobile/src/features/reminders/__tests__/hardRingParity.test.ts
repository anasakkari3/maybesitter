import { describe, expect, it } from '@jest/globals';
import table from '../__fixtures__/hardRingParity.json';
import { planFor, type EscalationCeiling, type ReminderIntensity, type ReminderSettings } from '../policy';

/**
 * Whether a Must commitment is owed a ring, phone side (#198: council verdict B
 * on postponement, review B1 on the settings that switch it off).
 *
 * The cases are data shared with the server's test
 * (`tests/reminders/hardRingParity.test.ts`). Neither side has its own copy of
 * the rule, so the two cannot drift without one of these files going red.
 */
type Case = (typeof table.cases)[number] & {
  softEnabled?: boolean;
  intensity?: string;
  hardEnabled?: boolean;
  escalationCeiling?: string;
};

function settingsFor(c: Case): ReminderSettings {
  return {
    softEnabled: c.softEnabled ?? true,
    softLeadMinutes: 60,
    intensity: (c.intensity ?? 'softAwareness') as ReminderIntensity,
    escalationCeiling: (c.escalationCeiling ?? 'hard') as EscalationCeiling,
    hardEnabled: c.hardEnabled ?? true,
    mustThroughQuietHours: false,
  };
}

describe('the shared hard-ring table, on the phone', () => {
  it('has both outcomes and the cases asked for', () => {
    const cases = table.cases as Case[];
    expect(cases.length).toBeGreaterThanOrEqual(18);
    expect(cases.some(c => c.rings)).toBe(true);
    expect(cases.some(c => c.softEnabled === false && !c.rings)).toBe(true);
    expect(cases.some(c => c.intensity === 'none' && !c.rings)).toBe(true);
  });

  it.each((table.cases as Case[]).map(c => [c.name, c] as const))('%s', (_name, c) => {
    const strong = planFor({
      id: 'm1',
      startsAt: c.startsAt,
      status: 'active',
      priority: 'must',
      allDay: c.allDay,
      postponedUntil: c.postponedUntil,
    }, settingsFor(c)).find(stage => stage.stage === 'strong');
    expect({ rings: strong !== undefined, fireAt: strong ? new Date(strong.at).toISOString() : null })
      .toEqual({ rings: c.rings, fireAt: c.fireAt });
  });

  it('leaves the gentle stages alone under a postponement', () => {
    const c = (table.cases as Case[]).find(row => row.name === 'postponed until after the start itself')!;
    const stages = planFor({
      id: 'm1', startsAt: c.startsAt, status: 'active', priority: 'must', allDay: false, postponedUntil: c.postponedUntil,
    }, settingsFor(c)).map(stage => stage.stage);
    expect(stages).toEqual(['soft', 'followUp']);
  });
});
