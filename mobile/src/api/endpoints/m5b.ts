import { apiRequest } from '../client';
import {
  m5bCapabilitiesSchema,
  memorySummaryResponseSchema,
  type M5bCapabilities,
  type MemorySummaryResponse,
} from '../schemas/m5b';

/**
 * M5b-1's calls (PLAN-M5b-1 Wire). Every one takes `asUid`: a request started
 * for one account is never sent as another.
 */
type Bound = { asUid?: string };
const bound = (options: Bound) => (options.asUid !== undefined ? { asUid: options.asUid } : {});

export function getM5bCapabilities(options: Bound = {}): Promise<M5bCapabilities> {
  return apiRequest('GET', '/api/mobile/capabilities/m5b', { schema: m5bCapabilitiesSchema, ...bound(options) });
}

/** The memory paragraph in one language (R1.1). Never retried by the caller (M5B1-013). */
export function getMemorySummary(language: 'ar' | 'en' | 'he', options: Bound = {}): Promise<MemorySummaryResponse> {
  return apiRequest('GET', '/api/mobile/memory/summary', {
    query: { language },
    schema: memorySummaryResponseSchema,
    ...bound(options),
  });
}
