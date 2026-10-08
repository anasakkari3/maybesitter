/**
 * Habit and goal titles are bounded at 120 code points, as the server counts
 * them (M3B-A-R2-004): 120 emoji are 240 UTF-16 units and still valid.
 */
import { describe, expect, it } from '@jest/globals';
import { captureGoalProposalSchema, captureHabitProposalSchema } from '../schemas/capture';

const goal = (title: string) => captureGoalProposalSchema.safeParse({ goalItemId: 'g', pointId: 'p', title });
const habit = (title: string) => captureHabitProposalSchema.safeParse({
  habitItemId: 'h', pointId: 'p', title, cadence: null, durationMinutes: null, preferredWindow: null, explanation: null, question: null, confirmable: false,
});

describe('habit and goal titles', () => {
  it('accept 120 code points even when they are more UTF-16 units', () => {
    const emoji = '🏃'.repeat(120);
    expect(emoji.length).toBe(240);
    expect(goal(emoji).success).toBe(true);
    expect(habit(emoji).success).toBe(true);
  });

  it('refuse 121 code points, and an empty title', () => {
    expect(goal('أ'.repeat(121)).success).toBe(false);
    expect(habit('🏃'.repeat(121)).success).toBe(false);
    expect(goal('').success).toBe(false);
  });
});
