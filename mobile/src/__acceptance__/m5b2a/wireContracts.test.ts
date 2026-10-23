import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { intelligenceInboxSchema } from '../../api/schemas/intelligence';
import { planResponseSchema } from '../../api/schemas/plan';
import { strings } from '../../i18n/strings';
import { NOW, inbox, outcome, planEnvelope, planWithBasis } from './harness';

const ZONE = 'Asia/Jerusalem';

beforeEach(() => {
  process.env.TZ = ZONE;
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('M5b-2a wire and copy-key contracts', () => {
  it('R1 preserves the optional outcome signal and isolated source title through the real inbox schema', () => {
    const parsed = intelligenceInboxSchema.parse(inbox([outcome('wire', 'dropped')]));
    const observation = parsed.observations[0] as unknown as Record<string, unknown>;
    expect(observation.outcome).toEqual({ signal: 'dropped', title: 'Title wire' });
  });

  it('R2 preserves memoryBasis and memoryBasisChanged without exposing memory content', () => {
    const parsed = planResponseSchema.parse(planEnvelope(planWithBasis()));
    const plan = parsed.plan as unknown as Record<string, unknown>;
    expect(plan.memoryBasis).toEqual({ memoryId: 'memory-focus', window: { start: '09:00', end: '12:00' } });
    expect(plan.memoryBasisChanged).toBe(false);
    expect(plan.memoryBasis).not.toEqual(expect.objectContaining({ content: expect.anything() }));
  });

  it('R1 / R2 exposes every frozen copy key in ar, en, and he', () => {
    const keys = [
      'm5bLearnedTitle', 'm5bLearnedCompleted', 'm5bLearnedPostponed', 'm5bLearnedDropped',
      'm5bLearnedWrong', 'm5bLearnedWrongDone', 'm5bPlanFocusBasis', 'm5bBasisFix',
      'm5bPlanMemoryChanged', 'm5bPlanMemoryChangedNoRebuild',
    ];
    for (const language of ['ar', 'en', 'he'] as const) {
      const locale = strings[language] as unknown as Record<string, unknown>;
      for (const key of keys) expect(locale[key]).toEqual(expect.any(String));
    }
  });

  it('R1 / R2 parity parses older inbox and plan responses with both additive fields absent', () => {
    expect(() => intelligenceInboxSchema.parse(inbox([]))).not.toThrow();
    const oldPlan = planWithBasis() as Record<string, unknown>;
    delete oldPlan.memoryBasis;
    delete oldPlan.memoryBasisChanged;
    const parsed = planResponseSchema.parse(planEnvelope(oldPlan)).plan as unknown as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('memoryBasis');
    expect(parsed).not.toHaveProperty('memoryBasisChanged');
  });
});
