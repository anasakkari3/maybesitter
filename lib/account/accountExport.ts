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
  ICS_FEEDS,
  INCIDENTS,
  PROVIDER_CONNECTIONS,
  PROVIDER_CREDENTIALS,
  PROVIDER_OAUTH_STATES,
  USER_SCOPED_COLLECTIONS,
  requireUserId,
  userCol,
  userDoc,
} from '../storage/paths';
import type { StorageAdapter } from '../storage/storageAdapter';
import { JOBS } from '../scheduler/storageSchedulerStore';
import { TOP_LEVEL_USER_COLLECTIONS } from './topLevelUserData';

export const ACCOUNT_EXPORT_SCHEMA_VERSION = 'account-export-v1';

/**
 * Exports per account per UTC day, enforced by the route with
 * `reserveDailyAction(uid, 'account_export', …)`.
 *
 * The most expensive read in the API — every collection, up to the document
 * cap — and a copy of a whole account in one response, so a looping client or
 * a stolen token must not be able to repeat it without limit. Three is more
 * than a person needs and too few to mirror an account with.
 */
export const MAX_EXPORTS_PER_DAY = 3;

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
 * Whether a field name holds a secret, wherever it appears.
 *
 * Matched on the name folded to lowercase with `_`, `-` and spaces removed, so
 * `refreshToken`, `refresh_token` and `Refresh-Token` are one name. A name
 * ending in `token`/`tokens` is dropped unless its value is a plain number —
 * `inputTokens: 1180` is a count; `tokens: { access, refresh }` is not.
 */
const SECRET_SUFFIXES = ['secret', 'password', 'apikey', 'privatekey', 'secretkey', 'credentials', 'credential'] as const;
const SECRET_NAMES = new Set([
  'authorizationcode', 'codeverifier', 'pkceverifier', 'verifier', 'pepper', 'subjecthash', 'wrappeddek', 'ciphertext',
]);

export function normaliseFieldName(key: string): string {
  return key.toLowerCase().replace(/[\s_-]+/g, '');
}

function isSecretField(key: string, value: unknown): boolean {
  const name = normaliseFieldName(key);
  if (SECRET_NAMES.has(name)) return true;
  if (SECRET_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
  if (name.endsWith('token') || name.endsWith('tokens')) return typeof value !== 'number';
  return false;
}

/**
 * Operator fields on records that are the person's, dropped by collection.
 *
 * Not secrets, but not the person's data either: which server instance claimed
 * a job and why it failed, which operator owns an incident, where a provider
 * grant is filed in the vault, and a feed's host hash and HTTP cache
 * validators. The brief's "internal fields" line; each name is checked against
 * its collection's own record shape in `tests/account/accountExport.test.ts`.
 */
export const EXPORT_INTERNAL_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  [JOBS]: ['lastError', 'claimedBy', 'dedupeKey'],
  [INCIDENTS]: ['ownerId'],
  [ICS_FEEDS]: ['hostHash', 'etag', 'lastModified'],
  [PROVIDER_CONNECTIONS]: ['credentialRef'],
});

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

/** A record the way Firestore and JSON hand one back, not a class instance. */
function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * The stored value as plain JSON, with every secret removed.
 *
 * Firestore hands back its own `Timestamp` for a `Date` it stored (TTL fields
 * are written that way), so anything with a `toDate()` becomes an instant.
 * Only plain objects and arrays are walked: a class instance (a
 * `DocumentReference`, a byte buffer) is not the person's data and may reach
 * the database client itself, so it is dropped rather than descended into. A
 * cycle is dropped at the point it repeats.
 */
export function redactForExport(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value !== 'object') return undefined; // functions, symbols, bigints, undefined
  const toDate = (value as { toDate?: unknown }).toDate;
  if (!Array.isArray(value) && typeof toDate === 'function') {
    try {
      return redactForExport((toDate as () => unknown).call(value), seen);
    } catch {
      return undefined;
    }
  }
  if (seen.has(value)) return undefined;
  if (Array.isArray(value)) {
    seen.add(value);
    const out = value.map((item) => redactForExport(item, seen)).filter((item) => item !== undefined);
    seen.delete(value);
    return out;
  }
  if (!isPlainObject(value)) return undefined;
  seen.add(value);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSecretField(key, item)) continue;
    if (item && typeof item === 'object' && !Array.isArray(item) && isPlainObject(item) && isEncryptedEnvelope(item)) continue;
    const clean = redactForExport(item, seen);
    if (clean !== undefined) out[key] = clean;
  }
  seen.delete(value);
  return out;
}

function withoutInternalFields(collection: string, data: Record<string, unknown>): Record<string, unknown> {
  const internal = EXPORT_INTERNAL_FIELDS[collection];
  if (!internal) return data;
  const out = { ...data };
  for (const field of internal) delete out[field];
  return out;
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

  const take = (collection: string, rows: Array<{ id: string; data: unknown }>): AccountExportDocument[] => {
    if (rows.length > remaining) throw new ExportTooLargeError('documents');
    remaining -= rows.length;
    return rows.map((row) => {
      const data = withoutInternalFields(collection, (redactForExport(row.data) ?? {}) as Record<string, unknown>);
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
    collections[name] = take(name, rows);
  }
  for (const { collection, field } of exportedTopLevelCollections()) {
    const rows = await storage.list<unknown>(collection, { where: [[field, '==', uid]], limit: remaining + 1 });
    collections[collection] = take(collection, rows);
  }

  return {
    exportedAt: (options.now ?? new Date()).toISOString(),
    schemaVersion: ACCOUNT_EXPORT_SCHEMA_VERSION,
    account: { uid, profile },
    collections,
    excluded: { ...EXPORT_EXCLUDED_COLLECTIONS },
  };
}
