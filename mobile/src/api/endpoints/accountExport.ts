import { apiRequest } from '../client';
import { accountExportSchema, type AccountExport } from '../schemas/accountExport';

/**
 * Everything this account holds, as one document (#174 step 7).
 *
 * Not a query: nothing caches it. The caller writes it to the share sheet and
 * drops it, and a copy of somebody's whole account sitting in the query cache
 * would be exactly the persistence `src/api` promises not to have. A 413 comes
 * back as `InputTooLargeError` when the account is over the server's cap.
 */
export function getAccountExport(): Promise<AccountExport> {
  return apiRequest('GET', '/api/mobile/account/export', { schema: accountExportSchema });
}
