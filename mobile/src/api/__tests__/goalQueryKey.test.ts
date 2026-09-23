import { expect, it } from '@jest/globals';
import { queryKeys } from '../queries';

it('scopes goal execution cache entries by account, goal, generation, and progress period', () => {
  const period = { fromLocalDate: '2026-09-21', toLocalDate: '2026-09-27' };
  expect(queryKeys.goalExecution('account-a', 'goal-1', 2, period)).toEqual([
    'user', 'account-a', 'goalExecution', 'goal-1', 2, '2026-09-21', '2026-09-27',
  ]);
  expect(queryKeys.goalExecution('account-a', 'goal-1', 2, period))
    .not.toEqual(queryKeys.goalExecution('account-b', 'goal-1', 2, period));
  expect(queryKeys.goalExecution('account-a', 'goal-1', 2, period))
    .not.toEqual(queryKeys.goalExecution('account-a', 'goal-2', 2, period));
});
