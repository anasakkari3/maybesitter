/**
 * Runtime memory contracts (Sprint 02, issue #10).
 *
 * Runtime memory covers the memory kinds that src/domain/memory declares but
 * leaves disabled (`fact`, `preference`, `hypothesis`). The canonical
 * commitment and observation stores in src/domain/memory are unaffected by
 * this contract.
 *
 * Three privacy properties are structural here, not conventions:
 *
 *  1. Conflicting memories stay inspectable. Superseding a record never
 *     destroys the prior one; retrieve() hides it while listAll() still shows
 *     the chain.
 *
 *  2. Revocation and deletion are different. revoke() hides a record from
 *     retrieval but keeps it auditable; deleteById()/deleteScope() remove it
 *     outright.
 *
 *  3. Personal memory never reaches fine-tuning data. Every record carries an
 *     exportPolicy defaulting to `personal_never_export`, and
 *     assertNoPersonalMemory() enforces it. This is separate from the user's
 *     own data export (MemoryExport), which deliberately includes their
 *     personal records.
 */

export const MEMORY_RECORD_SCHEMA_VERSION = 'runtime-memory-v1' as const;

/** Default record lifetime before a record goes stale: 90 days. */
export const DEFAULT_MEMORY_TTL_MS = 90 * 24 * 60 * 60 * 1_000;

/**
 * The kinds MemoryKind declares but EnabledMemoryKind withholds from the
 * canonical path. Runtime memory owns exactly these.
 */
export type RuntimeMemoryKind = 'fact' | 'preference' | 'hypothesis';

export type MemorySource = 'user_stated' | 'deterministic_rule' | 'model_inferred';

export type MemoryLanguage = 'ar' | 'he' | 'en' | 'mixed';

export type MemoryStatus = 'active' | 'superseded' | 'revoked' | 'expired';

/**
 * Whether a record may leave the user's own scope.
 *
 * `personal_never_export` is the default and covers anything derived from a
 * specific user. `shareable_aggregate` is reserved for records that carry no
 * personal content; nothing in Sprint 02 produces one automatically.
 */
export type ExportPolicy = 'personal_never_export' | 'shareable_aggregate';

export interface RuntimeMemoryRecord {
  readonly version: typeof MEMORY_RECORD_SCHEMA_VERSION;
  readonly id: string;
  readonly scopeId: string;
  readonly kind: RuntimeMemoryKind;
  readonly content: string;
  readonly language: MemoryLanguage;
  readonly source: MemorySource;
  /** 0..1 inclusive. */
  readonly confidence: number;
  readonly exportPolicy: ExportPolicy;
  readonly status: MemoryStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** When the underlying fact was observed, which may precede createdAt. */
  readonly observedAt: string;
  /** ISO boundary past which the record is stale; prune() expires it. */
  readonly staleAfter: string;
  readonly supersedesId?: string;
  readonly supersededById?: string;
  readonly revokedAt?: string;
  /** Observation ids backing this memory. */
  readonly evidenceIds: readonly string[];
}

/**
 * Caller-supplied fields only. Server-assigned fields (id, version, status,
 * createdAt, updatedAt, staleAfter, supersession links, revokedAt) are never
 * accepted from callers.
 */
export interface CreateMemoryInput {
  readonly scopeId: string;
  readonly kind: RuntimeMemoryKind;
  readonly content: string;
  readonly language: MemoryLanguage;
  readonly source: MemorySource;
  readonly confidence: number;
  readonly observedAt: string;
  readonly evidenceIds?: readonly string[];
  /** Defaults to 'personal_never_export'. */
  readonly exportPolicy?: ExportPolicy;
  /** Overrides the store's defaultTtlMs for this record. */
  readonly ttlMs?: number;
}

/**
 * Retrieval query. retrieve() always additionally filters to
 * `status === 'active'` and `staleAfter > now`, so revoked, superseded, and
 * expired records can never reach a consumer.
 */
export interface MemoryQuery {
  readonly scopeId: string;
  readonly kind?: RuntimeMemoryKind;
  readonly minConfidence?: number;
  readonly language?: MemoryLanguage;
  readonly limit?: number;
  /** ISO "now" for staleness comparison; required to keep retrieval pure. */
  readonly now: string;
}

/**
 * The user's own data export for one scope. This intentionally includes
 * personal records — it exists to satisfy the user's right to their data, and
 * is a different path from fine-tuning export.
 */
export interface MemoryExport {
  readonly version: typeof MEMORY_RECORD_SCHEMA_VERSION;
  readonly scopeId: string;
  readonly exportedAt: string;
  readonly records: readonly RuntimeMemoryRecord[];
}

export interface RuntimeMemoryStore {
  put(input: CreateMemoryInput, now: string): RuntimeMemoryRecord;
  get(id: string): RuntimeMemoryRecord | null;
  /** Active, non-stale records only. The only read path for consumers. */
  retrieve(query: MemoryQuery): readonly RuntimeMemoryRecord[];
  /** Every record in the scope regardless of status, for user inspection. */
  listAll(scopeId: string): readonly RuntimeMemoryRecord[];
  /** Writes a replacement and marks the prior record superseded, keeping both. */
  supersede(oldId: string, input: CreateMemoryInput, now: string): RuntimeMemoryRecord;
  /** Hides from retrieval, keeps inspectable. Returns false if not found. */
  revoke(id: string, at: string): boolean;
  /** Removes outright. Returns false if not found. */
  deleteById(id: string): boolean;
  /** Removes every record in a scope. Returns the number deleted. */
  deleteScope(scopeId: string): number;
  export(scopeId: string, now: string): MemoryExport;
  /** Marks records past staleAfter as expired. Returns the number expired. */
  prune(now: string): number;
}

export interface RuntimeMemoryStoreOptions {
  readonly dataDir?: string;
  readonly defaultTtlMs?: number;
}
