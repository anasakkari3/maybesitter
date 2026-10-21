import { apiRequest } from '../client';
import {
  commitmentSearchSchema, m6CapabilitiesSchema, memoryTranslationSchema,
  type CommitmentSearch, type M6Capabilities, type MemoryTranslation,
} from '../schemas/m6';

type Bound = { asUid?: string; signal?: AbortSignal };
const bound = (options: Bound) => ({
  ...(options.asUid !== undefined ? { asUid: options.asUid } : {}),
  ...(options.signal ? { signal: options.signal } : {}),
});

export function getM6Capabilities(options: Bound = {}): Promise<M6Capabilities> {
  return apiRequest('GET', '/api/mobile/capabilities/m6', { schema: m6CapabilitiesSchema, ...bound(options) });
}

/**
 * The account's commitments matching `q`, done and dropped ones of the last
 * 90 days included (D54-1). A POST so nothing the person typed rides in a URL
 * (R5-001); `limit` 1–50, the server's default is 30.
 */
export function searchCommitments(q: string, limit: number, options: Bound = {}): Promise<CommitmentSearch> {
  return apiRequest('POST', '/api/mobile/commitments/search', {
    body: { q, limit },
    schema: commitmentSearchSchema,
    ...bound(options),
  });
}

/**
 * One proposed translation of one stored fact into `locale` (PLAN-M6a-2). It
 * saves nothing; never retried — one request per tap.
 */
export function proposeMemoryTranslation(id: string, locale: 'ar' | 'en' | 'he', options: Bound = {}): Promise<MemoryTranslation> {
  return apiRequest('POST', `/api/mobile/memory/${encodeURIComponent(id)}/translation`, {
    body: { locale },
    schema: memoryTranslationSchema,
    ...bound(options),
  });
}
