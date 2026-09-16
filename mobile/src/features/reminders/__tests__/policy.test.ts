import { describe, expect, it } from '@jest/globals';
import {
  FOLLOW_UP_LEAD_MINUTES,
  MAX_PENDING_REQUESTS,
  parseRequestIdentifier,
  planFor,
  requestIdentifier,
  stagesFor,
  type ReminderCommitment,
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
  return { id: 'c1', startsAt: new Date(START).toISOString(), status: 'active', ...overrides };
}

function settings(overrides: Partial<ReminderSettings> = {}): ReminderSettings {
  return { softEnabled: true, softLeadMinutes: 60, intensity: 'softAwareness', ...overrides };
}

/** What `planFor` produced, as `[stage, minutes before the start]` pairs. */
function leads(planned: ReturnType<typeof planFor>): [string, number][] {
  return planned.map(stage => [stage.stage, Math.round((START - stage.at) / 60_000)]);
}

describe('which stages an account gets', () => {
  it('follows the reminder intensity from the routine survey', () => {
    expect(stagesFor(settings({ intensity: 'none' }))).toEqual([]);
    expect(stagesFor(settings({ intensity: 'softAwareness' }))).toEqual(['soft']);
    expect(stagesFor(settings({ intensity: 'followUp' }))).toEqual(['soft', 'followUp']);
    // `strong` belongs to UC-3.12a (#197): it wants a HIGH-importance channel
    // and an exact alarm, and neither exists yet. Scheduling it from here would
    // put a Must reminder on the gentle channel.
    expect(stagesFor(settings({ intensity: 'strongReminder' }))).toEqual(['soft', 'followUp']);
  });

  it('gets nothing at all when the switch is off, whatever the survey said', () => {
    expect(stagesFor(settings({ softEnabled: false, intensity: 'strongReminder' }))).toEqual([]);
    expect(planFor(commitment(), settings({ softEnabled: false }))).toEqual([]);
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
