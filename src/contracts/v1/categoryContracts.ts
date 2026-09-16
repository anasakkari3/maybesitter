/**
 * What kind of life a commitment belongs to, and who decided (#415).
 *
 * ── Why a closed catalog ─────────────────────────────────────────
 *
 * The product does not let a user name their own categories, and that is a
 * position rather than a missing feature. A model asked to sort into a list
 * the user wrote will sort into it confidently and wrongly: "call the clinic"
 * lands in a bucket called "Tuesday" because the name was there. A fixed
 * catalog is a vocabulary the extraction prompt, the evaluation corpus and the
 * filter bar can all be held to.
 *
 * What the user *does* choose is which of these six they use. Somebody with no
 * children has no use for `family`, and a category nobody uses is a filter
 * nobody wants to scroll past.
 *
 * ── Why `null` is not a seventh category ─────────────────────────
 *
 * An uncategorised commitment has no category. It is not filed under
 * "unknown". The distinction is not pedantry: an `unknown` member would earn a
 * chip in the filter bar, and a chip is an invitation — the user would feel
 * they had a bucket to empty, when what they have is a commitment the app was
 * not sure about and should not pretend otherwise. `null` shows up under
 * "All", and nowhere else.
 *
 * ── Why the split is off by default ──────────────────────────────
 *
 * Most people keep one list. Splitting is for the person who told us they
 * carry work commitments and home commitments as two different weights.
 * Everyone else opens the app to exactly what they opened it to yesterday. The
 * *field* is still filled in from day one, though, so the day that person
 * turns the split on their existing commitments are already sorted rather than
 * sitting in one undifferentiated heap.
 */

export const COMMITMENT_CATEGORY_CONTRACT_VERSION = 'category-v1';

export const COMMITMENT_CATEGORIES = [
  'work',
  'family',
  'health',
  'finance',
  'social',
  'errands',
] as const;

export type CommitmentCategory = (typeof COMMITMENT_CATEGORIES)[number];

/**
 * Who put the category there.
 *
 * Mirrors `Priority.source` for the same reason it exists there: an inference
 * must never overwrite a decision. A user who files something under `work`
 * has said something, and a later re-extraction that disagrees is wrong by
 * definition.
 */
export const COMMITMENT_CATEGORY_SOURCES = ['inferred', 'user_explicit'] as const;

export type CommitmentCategorySource = (typeof COMMITMENT_CATEGORY_SOURCES)[number];

/**
 * How sure the model must be before a guess becomes a category.
 *
 * Deliberately high. The cost of the two errors is not symmetric: an
 * uncategorised commitment still appears under "All" and costs the user
 * nothing, while a commitment filed under the wrong category *disappears* from
 * the list the user was looking at. Silence beats a confident mistake.
 */
export const CATEGORY_CONFIDENCE_FLOOR = 0.7;

export interface CommitmentCategoryPreferences {
  /** The categories this user has kept. Order follows the catalog, not the input. */
  readonly enabled: readonly CommitmentCategory[];
  /** Whether the lists show the category filter bar at all. */
  readonly grouping: boolean;
}

export const DEFAULT_CATEGORY_PREFERENCES: CommitmentCategoryPreferences = {
  enabled: COMMITMENT_CATEGORIES,
  grouping: false,
};

export function isCommitmentCategory(value: unknown): value is CommitmentCategory {
  return typeof value === 'string' && (COMMITMENT_CATEGORIES as readonly string[]).includes(value);
}

export function isCommitmentCategorySource(value: unknown): value is CommitmentCategorySource {
  return (
    typeof value === 'string' && (COMMITMENT_CATEGORY_SOURCES as readonly string[]).includes(value)
  );
}

/**
 * Read preferences that came from storage or from a request body.
 *
 * Total: anything unreadable becomes the defaults rather than an error. These
 * are a display preference, and a user whose stored settings are malformed
 * should see the ordinary one-list app, not a failure.
 *
 * An empty `enabled` is *not* malformed — it is a user who turned everything
 * off, and the app owes them the empty result they asked for. Only a missing
 * or wrongly-typed `enabled` falls back.
 */
export function normalizeCategoryPreferences(value: unknown): CommitmentCategoryPreferences {
  if (!value || typeof value !== 'object') return DEFAULT_CATEGORY_PREFERENCES;
  const raw = value as Record<string, unknown>;
  const offered: unknown[] | null = Array.isArray(raw.enabled) ? raw.enabled : null;
  if (!offered) return DEFAULT_CATEGORY_PREFERENCES;

  // Filtered from the catalog rather than from the input, so the chips render
  // in one stable order no matter what order the stored array happens to be in.
  const kept = COMMITMENT_CATEGORIES.filter((category) => offered.includes(category));
  return { enabled: kept, grouping: raw.grouping === true };
}

/**
 * Turn a model's guess into a category, or into nothing.
 *
 * Three ways to get `null`, and they are all the same answer to the user: the
 * app did not file this one. Kept in one function so the API route, the
 * capture service and any future re-classification cannot each decide
 * differently which guesses are good enough.
 *
 * Note what this does *not* consult: `grouping`. Whether the user is currently
 * looking at a filter bar has nothing to do with whether a commitment gets
 * filed — see the header.
 */
export function resolveCategory(
  guess: unknown,
  confidence: number,
  preferences: CommitmentCategoryPreferences,
): CommitmentCategory | null {
  if (!isCommitmentCategory(guess)) return null;
  if (!Number.isFinite(confidence) || confidence < CATEGORY_CONFIDENCE_FLOOR) return null;
  if (!preferences.enabled.includes(guess)) return null;
  return guess;
}
