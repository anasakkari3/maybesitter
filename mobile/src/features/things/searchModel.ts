import type { Commitment } from '../../api/schemas/common';
import { foldForSearch, isWordPrefixMatch } from '../../text/foldForSearch';

const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
/** A folded needle has something to search for: at least one letter or digit (R2-011). */
const isSearchable = (folded: string) => LETTER_OR_NUMBER.test(folded);

/**
 * The search on «أشيائي» and the commitments page (PLAN-M6a R54.2, D54-1).
 *
 * Both sides of every comparison are folded (`foldForSearch`, shared with the
 * server byte for byte), so «احمد» finds «أحمد» and «3» finds «٣». A match at
 * the start of a word ranks before one inside a word; within each, what is
 * still ahead comes first, nearest first, then what was finished or dropped,
 * most recent first.
 */

/** The server is asked only for a needle with this many letters or digits after folding (R2-011). */
export const MIN_SERVER_QUERY = 2;

/** Letters and digits in a folded needle, counted by code point: «a-» and «😀a» have one (M6A-INSPECT-R2-001). */
export function searchableCount(folded: string): number {
  let count = 0;
  for (const char of folded) if (LETTER_OR_NUMBER.test(char)) count += 1;
  return count;
}

export interface Needle {
  raw: string;
  folded: string;
  /** Has a letter or digit after folding: a tatweel-only needle searches nothing. */
  searchable: boolean;
}

export function needleOf(raw: string): Needle {
  const trimmed = raw.trim();
  const folded = foldForSearch(trimmed);
  return { raw: trimmed, folded, searchable: folded.length > 0 && isSearchable(folded) };
}

export type MatchTier = 0 | 1;

/** 0: at the start of a word; 1: inside one; null: no match. */
export function matchTier(text: string, needle: Needle): MatchTier | null {
  if (!needle.searchable) return null;
  const folded = foldForSearch(text);
  if (!folded.includes(needle.folded)) return null;
  return isWordPrefixMatch(folded, needle.folded) ? 0 : 1;
}

export function settledAt(item: Commitment): string | null {
  return item.status === 'completed' || item.status === 'done' ? item.completedAt : item.status === 'dropped' ? item.droppedAt : null;
}

function isSettled(item: Commitment): boolean {
  return settledAt(item) !== null || item.status === 'completed' || item.status === 'done' || item.status === 'dropped';
}

/**
 * Local commitments that match, merged with the server's (which add done,
 * dropped and older items), one row per id, ranked. `shownAt` resolves the
 * time a live item is shown at; the caller's view model supplies it.
 */
export function rankCommitments(
  local: readonly Commitment[],
  server: readonly Commitment[],
  needle: Needle,
  nowMs: number,
): Commitment[] {
  // The server's answer is already ranked, by each item's resolved time
  // (`postponedUntil` included, which this screen's view model does not
  // know): it is kept in its order, and only what this screen loaded that the
  // server did not send follows it, ranked here.
  if (server.length > 0) {
    const sent = new Set(server.map(item => item.id));
    return [...server, ...rankLocal(local.filter(item => !sent.has(item.id)), needle, nowMs)];
  }
  return rankLocal(local, needle, nowMs);
}

/** The server's `resolvedCommitmentTime`, then `createdAt` — the same instant it ranks by (M6A-INSPECT-005). */
function resolvedMs(item: Commitment): number {
  const at = Date.parse(item.postponedUntil || item.timeSpec.remindAt || item.timeSpec.dueAt || item.createdAt);
  return Number.isFinite(at) ? at : 0;
}

/** Ranked as the server ranks: word start first; then what is live, nearest to now; then what was settled, most recent first. */
function rankLocal(
  local: readonly Commitment[],
  needle: Needle,
  nowMs: number,
): Commitment[] {
  const byId = new Map<string, Commitment>();
  for (const item of local) byId.set(item.id, item);
  const matched = [...byId.values()]
    .map(item => ({ item, tier: matchTier(item.title, needle) }))
    .filter((entry): entry is { item: Commitment; tier: MatchTier } => entry.tier !== null);
  return matched.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    const aSettled = isSettled(a.item);
    const bSettled = isSettled(b.item);
    if (aSettled !== bSettled) return aSettled ? 1 : -1;
    if (!aSettled) return Math.abs(resolvedMs(a.item) - nowMs) - Math.abs(resolvedMs(b.item) - nowMs);
    return (settledAt(b.item) ?? '').localeCompare(settledAt(a.item) ?? '');
  }).map(entry => entry.item);
}

/** Generic rows (goals, habits, ideas): matching ones, word-start matches first, stable otherwise. */
export function rankByText<T>(items: readonly T[], text: (item: T) => string, needle: Needle): T[] {
  return items
    .map((item, index) => ({ item, index, tier: matchTier(text(item), needle) }))
    .filter(entry => entry.tier !== null)
    .sort((a, b) => (a.tier! - b.tier!) || (a.index - b.index))
    .map(entry => entry.item);
}
