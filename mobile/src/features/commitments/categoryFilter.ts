/**
 * Narrowing a list to one category, and deciding which chips to draw (#415).
 *
 * ── An uncategorised commitment lives under "All" ────────────────
 *
 * It is not hidden by every filter and it does not get a bucket of its own.
 * The alternative — an "Other" chip — reads as a pile to sort, and the app
 * would be asking the user to finish a job it started and was not sure about.
 * The alternative to *that* — hiding uncategorised rows whenever a filter is
 * on — is worse: the day somebody taps "Work" the app quietly stops showing
 * them things it never managed to read, which is exactly the commitment they
 * are most likely to have forgotten.
 *
 * ── A chip only exists if it has something behind it ─────────────
 *
 * The chips are the intersection of what the user enabled and what is in front
 * of them right now. A "Finance" chip on a day with no bills filters to an
 * empty screen, and an empty screen reached by a deliberate tap reads as a
 * bug rather than as an answer.
 *
 * The cost is that the bar changes between days. That is the honest behaviour:
 * it is a filter over this list, not a table of contents for the account.
 */
import type { Commitment } from '../../api/schemas/common';

export type CommitmentCategory = NonNullable<Commitment['category']>;

/** "All" is a chip, not a category. It is always first and always present. */
export type CategoryChip = 'all' | CommitmentCategory;

/**
 * The catalog order, so the bar reads the same on every screen and every day.
 *
 * Duplicated from the server's `categoryContracts.ts` rather than imported:
 * the mobile app builds from `mobile/` alone and cannot reach into the backend
 * source. The Zod schema in `api/schemas/common.ts` is what actually holds the
 * two in step — a category the server adds and this list does not have would
 * arrive, parse, and simply never get a chip, which is the safe direction.
 */
const CATALOG: readonly CommitmentCategory[] = [
  'work',
  'family',
  'health',
  'finance',
  'social',
  'errands',
];

export function filterByCategory<T extends { category: Commitment['category'] }>(
  items: readonly T[],
  chip: CategoryChip,
): T[] {
  if (chip === 'all') return [...items];
  return items.filter((item) => item.category === chip);
}

export function categoryChipsFor(
  items: readonly { category: Commitment['category'] }[],
  enabled: readonly CommitmentCategory[],
): CategoryChip[] {
  const present = new Set(items.map((item) => item.category));
  return ['all', ...CATALOG.filter((category) => enabled.includes(category) && present.has(category))];
}
