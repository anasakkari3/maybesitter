import { describe, expect, it } from '@jest/globals';
import {
  FOLLOW_UP_LEAD_MINUTES,
  MAX_PENDING_REQUESTS,
  STRONG_LEAD_MINUTES,
  legacyEscalation,
  parseRequestIdentifier,
  planFor,
  requestIdentifier,
  stagesFor,
  type EscalationCeiling,
  type ReminderCommitment,
  type ReminderIntensity,
  type ReminderPriority,
  type ReminderSettings,
} from '../policy';

/**
 * The stage ladder (UC-3.11, #196).
 *
 * Every case is expressed as *minutes before the start*, computed from the
 * start the case itself supplies. No date literal appears in an assertion:
 * #382's timezone defect passed because a literal happened to match the host,
 * and a literal here would go stale the same way.
 */

const START = Date.parse('2026-09-15T12:00:00.000Z');

function commitment(overrides: Partial<ReminderCommitment> = {}): ReminderCommitment {
  return { id: 'c1', startsAt: new Date(START).toISOString(), status: 'active', priority: 'must', ...overrides };
}

/**
 * The settings an account had before #197, derived from the survey answer the
 * way the server and `toEngineSettings` derive them — so the #196 cases below
 * keep testing what #196 shipped.
 */
function settings(overrides: Partial<ReminderSettings> = {}): ReminderSettings {
  const intensity: ReminderIntensity = overrides.intensity ?? 'softAwareness';
  return {
    softEnabled: true,
    softLeadMinutes: 60,
    intensity,
    ...legacyEscalation(intensity),
    mustThroughQuietHours: false,
    ...overrides,
  };
}

/** What `planFor` produced, as `[stage, minutes before the start]` pairs. */
function leads(planned: ReturnType<typeof planFor>): [string, number][] {
  return planned.map(stage => [stage.stage, Math.round((START - stage.at) / 60_000)]);
}

describe('which stages an account gets', () => {
  it('follows the survey answer for an account that never set a ceiling', () => {
    // `settings()` derives the ceiling from the answer, as the server does.
    expect(stagesFor(settings({ intensity: 'none' }), 'must')).toEqual([]);
    expect(stagesFor(settings({ intensity: 'softAwareness' }), 'must')).toEqual(['soft']);
    expect(stagesFor(settings({ intensity: 'followUp' }), 'must')).toEqual(['soft', 'followUp']);
    // The old strong answer was Flutter's opt-in, and #197 maps it to one.
    expect(stagesFor(settings({ intensity: 'strongReminder' }), 'must')).toEqual(['soft', 'followUp', 'strong']);
    expect(stagesFor(settings({ intensity: 'strongReminder' }), 'should')).toEqual(['soft', 'followUp']);
  });

  it('gets nothing at all when the switch is off, whatever the survey or the ceiling said', () => {
    expect(stagesFor(settings({ softEnabled: false, intensity: 'strongReminder' }), 'must')).toEqual([]);
    expect(stagesFor(settings({ softEnabled: false, escalationCeiling: 'hard', hardEnabled: true }), 'must')).toEqual([]);
    expect(planFor(commitment(), settings({ softEnabled: false }))).toEqual([]);
  });
});

/*
 * ── The Must stage (UC-3.12a, #197) ─────────────────────────────
 *
 * The whole matrix, priority × ceiling × opt-in, rather than the three cases
 * that come to mind: the property is "strong only when all three hold", and a
 * partial table is how an `||` survives where an `&&` belongs.
 */
describe('the Must stage', () => {
  const PRIORITIES: ReminderPriority[] = ['must', 'should', 'nice'];
  const CEILINGS: EscalationCeiling[] = ['soft', 'followUp', 'hard'];

  it('is scheduled only for a Must commitment, with the opt-in, at the hard ceiling', () => {
    for (const priority of PRIORITIES) {
      for (const escalationCeiling of CEILINGS) {
        for (const hardEnabled of [false, true]) {
          const stages = planFor(commitment({ priority }), settings({ escalationCeiling, hardEnabled }))
            .map(stage => stage.stage);
          const expected = ['soft'];
          if (escalationCeiling !== 'soft') expected.push('followUp');
          if (priority === 'must' && hardEnabled && escalationCeiling === 'hard') expected.push('strong');
          expect({ priority, escalationCeiling, hardEnabled, stages })
            .toEqual({ priority, escalationCeiling, hardEnabled, stages: expected });
        }
      }
    }
  });

  it('never comes with default settings', () => {
    // A fresh account: soft on, no survey, the defaults the server sends.
    expect(planFor(commitment(), settings()).map(stage => stage.stage)).toEqual(['soft']);
  });

  it('gives Must soft plus strong at "Ring for Must items", and Should and Nice never strong', () => {
    const ring = settings({ escalationCeiling: 'hard', hardEnabled: true });
    expect(leads(planFor(commitment({ priority: 'must' }), ring))).toEqual([
      ['soft', 60],
      ['followUp', FOLLOW_UP_LEAD_MINUTES],
      ['strong', STRONG_LEAD_MINUTES],
    ]);
    for (const priority of ['should', 'nice'] as const) {
      expect(planFor(commitment({ priority }), ring).some(stage => stage.stage === 'strong')).toBe(false);
    }
  });

  it('rings ten minutes before, under every soft lead', () => {
    for (const softLeadMinutes of [60, 30, 15]) {
      const planned = planFor(commitment(), settings({ softLeadMinutes, escalationCeiling: 'hard', hardEnabled: true }));
      expect(leads(planned).find(([stage]) => stage === 'strong')).toEqual(['strong', 10]);
    }
  });

  it('stays silent when the survey says none, even with the opt-in', () => {
    expect(planFor(commitment(), settings({ intensity: 'none', escalationCeiling: 'hard', hardEnabled: true })))
      .toEqual([]);
  });
});

describe('the survey answer before #197 gave it controls', () => {
  it('maps the old strong preference to hard reminders on', () => {
    expect(legacyEscalation('strongReminder')).toEqual({ escalationCeiling: 'hard', hardEnabled: true });
  });

  it('keeps the follow-up for followUp and is the gentlest for anything else', () => {
    expect(legacyEscalation('followUp')).toEqual({ escalationCeiling: 'followUp', hardEnabled: false });
    expect(legacyEscalation('softAwareness')).toEqual({ escalationCeiling: 'soft', hardEnabled: false });
    expect(legacyEscalation('none')).toEqual({ escalationCeiling: 'soft', hardEnabled: false });
  });
});

describe('when each stage fires', () => {
  it('puts the soft stage at the lead the user chose', () => {
    for (const softLeadMinutes of [60, 30, 15]) {
      expect(leads(planFor(commitment(), settings({ softLeadMinutes })))).toEqual([['soft', softLeadMinutes]]);
    }
  });

  it('puts the follow-up half an hour out, in fire order', () => {
    expect(leads(planFor(commitment(), settings({ intensity: 'followUp' })))).toEqual([
      ['soft', 60],
      ['followUp', FOLLOW_UP_LEAD_MINUTES],
    ]);
  });

  it('drops a follow-up that would arrive before the gentle one', () => {
    // A 15-minute soft lead with a 30-minute follow-up would fire the firmer
    // reminder first and the gentle one afterwards, which reads backwards.
    expect(leads(planFor(commitment(), settings({ intensity: 'followUp', softLeadMinutes: 15 })))).toEqual([
      ['soft', 15],
    ]);
    // And at exactly 30 the two would land on the same instant.
    expect(leads(planFor(commitment(), settings({ intensity: 'followUp', softLeadMinutes: 30 })))).toEqual([
      ['soft', 30],
    ]);
  });
});

describe('what earns no reminder', () => {
  it.each([
    ['no time', commitment({ startsAt: null })],
    ['an unparseable time', commitment({ startsAt: 'sometime next week' })],
    ['already done', commitment({ status: 'done' })],
    ['dropped on purpose', commitment({ status: 'dropped' })],
  ])('%s', (_name, item) => {
    expect(planFor(item, settings({ intensity: 'followUp' }))).toEqual([]);
  });
});

describe('identifiers', () => {
  it('round-trip, and a commitment id may contain a colon', () => {
    const id = 'plan:fixture:0';
    expect(parseRequestIdentifier(requestIdentifier(id, 'followUp'))).toEqual({
      commitmentId: id,
      stage: 'followUp',
    });
  });

  it('refuses anything that is not one of ours', () => {
    // #197 and #199 schedule their own requests, and the engine cancels only
    // what parses here. A loose parser would delete theirs on its next run.
    for (const identifier of ['c1', 'c1:loud', ':soft', 'c1:soft:extra', 'must-reminder-7']) {
      expect({ identifier, parsed: parseRequestIdentifier(identifier) })
        .toEqual({ identifier, parsed: null });
    }
  });

  it('caps below the platform limit with room for another feature', () => {
    // iOS keeps 64 pending requests and silently discards the rest.
    expect(MAX_PENDING_REQUESTS).toBeLessThan(64);
  });
});
