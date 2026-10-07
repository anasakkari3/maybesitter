import { describe, expect, it } from '@jest/globals';
import {
  GOAL_PLAN_REASONS,
  GoalPlanRefusedError,
  NetworkError,
  PlanBuildRefusedError,
  QuotaExceededError,
  ValidationError,
} from '../../../api/errors';
import { strings, type Lang } from '../../../i18n/strings';
import { planBuildFailureOf, planFailureOf, recoveryLabel } from '../planFailures';
import { stepOutcome } from '../PlanFlow';

/**
 * Every way the plan path can stop has its own words and a way on (M3a
 * acceptance 6): never «في إشي عنا ما ردّ», which is what image 2 showed for
 * a reason the server knew.
 */

const LANGS: Lang[] = ['ar', 'en', 'he'];

describe('plan failures', () => {
  it.each(LANGS)('%s: every reason has its own sentence, never the generic server line, and named actions', (lang) => {
    const t = strings[lang];
    for (const reason of GOAL_PLAN_REASONS) {
      const failure = planFailureOf(new GoalPlanRefusedError(reason, 422), t)!;
      expect(failure.message).not.toBe(t.errorsServer);
      expect(failure.message.length).toBeGreaterThan(0);
      for (const recovery of failure.recoveries) expect(recoveryLabel(recovery, t).length).toBeGreaterThan(0);
      // Only the daily cap has nothing to do today.
      if (reason !== 'daily_cap_reached') expect(failure.recoveries.length).toBeGreaterThan(0);
    }
  });

  it('a thought goes to «عم تفكّر فيه», an appointment or a task to «احكيها»', () => {
    const t = strings.ar;
    const thought = planFailureOf(new GoalPlanRefusedError('not_a_goal', 422, { classification: 'thought' }), t)!;
    expect(thought.recoveries).toEqual(['thoughts']);
    expect(planFailureOf(new GoalPlanRefusedError('not_a_goal', 422, { classification: 'event' }), t)!.recoveries).toEqual(['capture']);
    const task = planFailureOf(new GoalPlanRefusedError('not_a_goal', 422, { classification: 'task' }), t)!;
    expect(task.recoveries).toEqual(['capture']);
    expect(task.message).toBe(t.xPlanFailTask);
  });

  it('a vague goal brings its question on its own line, and the answer action', () => {
    const failure = planFailureOf(new GoalPlanRefusedError('goal_too_vague', 422, { question: 'What would change?' }), strings.en)!;
    expect(failure.question).toBe('What would change?');
    expect(failure.recoveries).toEqual(['answer']);
  });

  it('no signal and the daily cap say so even without a typed refusal', () => {
    expect(planFailureOf(new NetworkError('offline'), strings.en)!.reason).toBe('offline');
    expect(planFailureOf(new QuotaExceededError('user_daily', 60, 'cap'), strings.en)!.recoveries).toEqual([]);
  });
});

describe('the day plan build («اعمل خطة اليوم»)', () => {
  it.each(LANGS)('%s: each known reason has its own words', (lang) => {
    const t = strings[lang];
    for (const reason of ['nothing_to_plan', 'model_unavailable', 'daily_cap_reached', 'offline', 'plan_unavailable']) {
      const said = planBuildFailureOf(new PlanBuildRefusedError(reason, true), t);
      expect(said).not.toBe(t.errorsServer);
      expect(said!.length).toBeGreaterThan(0);
    }
  });

  it('a typed refusal it does not own keeps the words it already had', () => {
    expect(planBuildFailureOf(new ValidationError('out of range', 'date_out_of_range'), strings.en)).toBe(strings.en.errorsValidation);
  });
});

describe('what the confirm will do with each step', () => {
  const base = { stepId: 's', kind: 'commitment' as const, alternatives: [] };
  it('a slot or a weekly time is saved; a later week waits; no room stays; no time and no reason is «بلا وقت», saved', () => {
    expect(stepOutcome({ ...base, slot: { startsAt: '2030-01-08T09:00:00.000Z', endsAt: '2030-01-08T09:30:00.000Z' } })).toBe('save');
    expect(stepOutcome({ ...base, kind: 'habit', weekly: { weekdays: [1], start: '09:00', end: '09:30' } })).toBe('save');
    expect(stepOutcome({ ...base, later: { weekIndex: 3 } })).toBe('later');
    expect(stepOutcome({ ...base, slot: null, reason: 'no_free_time_in_phase', choice: 'none' })).toBe('no_room');
    expect(stepOutcome({ ...base, slot: null, choice: 'none' })).toBe('save');
  });
});
