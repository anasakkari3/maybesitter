/**
 * Which categories this account uses, and whether its lists are split (#415).
 *
 * ── Why this is on the server ────────────────────────────────────
 *
 * Both answers are about the account rather than about a device. "I use work
 * and family and nothing else" is a sentence about the person's life, and it
 * has to be true on their phone and on the next phone they sign in on. It is
 * also what the extraction prompt is built from — the model is only ever
 * offered the categories this user kept — and a prompt assembled on the server
 * cannot read a preference that stayed on the handset.
 *
 * Contrast `calendarSettings.ts`, which deliberately keeps the chosen
 * *calendar* on the device: a calendar id means nothing elsewhere. A category
 * name means the same thing everywhere, so it travels.
 *
 * ── Which way the two failure modes point ────────────────────────
 *
 * Reading is total: a record from an older schema, or one edited by hand,
 * produces the defaults rather than an error. The worst case is a user seeing
 * the ordinary one-list app, which is what they would see anyway.
 *
 * Writing is strict: a name the catalog does not have is refused. The client
 * and the server disagreeing about the catalog is a bug, and filtering it away
 * would let the settings screen show a category that is not being stored — the
 * user turns it on, watches it stick, and finds it gone next time.
 */
import {
  COMMITMENT_CATEGORIES,
  DEFAULT_CATEGORY_PREFERENCES,
  isCommitmentCategory,
  normalizeCategoryPreferences,
  type CommitmentCategory,
  type CommitmentCategoryPreferences,
} from '../../../src/contracts/v1/categoryContracts';
import { getStorage, type StorageAdapter } from '../../storage';
import { userDoc } from '../../storage/paths';

/** The user document, as this module reads and writes it. */
export interface CategoryPreferencesBearingUser {
  categoryPreferences?: unknown;
}

export class CategoryPreferencesValidationError extends Error {
  constructor(message: string, readonly reason: string) {
    super(message);
    this.name = 'CategoryPreferencesValidationError';
  }
}

export interface CategoryPreferencesDeps {
  storage?: StorageAdapter;
}

function storageOf(deps: CategoryPreferencesDeps): StorageAdapter {
  return deps.storage ?? getStorage();
}

export async function readCategoryPreferences(
  uid: string,
  deps: CategoryPreferencesDeps = {},
): Promise<CommitmentCategoryPreferences> {
  const user = await storageOf(deps).get<CategoryPreferencesBearingUser>(userDoc(uid));
  return normalizeCategoryPreferences(user?.categoryPreferences);
}

/**
 * Reads a request body into a preference, or refuses it.
 *
 * Separate from the write so the route can answer 400 with a reason before
 * touching storage, and so the strictness is testable without a transaction.
 */
export function parseCategoryPreferences(body: unknown): CommitmentCategoryPreferences {
  if (!body || typeof body !== 'object') {
    throw new CategoryPreferencesValidationError('body must be an object', 'invalid_body');
  }
  const raw = body as Record<string, unknown>;
  if (!Array.isArray(raw.enabled)) {
    throw new CategoryPreferencesValidationError('enabled must be an array', 'invalid_enabled');
  }
  const unknownName = raw.enabled.find((name) => !isCommitmentCategory(name));
  if (unknownName !== undefined) {
    throw new CategoryPreferencesValidationError(
      `unknown category: ${String(unknownName)}. Known categories are ${COMMITMENT_CATEGORIES.join(', ')}`,
      'unknown_category',
    );
  }
  if (typeof raw.grouping !== 'boolean') {
    throw new CategoryPreferencesValidationError('grouping must be a boolean', 'invalid_grouping');
  }

  // Ordered by the catalog, not by the request, so the chips render the same
  // way no matter what order a client happened to send.
  const enabled = COMMITMENT_CATEGORIES.filter((category) =>
    (raw.enabled as CommitmentCategory[]).includes(category),
  );
  return { enabled, grouping: raw.grouping };
}

/**
 * Records the preference.
 *
 * Read-modify-write inside a transaction rather than a merge, for the reason
 * `calendarSettings.ts` gives: the user document also carries the trust
 * record, the locale and the domain version, and a settings write that
 * clobbered one of those would be a privacy answer lost to a filter bar.
 */
export async function saveCategoryPreferences(
  uid: string,
  body: unknown,
  deps: CategoryPreferencesDeps = {},
): Promise<CommitmentCategoryPreferences> {
  const next = parseCategoryPreferences(body);
  return storageOf(deps).runTransaction(async (tx) => {
    const user = await tx.get<CategoryPreferencesBearingUser>(userDoc(uid));
    tx.set(userDoc(uid), { ...(user ?? {}), categoryPreferences: next });
    return next;
  });
}

export { DEFAULT_CATEGORY_PREFERENCES };
