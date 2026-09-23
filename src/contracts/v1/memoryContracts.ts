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
 * How long something the user said themselves stays true: ten years, which is
 * this store's way of saying "until they change it" (UC-2.7a, #167).
 *
 * The 90-day default is calibrated for an *inference* — a guess about someone
 * drawn from their behaviour should have to be re-earned. A routine answer is
 * not a guess. Nobody's declared sleep window becomes false because a quarter
 * went by, and letting one expire would quietly drop it out of `retrieve`,
 * out of the planner, and off the memory screen, with no event the user could
 * have seen and nothing they could have done to prevent it.
 *
 * A user-stated fact leaves the store when the user supersedes it, revokes it
 * or deletes it. Those are the only three, and all three are their own action.
 */
export const USER_STATED_MEMORY_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1_000;

/**
 * The kinds MemoryKind declares but EnabledMemoryKind withholds from the
 * canonical path. Runtime memory owns exactly these.
 *
 * `goal` joined them in UC-2.7a (#167). A goal is not a preference — "finish
 * the thesis by March" is a thing the user is trying to reach, with a target
 * date and a done state, where "I sleep at 22:30" is a standing fact about how
 * they live. Ranking (UC-2.8, #169) and the next step (UC-2.9, #170) treat the
 * two differently, so filing a goal as a preference would make it invisible to
 * the code that is supposed to act on it.
 */
export type RuntimeMemoryKind = 'fact' | 'preference' | 'hypothesis' | 'goal';

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

/**
 * Where a fact came from (UC-2.7a, #167).
 *
 * `source` already says *what kind of thing* asserted the fact — the user, a
 * rule, or a model. This says *which path* it arrived by, which is the part
 * the user is shown: "You said", "From onboarding", "Suggested by AI, you
 * confirmed". The two are deliberately not merged, and `source` is deliberately
 * not repeated here: one field that can contradict another is a field that
 * eventually will, and the record's own `source` is the single answer.
 *
 * Optional on the record. Records written before #167 have none, and a shape
 * guard that rejected them would make a user's existing memory disappear
 * rather than display without a chip.
 */
export type MemoryOrigin =
  | 'routine_survey'
  | 'self_description'
  | 'manual'
  | 'capture'
  /**
   * A deterministic rule noticed it in what the user did, and the user pressed
   * Keep (UC-3.16, #202). `originRef` is the rule's fingerprint — the claim that
   * was kept — and `confirmedByUserAt` is when they kept it.
   */
  | 'behaviour_rule'
  /**
   * The user brought a profile another AI assistant had written about them,
   * and kept this line of it. Distinct from `self_description` on purpose:
   * that is what the user typed, this is what somebody else's model said, and
   * the screen is allowed to tell them apart. `provenance.assistant` names
   * which one, and `originRef` is the import proposal id.
   */
  | 'ai_context_import';

export const MEMORY_ORIGINS: readonly MemoryOrigin[] = [
  'routine_survey',
  'self_description',
  'manual',
  'capture',
  'behaviour_rule',
  'ai_context_import',
];

export interface MemoryProvenance {
  readonly origin: MemoryOrigin;
  /** The proposal id, or the survey version that produced this fact. */
  readonly originRef?: string;
  /** The model id, when a model proposed it. Never set for a user-stated fact. */
  readonly model?: string;
  readonly promptVersion?: string;
  /**
   * When the user explicitly confirmed a suggestion. Absent means nobody
   * confirmed it, which is what separates "AI guessed" from "AI guessed and
   * you agreed" on the screen — and nothing model-inferred is stored without
   * this being set (UC-2.7b, #168).
   */
  readonly confirmedByUserAt?: string;
  /**
   * Which assistant an imported claim came from. Only ever set alongside
   * `origin: 'ai_context_import'`.
   *
   * It is a field rather than a prefix on `originRef` because `originRef` means
   * "the proposal that produced this" for every other origin, and because a
   * colon-delimited key the phone has to split is the shape this repo already
   * refused for the behaviour-rule window. It is not `model` either: that field
   * throws unless the record is `model_inferred`, so a user-edited import row
   * could not carry it, and the name of somebody else's product is not the
   * model we called.
   */
  readonly assistant?: 'chatgpt' | 'gemini' | 'claude' | 'other';
}

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
  /** How this fact reached the store. Absent on records written before #167. */
  readonly provenance?: MemoryProvenance;
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
  readonly provenance?: MemoryProvenance;
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

/**
 * Every method is async since UC-1.0c (#142): memory lives at
 * `users/{uid}/memory/{memoryId}` on the storage adapter, so each call is a
 * round trip rather than a file read. The semantics below are unchanged — what
 * moved is where the records are, not what the verbs mean.
 */
export interface RuntimeMemoryStore {
  put(input: CreateMemoryInput, now: string): Promise<RuntimeMemoryRecord>;
  get(id: string): Promise<RuntimeMemoryRecord | null>;
  /** Active, non-stale records only. The only read path for consumers. */
  retrieve(query: MemoryQuery): Promise<readonly RuntimeMemoryRecord[]>;
  /** Every record in the scope regardless of status, for user inspection. */
  listAll(scopeId: string): Promise<readonly RuntimeMemoryRecord[]>;
  /** Writes a replacement and marks the prior record superseded, keeping both. */
  supersede(oldId: string, input: CreateMemoryInput, now: string): Promise<RuntimeMemoryRecord>;
  /** Hides from retrieval, keeps inspectable. Returns false if not found. */
  revoke(id: string, at: string): Promise<boolean>;
  /** Removes outright. Returns false if not found. */
  deleteById(id: string): Promise<boolean>;
  /** Removes every record in a scope. Returns the number deleted. */
  deleteScope(scopeId: string): Promise<number>;
  export(scopeId: string, now: string): Promise<MemoryExport>;
  /** Marks records past staleAfter as expired. Returns the number expired. */
  prune(now: string): Promise<number>;
}

export interface RuntimeMemoryStoreOptions {
  readonly defaultTtlMs?: number;
}
