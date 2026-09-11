/**
 * Personalization consent, on durable storage (UC-1.0c, #142).
 *
 * The one piece of personalization state that persists. The profile itself is
 * forbidden to (`PERSONALIZATION_PERSISTENCE_POLICY.profileCanPersist` is
 * false), which is exactly why "disable takes effect immediately" is cheap:
 * the consent record is the only stored input a flip has to change, and the
 * next derivation reads it fresh.
 *
 * ── What the move fixes ──────────────────────────────────────────
 *
 * It used to be one file per scope under `MAYBESITTER_DATA_DIR`. On Cloud Run
 * that is a per-instance disk, so a user who turned personalization **off** on
 * one instance stayed opted in on every other one until it restarted. That is
 * not a caching inefficiency; it is the same class of defect as the pilot
 * trust record in UC-1.0b — a withdrawal that does not take effect everywhere
 * is not a withdrawal. The record now lives at
 * `users/{uid}/consents/personalization`, so the next read anywhere sees it.
 *
 * ── Fail-closed is unchanged ─────────────────────────────────────
 *
 * Per `PERSONALIZATION_INPUT_POLICY.unreadableConsentIsDisabled`: a scope
 * never written, a malformed document, an unrecognised state, or a record
 * whose stored scopeId disagrees with the requested one all read as
 * `{ state: 'disabled', changedAt: null }` — the default, and the opt-in
 * cohort's starting point.
 */
import {
  PERSONALIZATION_CONSENT_STATES,
  isInstant,
  type PersonalizationConsent,
  type PersonalizationConsentState,
} from '../../src/contracts/v1/personalizationContracts';
import { isNonEmptyString } from '../evaluation/registry/validationPrimitives';
import {
  CONSENTS,
  createMemoryStorage,
  getStorage,
  userCol,
  userIdForKey,
  type StorageAdapter,
} from '../storage';

/** One document per user; the id names which consent it is. */
const PERSONALIZATION_CONSENT_DOC = 'personalization';
const CONSENT_SCHEMA_VERSION = 'personalization-consent-v1' as const;

/** Async since UC-1.0c (#142): every method is a storage round trip. */
export interface PersonalizationConsentStore {
  /** Never throws for a readable scopeId: unreadable state is disabled state. */
  read(scopeId: string): Promise<PersonalizationConsent>;
  write(scopeId: string, state: PersonalizationConsentState, at: string): Promise<PersonalizationConsent>;
  /** Removes the stored record, returning the scope to the default. 1 or 0. */
  deleteScope(scopeId: string): Promise<number>;
}

interface StoredConsent {
  readonly version: typeof CONSENT_SCHEMA_VERSION;
  readonly scopeId: string;
  readonly state: PersonalizationConsentState;
  readonly changedAt: string;
}

const DISABLED_DEFAULT: PersonalizationConsent = Object.freeze({ state: 'disabled', changedAt: null });

function fail(message: string): never {
  throw new Error(`personalization consent: ${message}`);
}

function isStoredConsent(value: unknown): value is StoredConsent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return raw.version === CONSENT_SCHEMA_VERSION
    && isNonEmptyString(raw.scopeId)
    && (PERSONALIZATION_CONSENT_STATES as readonly unknown[]).includes(raw.state)
    && isInstant(raw.changedAt);
}

/** The scope key is the uid; the raw scope is kept in a field. */
function documentPath(scopeId: string): string {
  return `${userCol(userIdForKey(scopeId), CONSENTS)}/${PERSONALIZATION_CONSENT_DOC}`;
}

export class StoragePersonalizationConsentStore implements PersonalizationConsentStore {
  constructor(private readonly injected?: StorageAdapter) {}

  /** Resolved per call so a test may swap the adapter after construction. */
  private get storage(): StorageAdapter {
    return this.injected ?? getStorage();
  }

  async read(scopeId: string): Promise<PersonalizationConsent> {
    if (!isNonEmptyString(scopeId)) return DISABLED_DEFAULT;
    const stored = await this.storage.get<StoredConsent>(documentPath(scopeId));
    // Anything short of a well-formed record for this exact scope is the
    // default: fail-closed is the direction the policy names.
    if (!isStoredConsent(stored) || stored.scopeId !== scopeId) return DISABLED_DEFAULT;
    return Object.freeze({ state: stored.state, changedAt: stored.changedAt });
  }

  async write(
    scopeId: string,
    state: PersonalizationConsentState,
    at: string,
  ): Promise<PersonalizationConsent> {
    if (!isNonEmptyString(scopeId)) fail('scopeId must be a non-empty string');
    if (!(PERSONALIZATION_CONSENT_STATES as readonly unknown[]).includes(state)) {
      fail(`state must be one of ${PERSONALIZATION_CONSENT_STATES.join(', ')}`);
    }
    if (!isInstant(at)) fail('at must be an ISO instant with an explicit offset');
    await this.storage.set<StoredConsent>(documentPath(scopeId), {
      version: CONSENT_SCHEMA_VERSION,
      scopeId,
      state,
      changedAt: at,
    });
    return Object.freeze({ state, changedAt: at });
  }

  async deleteScope(scopeId: string): Promise<number> {
    if (!isNonEmptyString(scopeId)) fail('scopeId must be a non-empty string');
    const path = documentPath(scopeId);
    const existed = (await this.storage.get<StoredConsent>(path)) !== null;
    if (existed) await this.storage.delete(path);
    return existed ? 1 : 0;
  }
}

/**
 * The same implementation over a private in-memory adapter, so a test cannot
 * exercise semantics production does not have.
 */
export class MemoryPersonalizationConsentStore extends StoragePersonalizationConsentStore {
  constructor() {
    super(createMemoryStorage());
  }
}

export function createStoragePersonalizationConsentStore(
  storage?: StorageAdapter,
): PersonalizationConsentStore {
  return new StoragePersonalizationConsentStore(storage);
}

export function createInMemoryPersonalizationConsentStore(): PersonalizationConsentStore {
  return new MemoryPersonalizationConsentStore();
}
