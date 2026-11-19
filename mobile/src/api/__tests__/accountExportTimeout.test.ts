/**
 * C12.15 (QA audit de7fcb8, confirmed through the API): the export was asked
 * with the default 15 s timeout. A dense account takes longer; the server
 * kept building and committed the day's reservation, while the app said
 * «ما زبط التصدير» — three of those and the person was locked out for the day
 * without ever getting a file. The export waits as long as an upload does.
 */
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as client from '../client';
import { getAccountExport } from '../endpoints/accountExport';

afterEach(() => jest.restoreAllMocks());

describe('C12.15: the account export is not cut at 15 s', () => {
  it('asks with the upload timeout', async () => {
    const request = jest.spyOn(client, 'apiRequest').mockResolvedValue({} as never);
    await getAccountExport();
    const options = request.mock.calls[0]![2] as { timeoutMs?: number };
    expect(options.timeoutMs).toBeGreaterThanOrEqual(client.UPLOAD_TIMEOUT_MS);
  });
});
