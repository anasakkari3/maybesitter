/**
 * The shadow study's consent store, on durable storage (UC-1.0c, #142).
 *
 * ── Why a second consent store ───────────────────────────────────
 *
 * Sprint 10's `PersonalizationConsentStore` answers "may we personalise for
 * this scope". This one answers "is this person in the shadow study, and for
 * which of its three separately-refusable parts". They are different questions
 * with different subjects — a *scope* versus a *participant* — and a single
 * flag that meant both would be a consent a person could not withdraw from the
 * study without also turning off personalization.
 *
 * Both now live under `users/{uid}/consents`, distinguished by document id
 * (`personalization` and `shadowStudy`), which keeps them separately
 * refusable while putting both inside the tree account deletion removes.
 *
 * ── What the move fixes ──────────────────────────────────────────
 *
 * The file-backed version kept one file per participant on a per-instance
 * disk, so a withdrawal from the study was invisible to every other instance
 * until it restarted — a participant could keep being exposed after opting
 * out. That is the defect, not the storage cost.
 *
 * ── Revocation is a shape, and this store keeps it one ───────────
 *
 * `ShadowRevokedConsent` carries `scopes: readonly []` in the type. This store
 * never writes a revoked record with scopes on it, and — more usefully — never
 * *reads* one: a stored record whose state is not `granted` has its scopes
 * dropped on the way out. So a hand-edited record that put scopes back on a
 * revoked consent cannot hand a live scope to a consumer.
 *
 * ── Reports, never throws ────────────────────────────────────────
 *
 * Every write returns a result variant naming why it was refused, because this
 * half of the seam is called from an HTTP handler where a throw is a 500 and a
 * stack trace rather than something a client can act on.
 */
import {
  SHADOW_CONSENT_SCOPES,
  SHADOW_CONSENT_STATES,
  SHADOW_SAFE_CODE,
  isInstant,
  millisBetweenInstants,
  type Instant,
  type ShadowConsentScope,
  type ShadowConsentState,
  type ShadowStudyConsent,
} from '../../src/contracts/v1/shadowPipelineContracts';
import {
  CONSENTS,
  createMemoryStorage,
  getStorage,
  userCol,
  userIdForKey,
  type StorageAdapter,
} from '../storage';

/** One document per user; the id names which consent it is. */
const SHADOW_STUDY_CONSENT_DOC = 'shadowStudy';
export const SHADOW_STUDY_CONSENT_SCHEMA_VERSION = 'shadow-study-consent-v1' as const;

/**
 * Why a write was refused. Declared as data so a test can enumerate it and
 * prove every branch is reachable — a rejection nobody can produce is a
 * rejection nobody has checked.
 */
export const SHADOW_CONSENT_WRITE_REJECTIONS = Object.freeze([
  'unsafe_participant',
  'no_scopes',
  'unknown_scope',
  'malformed_instant',
  'nothing_to_revoke',
  'already_revoked',
  'backdated',
] as const);

export type ShadowConsentWriteRejection = (typeof SHADOW_CONSENT_WRITE_REJECTIONS)[number];

export type ShadowConsentWriteResult =
  | { readonly status: 'written'; readonly consent: ShadowStudyConsent }
  | {
      readonly status: 'rejected';
      readonly reason: ShadowConsentWriteRejection;
      readonly detail: string;
      /** The state the store still holds. A refused write changes nothing. */
      readonly consent: ShadowStudyConsent;
    };

/** Async since UC-1.0c (#142): every method is a storage round trip. */
export interface ShadowStudyConsentStore {
  /** Never throws for any input: unreadable state is the withheld default. */
  read(participantId: string): Promise<ShadowStudyConsent>;
  grant(
    participantId: string,
    scopes: readonly ShadowConsentScope[],
    at: Instant,
  ): Promise<ShadowConsentWriteResult>;
  revoke(participantId: string, at: Instant): Promise<ShadowConsentWriteResult>;
  /** Removes the record outright. Returns 1 or 0; verify by re-reading. */
  deleteParticipant(participantId: string): Promise<number>;
  /** 1 when a record exists for this participant, 0 otherwise. */
  countFor(participantId: string): Promise<number>;
  /** Every participant this store holds a record for. */
  listParticipants(): Promise<readonly string[]>;
}

interface StoredConsent {
  readonly version: typeof SHADOW_STUDY_CONSENT_SCHEMA_VERSION;
  readonly participantId: string;
  readonly state: ShadowConsentState;
  readonly scopes: readonly ShadowConsentScope[];
  readonly grantedAt: string | null;
  readonly revokedAt: string | null;
}

function withheld(participantId: string): ShadowStudyConsent {
  return Object.freeze({
    state: 'withheld',
    participantId,
    scopes: [] as const,
    grantedAt: null,
    revokedAt: null,
  });
}

function isSafeParticipant(value: unknown): value is string {
  return typeof value === 'string' && SHADOW_SAFE_CODE.test(value);
}

function isKnownScope(value: unknown): value is ShadowConsentScope {
  return (SHADOW_CONSENT_SCOPES as readonly unknown[]).includes(value);
}

function isStoredConsent(value: unknown): value is StoredConsent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (raw.version !== SHADOW_STUDY_CONSENT_SCHEMA_VERSION) return false;
  if (!isSafeParticipant(raw.participantId)) return false;
  if (!(SHADOW_CONSENT_STATES as readonly unknown[]).includes(raw.state)) return false;
  if (!Array.isArray(raw.scopes) || !raw.scopes.every(isKnownScope)) return false;
  if (raw.grantedAt !== null && !isInstant(raw.grantedAt)) return false;
  if (raw.revokedAt !== null && !isInstant(raw.revokedAt)) return false;
  return true;
}

/**
 * The stored record, read as the contract's union.
 *
 * A stored record that cannot make a well-formed variant reads as `withheld`
 * rather than as a partially-populated grant: fail-closed is the direction,
 * and "we could not read your consent" must never resolve to "you consented".
 */
function toConsent(record: StoredConsent | null, participantId: string): ShadowStudyConsent {
  if (record === null || record.participantId !== participantId) return withheld(participantId);

  if (record.state === 'granted') {
    const [first, ...rest] = record.scopes;
    if (first === undefined || record.grantedAt === null) return withheld(participantId);
    return Object.freeze({
      state: 'granted',
      participantId,
      scopes: [first, ...rest] as const,
      grantedAt: record.grantedAt,
      revokedAt: null,
    });
  }

  if (record.state === 'revoked') {
    if (record.grantedAt === null || record.revokedAt === null) return withheld(participantId);
    // Scopes are dropped here rather than trusted: a revoked record that
    // carried scopes must not hand a live one to a consumer.
    return Object.freeze({
      state: 'revoked',
      participantId,
      scopes: [] as const,
      grantedAt: record.grantedAt,
      revokedAt: record.revokedAt,
    });
  }

  return withheld(participantId);
}

function documentPath(participantId: string): string {
  return `${userCol(userIdForKey(participantId), CONSENTS)}/${SHADOW_STUDY_CONSENT_DOC}`;
}

export class StorageShadowStudyConsentStore implements ShadowStudyConsentStore {
  constructor(private readonly injected?: StorageAdapter) {}

  /** Resolved per call so a test may swap the adapter after construction. */
  private get storage(): StorageAdapter {
    return this.injected ?? getStorage();
  }

  private async stored(participantId: string): Promise<StoredConsent | null> {
    const value = await this.storage.get<StoredConsent>(documentPath(participantId));
    return isStoredConsent(value) ? value : null;
  }

  async read(participantId: string): Promise<ShadowStudyConsent> {
    if (!isSafeParticipant(participantId)) return withheld(String(participantId));
    return toConsent(await this.stored(participantId), participantId);
  }

  private async reject(
    participantId: string,
    reason: ShadowConsentWriteRejection,
    detail: string,
  ): Promise<ShadowConsentWriteResult> {
    return { status: 'rejected', reason, detail, consent: await this.read(participantId) };
  }

  async grant(
    participantId: string,
    scopes: readonly ShadowConsentScope[],
    at: Instant,
  ): Promise<ShadowConsentWriteResult> {
    if (!isSafeParticipant(participantId)) {
      return this.reject(participantId, 'unsafe_participant', 'participantId is outside the safe-code pattern');
    }
    if (!Array.isArray(scopes) || scopes.length === 0) {
      return this.reject(participantId, 'no_scopes', 'a granted consent must grant at least one scope');
    }
    const unknown = scopes.filter((scope) => !isKnownScope(scope));
    if (unknown.length > 0) {
      return this.reject(
        participantId,
        'unknown_scope',
        `not a study consent scope: ${unknown.map((scope) => String(scope)).join(', ')}`,
      );
    }
    if (!isInstant(at)) {
      return this.reject(participantId, 'malformed_instant', `not an ISO instant with an explicit offset: ${String(at)}`);
    }
    // Declaration order of the vocabulary, and each scope once: a caller who
    // sent the same scope twice consented to it once.
    const deduped = SHADOW_CONSENT_SCOPES.filter((scope) => scopes.includes(scope));
    await this.storage.set<StoredConsent>(documentPath(participantId), {
      version: SHADOW_STUDY_CONSENT_SCHEMA_VERSION,
      participantId,
      state: 'granted',
      scopes: deduped,
      grantedAt: at,
      revokedAt: null,
    });
    return { status: 'written', consent: await this.read(participantId) };
  }

  async revoke(participantId: string, at: Instant): Promise<ShadowConsentWriteResult> {
    if (!isSafeParticipant(participantId)) {
      return this.reject(participantId, 'unsafe_participant', 'participantId is outside the safe-code pattern');
    }
    if (!isInstant(at)) {
      return this.reject(participantId, 'malformed_instant', `not an ISO instant with an explicit offset: ${String(at)}`);
    }
    const existing = await this.read(participantId);
    if (existing.state === 'withheld') {
      // A revocation of a consent that was never granted is not a revocation,
      // and `ShadowRevokedConsent` has no shape for it — its `grantedAt` is
      // non-null by construction.
      return this.reject(participantId, 'nothing_to_revoke', 'this participant has no granted consent to withdraw');
    }
    if (existing.state === 'revoked') {
      return this.reject(participantId, 'already_revoked', `consent was already withdrawn at ${existing.revokedAt}`);
    }
    const elapsed = millisBetweenInstants(existing.grantedAt, at);
    if (elapsed === null || elapsed < 0) {
      return this.reject(
        participantId,
        'backdated',
        `a consent granted at ${existing.grantedAt} cannot be withdrawn at ${at}`,
      );
    }
    await this.storage.set<StoredConsent>(documentPath(participantId), {
      version: SHADOW_STUDY_CONSENT_SCHEMA_VERSION,
      participantId,
      state: 'revoked',
      scopes: [],
      grantedAt: existing.grantedAt,
      revokedAt: at,
    });
    return { status: 'written', consent: await this.read(participantId) };
  }

  async deleteParticipant(participantId: string): Promise<number> {
    if (!isSafeParticipant(participantId)) return 0;
    const path = documentPath(participantId);
    const existed = (await this.stored(participantId)) !== null;
    if (existed) await this.storage.delete(path);
    return existed ? 1 : 0;
  }

  async countFor(participantId: string): Promise<number> {
    if (!isSafeParticipant(participantId)) return 0;
    return (await this.stored(participantId)) === null ? 0 : 1;
  }

  /**
   * A collection-group read over `consents`, filtered to this store's own
   * documents by schema version — the personalization consent shares the
   * collection and must not appear here.
   */
  async listParticipants(): Promise<readonly string[]> {
    const rows = await this.storage.listGroup<StoredConsent>(CONSENTS);
    return rows
      .filter((row) => isStoredConsent(row.data))
      .map((row) => row.data.participantId);
  }
}

/**
 * The same implementation over a private in-memory adapter, so a test cannot
 * exercise semantics production does not have.
 */
export class MemoryShadowStudyConsentStore extends StorageShadowStudyConsentStore {
  constructor() {
    super(createMemoryStorage());
  }
}

export function createStorageShadowStudyConsentStore(storage?: StorageAdapter): ShadowStudyConsentStore {
  return new StorageShadowStudyConsentStore(storage);
}

export function createInMemoryShadowStudyConsentStore(): ShadowStudyConsentStore {
  return new MemoryShadowStudyConsentStore();
}
