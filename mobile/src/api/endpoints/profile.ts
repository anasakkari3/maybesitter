import { apiRequest } from '../client';
import {
  profileConfirmedSchema,
  profileProposalSchema,
  memoryCreatedSchema,
  memoryDeletedSchema,
  memoryListSchema,
  profileResponseSchema,
  routineSavedSchema,
  type MemoryItem,
  type ProfileResponse,
} from '../schemas/profile';
import type { RoutineProfilePayload } from '../../features/routine/routineProfile';

/**
 * The routine profile and the memory it becomes (UC-2.7a, #167).
 *
 * Every one of these answers 404 when `MAYBESITTER_FEATURE_MEMORY` is off. The
 * screens treat that as "this section does not exist" and hide it, rather than
 * as an error to show somebody.
 */
export function getProfile(): Promise<ProfileResponse> {
  return apiRequest('GET', '/api/mobile/profile', { schema: profileResponseSchema });
}

/**
 * The whole profile, every time — not a patch.
 *
 * That is what lets the phone re-send its latest copy after a failed sync
 * without a replay queue: the call is idempotent, so sending it twice is the
 * same as sending it once (UC-1.R4 #157's no-offline-queue rule).
 */
export function putRoutine(profile: RoutineProfilePayload) {
  return apiRequest('PUT', '/api/mobile/profile/routine', {
    body: profile,
    schema: routineSavedSchema,
  });
}

export function listMemory(): Promise<{ items: MemoryItem[] }> {
  return apiRequest('GET', '/api/mobile/memory', { schema: memoryListSchema });
}

export function createMemory(input: { kind: 'fact' | 'preference' | 'goal'; content: string; language: 'ar' | 'he' | 'en' | 'mixed' }) {
  return apiRequest('POST', '/api/mobile/memory', { body: input, schema: memoryCreatedSchema });
}

/** An edit supersedes: the reply carries a **new** id, and the old one is gone from the list. */
export function patchMemory(id: string, content: string) {
  return apiRequest('PATCH', `/api/mobile/memory/${encodeURIComponent(id)}`, {
    body: { content },
    schema: memoryCreatedSchema,
  });
}

/** Removes the fact and every record in its supersession chain. Irreversible. */
export function deleteMemory(id: string) {
  return apiRequest('DELETE', `/api/mobile/memory/${encodeURIComponent(id)}`, {
    schema: memoryDeletedSchema,
  });
}

export function deleteAllMemory() {
  return apiRequest('DELETE', '/api/mobile/memory', { schema: memoryDeletedSchema });
}

/**
 * Reads a self-description and proposes what it might mean (UC-2.7b, #168).
 *
 * Answers 403 `consent_required` when AI processing has not been agreed to,
 * which the screen renders as the manual-entry path rather than as an error —
 * declining is a normal choice, not a failure.
 */
export function describeProfile(text: string) {
  return apiRequest('POST', '/api/mobile/profile/describe', {
    body: { text },
    schema: profileProposalSchema,
  });
}

/**
 * Saves the suggestions the user ticked, and only those.
 *
 * `content` on an entry is the user's edit; sending it makes the stored fact
 * `user_stated` rather than `model_inferred`, which is what the provenance
 * chip on the memory screen then shows.
 */
export function confirmProfileSuggestions(
  proposalId: string,
  accepted: Array<{ index: number; content?: string }>,
) {
  return apiRequest('POST', '/api/mobile/profile/describe/confirm', {
    body: { proposalId, accepted },
    schema: profileConfirmedSchema,
  });
}
