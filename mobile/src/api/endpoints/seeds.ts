import { apiRequest } from '../client';
import {
  seedDeletedSchema,
  seedListSchema,
  seedSavedSchema,
  type Seed,
  type SeedStatus,
} from '../schemas/seeds';

/**
 * The Seed routes (#519).
 *
 * Every one of them answers 404 when the capture module is off, and the
 * "Considering / Waiting" surface treats that as "this section does not
 * exist" and hides itself — the same way the memory card does.
 */
export function listSeeds(): Promise<{ items: Seed[] }> {
  return apiRequest('GET', '/api/mobile/seeds', { schema: seedListSchema });
}

/**
 * Keeps a seed the person picked in Review.
 *
 * The summary is deliberately not sent. The server reads it back out of the
 * proposal it wrote, so what is stored is the sentence they typed rather than
 * one this client rebuilt — see `createSeed` in `lib/services/mobile/seedService.ts`.
 */
export function keepProposedSeed(input: { proposalId: string; seedItemId: string }) {
  return apiRequest('POST', '/api/mobile/seeds', {
    body: { proposalId: input.proposalId, seedItemId: input.seedItemId },
    schema: seedSavedSchema,
  });
}

/** "Later", "Dismiss", or an edit to the sentence. */
export function patchSeed(id: string, patch: { status?: SeedStatus; revisitAt?: string | null; summary?: string }) {
  return apiRequest('PATCH', `/api/mobile/seeds/${encodeURIComponent(id)}`, {
    body: patch,
    schema: seedSavedSchema,
  });
}

/** "Turn into a task" / "Turn into a goal". Delegates to the existing boundaries. */
export function promoteSeed(id: string, target: 'commitment' | 'goal') {
  return apiRequest('POST', `/api/mobile/seeds/${encodeURIComponent(id)}/promote`, {
    body: { target },
    schema: seedSavedSchema,
  });
}

export function deleteSeed(id: string) {
  return apiRequest('DELETE', `/api/mobile/seeds/${encodeURIComponent(id)}`, {
    schema: seedDeletedSchema,
  });
}
