import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getGoalExecution, confirmGoalSelections } from '../endpoints/goals';
import {
  goalConfirmResponseSchema,
  goalExecutionResponseSchema,
  goalGraphResponseSchema,
  goalUnlinkResponseSchema,
} from '../schemas/goals';

const mockApiRequest = jest.fn<(...args: unknown[]) => Promise<any>>();

jest.mock('../client', () => ({
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
}));

beforeEach(() => { mockApiRequest.mockReset(); });

describe('goal execution mobile contract', () => {
  it('parses route-generated execution, confirmation, and unlink fixtures', () => {
    expect(() => goalExecutionResponseSchema.parse(require('../__fixtures__/goal.execution.json'))).not.toThrow();
    expect(() => goalGraphResponseSchema.parse(require('../__fixtures__/goal.generated.json'))).not.toThrow();
    expect(() => goalGraphResponseSchema.parse(require('../__fixtures__/goal.regenerated.json'))).not.toThrow();
    expect(() => goalConfirmResponseSchema.parse(require('../__fixtures__/goal.confirmed.json'))).not.toThrow();
    expect(() => goalUnlinkResponseSchema.parse(require('../__fixtures__/goal.unlinked.json'))).not.toThrow();
  });

  it('sends both local dates when requesting habit progress', async () => {
    mockApiRequest.mockResolvedValue({ success: true });
    await getGoalExecution('goal/one', 2, {
      fromLocalDate: '2026-09-21',
      toLocalDate: '2026-09-27',
    });

    expect(mockApiRequest).toHaveBeenCalledWith(
      'GET',
      '/api/mobile/goals/goal%2Fone/execution',
      expect.objectContaining({
        query: { generation: 2, fromLocalDate: '2026-09-21', toLocalDate: '2026-09-27' },
      }),
    );
  });

  it('returns refusal details so stale proposals can be refreshed', async () => {
    const response = {
      success: true,
      graph: { generation: 3 },
      created: [],
      replayed: [],
      refused: [{ nodeId: 'old', nodeKey: 'goal.step.old', code: 'unknown_node', detail: 'stale' }],
    };
    mockApiRequest.mockResolvedValue(response);

    await expect(confirmGoalSelections('goal-1', 2, [{ nodeId: 'old', as: 'commitment' }]))
      .resolves.toBe(response);
  });
});
