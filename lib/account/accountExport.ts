/**
 * "Export my data" — a copy of everything this account holds (#174 step 7).
 *
 * ── The list is deletion's list ──────────────────────────────────
 *
 * What a person can take away and what a person can have erased are the same
 * set, so they are read from the same place: `USER_SCOPED_COLLECTIONS` (the
 * account tree `deleteTree('users/{uid}')` removes) and
 * `TOP_LEVEL_USER_COLLECTIONS` (the uid-carrying top-level documents the
 * deletion sweep removes). There is no second list here to keep in step. A
 * collection added to deletion is exported the moment it is added, unless it
 * is named in `EXPORT_EXCLUDED_COLLECTIONS` below with the reason it is not
 * the person's to download. `tests/account/accountExport.test.ts` seeds every
 * collection deletion knows about and holds the export to exactly that set.
 *
 * ── What is left out ─────────────────────────────────────────────
 *
 * Secrets, not data: the encrypted OAuth token sets, the in-flight PKCE
 * verifiers, every field-encryption envelope (a wrapped key and a ciphertext
 * are KMS material, and useless to the person anyway), and every field that
 * holds a token — an FCM registration token included. Deletion receipts and
 * the deletion job record are keyed by a peppered hash and hold no uid, so
 * they are not reachable from here and are not the person's records.
 *
 * ── Bounded ──────────────────────────────────────────────────────
 *
 * The storage seam has no cursor, so "paginate" means a shrinking budget: each
 * collection is read with a limit of whatever is left of
 * `EXPORT_MAX_DOCUMENTS` plus one, and the first read that comes back over the
 * budget stops the export with `ExportTooLargeError`. The total read is at
 * most the cap plus one document per collection, however large an account
 * grows. The serialized size is capped the same way. Refusing is deliberate:
 * a truncated export that looks complete is worse than an honest "too large".
 *
 * Nothing here logs. The whole output is the user's content.
 */
import { getStorage } from '../storage';
import {
  PROVIDER_CREDENTIALS,
  PROVIDER_OAUTH_STATES,
  USER_SCOPED_COLLECTIONS,
  requireUserId,
  userCol,
  userDoc,
} from '../storage/paths';
import type { StorageAdapter } from '../storage/storageAdapter';
import { TOP_LEVEL_USER_COLLECTIONS } from './topLevelUserData';

export const ACCOUNT_EXPORT_SCHEMA_VERSION = 'account-export-v1';

/** The most documents one export will carry. A real account is far below it. */
export const EXPORT_MAX_DOCUMENTS = 10_000;

/** The most serialized JSON one export will carry, in UTF-16 code units. */
export const EXPORT_MAX_CHARS = 8 * 1024 * 1024;

/**
 * Collections deletion removes that are deliberately not exported, each with
 * the reason. Anything else deletion knows about is exported.
 */
export const EXPORT_EXCLUDED_COLLECTIONS: Readonly<Record<string, string>> = Object.freeze({
  [PROVIDER_CREDENTIALS]: 'encrypted OAuth access and refresh tokens: a secret held on the person\'s behalf, not a record of them',
  [PROVIDER_OAUTH_STATES]: 'an in-flight OAuth authorization holding a PKCE verifier: a secret with a lifetime of minutes',
});

/**
 * Field names that hold a secret wherever they appear. `token` catches
 * `fcmToken`, `accessToken`, `refreshToken`, `idToken` and a bare `token`;
 * a plural such as `inputTokens` is a count and is kept.
 */
const SECRET_FIELD = /(?:^|[a-z])(?:token|Token)$|^(?:authorizationCode|codeVerifier|pkceVerifier|verifier|secret|clientSecret|password|pepper|subjectHash|wrappedDek|ciphertext)$/;

export interface AccountExportDocument {
  id: string;
  data: Record<string, unknown>;
}

export interface AccountExport {
  exportedAt: string;
  schemaVersion: typeof ACCOUNT_EXPORT_SCHEMA_VERSION;
  account: {
    uid: string;
    /** `users/{uid}` itself: the trust record, timezone, settings. */
    profile: Record<string, unknown> | null;
  };
  /** Every exported collection by id, present even when empty. */
  collections: Record<string, AccountExportDocument[]>;
  /** What was left out, and why, so the file explains its own gaps. */
  excluded: Record<string, string>;
}

export class ExportTooLargeError extends Error {
  constructor(readonly limit: 'documents' | 'size') {
    super(`the export is larger than its ${limit} limit`);
    this.name = 'ExportTooLargeError';
  }
}

/** The user-tree collections an export reads, in deletion's order. */
export function exportedUserCollections(): string[] {
  return USER_SCOPED_COLLECTIONS.filter((name) => !(name in EXPORT_EXCLUDED_COLLECTIONS));
}

/** The top-level collections an export reads, with the field holding the uid. */
export function exportedTopLevelCollections(): Array<{ collection: string; field: string }> {
  return TOP_LEVEL_USER_COLLECTIONS
    .filter(({ collection }) => !(collection in EXPORT_EXCLUDED_COLLECTIONS))
    .map(({ collection, field }) => ({ collection, field }));
}

function isEncryptedEnvelope(value: Record<string, unknown>): boolean {
  return 'wrappedDek' in value || ('ciphertext' in value && 'iv' in value);
}

/**
 * The stored value as plain JSON, with every secret removed.
 *
 * Firestore hands back its own `Timestamp` for a `Date` it stored (TTL fields
 * are written that way), so anything with a `toDate()` becomes an instant.
 */
export function redactForExport(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Array.isArray(value)) return value.map(redactForExport).filter((item) => item !== undefined);
  if (typeof value === 'object') {
    const toDate = (value as { toDate?: unknown }).toDate;
    if (typeof toDate === 'function') return redactForExport((toDate as () => Date).call(value));
    if (ArrayBuffer.isView(value)) return undefined;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_FIELD.test(key)) continue;
      if (item && typeof item === 'object' && !Array.isArray(item) && isEncryptedEnvelope(item as Record<string, unknown>)) continue;
      const clean = redactForExport(item);
      if (clean !== undefined) out[key] = clean;
    }
    return out;
  }
  // Functions, symbols, bigints and undefined are not data.
  return undefined;
}

export interface BuildAccountExportOptions {
  storage?: StorageAdapter;
  now?: Date;
  maxDocuments?: number;
  maxChars?: number;
}

/**
 * Every record this uid owns, as one JSON-ready document.
 *
 * The uid is the only scope: every read is under `users/{uid}` or filtered on
 * the top-level field that names the owner, so another account's documents
 * are not filtered out of the answer — they are never read.
 */
export async function buildAccountExport(uid: string, options: BuildAccountExportOptions = {}): Promise<AccountExport> {
  requireUserId(uid);
  const storage = options.storage ?? getStorage();
  const maxDocuments = options.maxDocuments ?? EXPORT_MAX_DOCUMENTS;
  const maxChars = options.maxChars ?? EXPORT_MAX_CHARS;
  let remaining = maxDocuments;
  let chars = 0;

  const take = (rows: Array<{ id: string; data: unknown }>): AccountExportDocument[] => {
    if (rows.length > remaining) throw new ExportTooLargeError('documents');
    remaining -= rows.length;
    return rows.map((row) => {
      const data = (redactForExport(row.data) ?? {}) as Record<string, unknown>;
      chars += row.id.length + JSON.stringify(data).length;
      if (chars > maxChars) throw new ExportTooLargeError('size');
      return { id: row.id, data };
    });
  };

  const profileRaw = await storage.get<Record<string, unknown>>(userDoc(uid));
  const profile = profileRaw === null ? null : (redactForExport(profileRaw) as Record<string, unknown>);
  chars += profile === null ? 0 : JSON.stringify(profile).length;

  const collections: Record<string, AccountExportDocument[]> = {};
  for (const name of exportedUserCollections()) {
    const rows = await storage.list<unknown>(userCol(uid, name), { limit: remaining + 1 });
    collections[name] = take(rows);
  }
  for (const { collection, field } of exportedTopLevelCollections()) {
    const rows = await storage.list<unknown>(collection, { where: [[field, '==', uid]], limit: remaining + 1 });
    collections[collection] = take(rows);
  }

  return {
    exportedAt: (options.now ?? new Date()).toISOString(),
    schemaVersion: ACCOUNT_EXPORT_SCHEMA_VERSION,
    account: { uid, profile },
    collections,
    excluded: { ...EXPORT_EXCLUDED_COLLECTIONS },
  };
}
