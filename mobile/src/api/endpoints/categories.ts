import { apiRequest } from '../client';
import { categoryPreferencesResponseSchema, type CategoryPreferences } from '../schemas/categories';

/**
 * The category preference (#415).
 *
 * A whole preference goes up, never half of one: `enabled` and `grouping` are
 * read together everywhere, and a client that could send one without the other
 * could turn the split on against an empty set and draw a filter bar with
 * nothing in it.
 */
export function getCategoryPreferences(): Promise<{ categoryPreferences: CategoryPreferences }> {
  return apiRequest('GET', '/api/mobile/settings/categories', {
    schema: categoryPreferencesResponseSchema,
  });
}

export function putCategoryPreferences(
  preferences: CategoryPreferences,
): Promise<{ categoryPreferences: CategoryPreferences }> {
  return apiRequest('PUT', '/api/mobile/settings/categories', {
    body: preferences,
    schema: categoryPreferencesResponseSchema,
  });
}
