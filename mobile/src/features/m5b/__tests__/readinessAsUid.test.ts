import { describe, expect, it, jest } from '@jest/globals';

const mockApiRequest = jest.fn(async () => ({ success: true, result: 'stored' }));
jest.mock('../../../api/client', () => ({ apiRequest: (...args: unknown[]) => (mockApiRequest as (...a: unknown[]) => unknown)(...args) }));

import { putSubjectiveEnergy } from '../../../api/endpoints/readiness';

/**
 * M5B-A-003: the check-in carries the account it was started for, so the
 * client's pre/post-token guards refuse it after an account switch (the same
 * `asUid` boundary every M5a call has, tested in `api/__tests__`).
 */
describe('M5B-A-003 the readiness PUT is account-bound', () => {
  it('passes asUid through to the client', async () => {
    await putSubjectiveEnergy({ energy: 2, observedAt: '2030-03-29T09:00:00.000Z' }, { asUid: 'uid-a' });
    expect(mockApiRequest).toHaveBeenCalledWith('PUT', '/api/mobile/readiness', expect.objectContaining({ asUid: 'uid-a' }));
  });
});
