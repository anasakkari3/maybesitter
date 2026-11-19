import { UPLOAD_TIMEOUT_MS, apiRequest } from '../client';
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
  // A dense account takes longer than a JSON request's 15 s, and the server
  // counts the day's export once it has built it (C12.15): cutting the wait
  // short used up an export and still said it failed.
  return apiRequest('GET', '/api/mobile/account/export', { schema: accountExportSchema, timeoutMs: UPLOAD_TIMEOUT_MS });
}
