import type { MemoryAdaptive, MemoryItem, MemorySuggestion } from '../../api/schemas/profile';

/**
 * Whether delete-all has anything to erase (QA audit de7fcb8, CXA8.4).
 *
 * `DELETE /memory` clears more than the rows: open suggestions, the behaviour
 * log and the adaptive profile they come from. So delete-all is offered when
 * any of those is visible — rows, a suggestion, or a learned group — not only
 * when there are rows. `classification: null` is the server's "no behaviour
 * recorded", which with no rows and no suggestion leaves nothing to offer.
 */
export function memoryHoldsErasable(
  list: {
    readonly items: readonly MemoryItem[];
    readonly suggestions: readonly MemorySuggestion[];
    readonly adaptive: MemoryAdaptive | null;
  },
): boolean {
  return list.items.length > 0
    || list.suggestions.length > 0
    || (list.adaptive?.classification ?? null) !== null;
}
