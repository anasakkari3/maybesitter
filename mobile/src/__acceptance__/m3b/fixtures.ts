export const CONVERSATION_ID = 'm3b-conversation';
export const PROPOSAL_ID = 'm3b-proposal';
export const ITEM_ID = 'commitment-family-id';
export const HABIT_ITEM_ID = 'habit-family-id';
export const GOAL_ITEM_ID = 'goal-family-id';
export const SEED_ITEM_ID = 'seed-family-id';
export const COMMITMENT_POINT_ID = 'point-commitment';
export const HABIT_POINT_ID = 'point-habit';
export const GOAL_POINT_ID = 'point-goal';
export const SEED_POINT_ID = 'point-seed';
export const HABIT_ID = 'habit-saved';
export const GOAL_ID = 'goal-1';
export const SEED_ID = 'seed-saved';

type Raw = Record<string, unknown>;

export function commitment(pointId = COMMITMENT_POINT_ID): Raw {
  return {
    itemId: ITEM_ID,
    pointId,
    title: 'Call Dana',
    resolvedTime: '2030-01-08T09:00:00.000Z',
    needsClarification: false,
    priority: 'normal',
    weeklyBlock: {
      title: 'Call Dana',
      weekdays: [2],
      start: '09:00',
      end: '10:00',
      timezone: 'UTC',
    },
    goalLink: { goalId: 'existing-goal', title: 'Existing goal' },
  };
}

export function habit(overrides: Raw = {}): Raw {
  return {
    habitItemId: HABIT_ITEM_ID,
    pointId: HABIT_POINT_ID,
    title: 'Walk every morning',
    cadence: { kind: 'weekly_count', count: 3 },
    durationMinutes: 30,
    preferredWindow: 'morning',
    explanation: 'Three mornings each week, thirty minutes each time.',
    question: null,
    confirmable: true,
    ...overrides,
  };
}

export function incompleteHabit(field: 'frequency' | 'duration' | 'kind' = 'frequency'): Raw {
  const frequency = field === 'frequency'
    ? { cadence: null, durationMinutes: 30, options: [1, 2, 3, 4, 5, 6, 7] }
    : field === 'duration'
      ? { cadence: { kind: 'weekly_count', count: 3 }, durationMinutes: null, options: [15, 30, 45, 60] }
      : { cadence: null, durationMinutes: null, options: ['habit', 'commitment'] };
  return habit({
    ...frequency,
    explanation: null,
    question: { field, options: frequency.options },
    confirmable: false,
  });
}

export function goal(): Raw {
  return { goalItemId: GOAL_ITEM_ID, pointId: GOAL_POINT_ID, title: 'Lose weight gradually' };
}

export function seed(overrides: Raw = {}): Raw {
  return {
    seedItemId: SEED_ITEM_ID,
    pointId: SEED_POINT_ID,
    kind: 'consideration',
    summary: 'Maybe go to the gym tomorrow',
    suggestedTime: { at: '2030-01-08T18:00:00.000Z', timeZone: 'UTC' },
    ...overrides,
  };
}

export function proposal(overrides: Raw = {}): Raw {
  return {
    version: 'v1',
    proposalId: PROPOSAL_ID,
    revision: 7,
    status: 'proposed',
    entry: null,
    items: [],
    habits: [],
    goals: [],
    seeds: [],
    understood: [],
    ...overrides,
  };
}

export function mixedProposal(entry: 'goal' | 'habit' | 'thought' | null = 'thought'): Raw {
  return proposal({
    entry,
    items: [commitment()],
    habits: [habit()],
    goals: [goal()],
    seeds: [seed()],
    understood: [
      { kind: 'commitment', itemId: ITEM_ID, pointId: COMMITMENT_POINT_ID, text: 'Call Dana' },
      { kind: 'habit', habitItemId: HABIT_ITEM_ID, pointId: HABIT_POINT_ID, text: 'Walk every morning' },
      { kind: 'goal', goalItemId: GOAL_ITEM_ID, pointId: GOAL_POINT_ID, text: 'Lose weight gradually' },
      { kind: 'consideration', seedItemId: SEED_ITEM_ID, pointId: SEED_POINT_ID, text: 'Maybe go to the gym tomorrow' },
    ],
  });
}

export function answer(rawProposal: Raw | null, message = 'First message'): Raw {
  return {
    conversationId: CONVERSATION_ID,
    reply: rawProposal ? 'I understood this.' : 'Tell me more.',
    engine: 'rules',
    proposal: rawProposal,
    turns: [
      { role: 'user', text: message },
      { role: 'assistant', text: rawProposal ? 'I understood this.' : 'Tell me more.' },
    ],
  };
}

export function confirmation(overrides: Raw = {}): Raw {
  return {
    success: true,
    replayed: false,
    persisted: [],
    failed: [],
    collisions: [],
    weeklyBlocks: [],
    goalLinks: [],
    habitsPersisted: [],
    goalsPersisted: [],
    seedsPersisted: [],
    ...overrides,
  };
}

export function mixedConfirmation(): Raw {
  return confirmation({
    persisted: [{
      itemId: ITEM_ID,
      pointId: COMMITMENT_POINT_ID,
      commitmentId: 'commitment-saved',
      title: 'Call Dana',
      resolvedTime: '2030-01-08T09:00:00.000Z',
    }],
    habitsPersisted: [{ habitItemId: HABIT_ITEM_ID, pointId: HABIT_POINT_ID, habitId: HABIT_ID, title: 'Walk every morning' }],
    goalsPersisted: [{ goalItemId: GOAL_ITEM_ID, pointId: GOAL_POINT_ID, goalId: GOAL_ID, title: 'Lose weight gradually' }],
    seedsPersisted: [{ seedItemId: SEED_ITEM_ID, pointId: SEED_POINT_ID, seedId: SEED_ID, kind: 'consideration', title: 'Maybe go to the gym tomorrow' }],
  });
}
