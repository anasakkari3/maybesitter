/**
 * Behavioural feedback counters, on durable storage (UC-1.0c, #142).
 *
 * ── What this replaced ───────────────────────────────────────────
 *
 * One `behavior-feedback.json` holding *every* scope's counters, rewritten
 * whole on each increment. Two problems, both of which this fixes:
 *
 *   1. It was one file on a per-instance filesystem, so on Cloud Run the
 *      counters that drive tone and pressure were lost on every deploy and
 *      differed between instances — the assistant would read one user as
 *      avoidant on one request and disciplined on the next.
 *   2. Read-modify-write of a whole-file document has no isolation, so two
 *      increments landing together lost one. An undercounted "ignored" is not
 *      a rounding error: it is the signal that decides how hard to push.
 *
 * Counters now live at `users/{uid}/behaviorFeedback/{sha256(scopeId)}`, and
 * `record` runs its read and its write inside one transaction, so concurrent
 * increments queue instead of overwriting each other.
 *
 * ── One implementation, two backends ─────────────────────────────
 *
 * `MemoryBehaviorFeedbackStore` is the same class over `createMemoryStorage()`
 * rather than a second implementation. The sibling alpha stores duplicated
 * their logic per backend and their in-memory `prune()` quietly drifted into a
 * no-op; behaviour that decides how hard to push a person must not be able to
 * differ between a test store and a production one.
 */
import {
  BEHAVIOR_FEEDBACK,
  createMemoryStorage,
  docIdForKey,
  getStorage,
  userCol,
  userIdForKey,
  type StorageAdapter,
} from '../storage';

export type BehaviorFeedbackEvent =
  | 'suggestion_ignored'
  | 'action_completed'
  | 'action_delayed'
  | 'clarification_succeeded'
  | 'clarification_failed';

export interface BehaviorFeedbackScopeOptions {
  sessionId?: string;
  userId?: string;
  conversationId?: string;
  feedbackScopeId?: string;
}

export interface BehaviorFeedbackRecord {
  ignoredSuggestions: number;
  completedActions: number;
  delayedActions: number;
  clarificationSuccesses: number;
  clarificationFailures: number;
  updatedAt: string | null;
}

export interface BehaviorFeedbackSignals {
  ignoredCommitmentsCount?: number;
  completionRate?: number;
  delayFrequency?: number;
  clarificationFrequency?: number;
}

/** Async since UC-1.0c (#142): every method is a storage round trip. */
export interface BehaviorFeedbackStore {
  get(scopeId: string): Promise<BehaviorFeedbackRecord>;
  record(scopeId: string, event: BehaviorFeedbackEvent, at: string): Promise<BehaviorFeedbackRecord>;
  clear(scopeId?: string): Promise<void>;
}

/** The stored document: the counters plus the raw scope they belong to. */
interface StoredBehaviorFeedback extends BehaviorFeedbackRecord {
  scopeId: string;
}

const DEFAULT_FEEDBACK_SCOPE_ID = 'local';

function emptyRecord(): BehaviorFeedbackRecord {
  return {
    ignoredSuggestions: 0,
    completedActions: 0,
    delayedActions: 0,
    clarificationSuccesses: 0,
    clarificationFailures: 0,
    updatedAt: null,
  };
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** A hand-edited or half-written document must not surface as a partial record. */
function normalizeRecord(raw: unknown): BehaviorFeedbackRecord {
  if (!raw || typeof raw !== 'object') return emptyRecord();
  const record = raw as Partial<BehaviorFeedbackRecord>;
  return {
    ignoredSuggestions: count(record.ignoredSuggestions),
    completedActions: count(record.completedActions),
    delayedActions: count(record.delayedActions),
    clarificationSuccesses: count(record.clarificationSuccesses),
    clarificationFailures: count(record.clarificationFailures),
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : null,
  };
}

function increment(record: BehaviorFeedbackRecord, event: BehaviorFeedbackEvent, at: string): BehaviorFeedbackRecord {
  const next = { ...record, updatedAt: at };
  if (event === 'suggestion_ignored') next.ignoredSuggestions += 1;
  if (event === 'action_completed') next.completedActions += 1;
  if (event === 'action_delayed') next.delayedActions += 1;
  if (event === 'clarification_succeeded') next.clarificationSuccesses += 1;
  if (event === 'clarification_failed') next.clarificationFailures += 1;
  return next;
}

export function scopeBehaviorFeedback(options: BehaviorFeedbackScopeOptions = {}): string {
  const scope = options.feedbackScopeId || options.conversationId || options.sessionId || options.userId;
  return typeof scope === 'string' && scope.trim() ? scope.trim() : DEFAULT_FEEDBACK_SCOPE_ID;
}

/**
 * The scope key is the uid, per UC-1.0c's decision, and the document id is the
 * hash of the same key (the issue's `{sha256(scope)}`). The raw scope is kept
 * in a field so a record stays findable when the id is a digest.
 */
function documentPath(scopeId: string): string {
  return `${userCol(userIdForKey(scopeId), BEHAVIOR_FEEDBACK)}/${docIdForKey(scopeId)}`;
}

export class StorageBehaviorFeedbackStore implements BehaviorFeedbackStore {
  constructor(private readonly injected?: StorageAdapter) {}

  /** Resolved per call so a test may swap the adapter after construction. */
  private get storage(): StorageAdapter {
    return this.injected ?? getStorage();
  }

  async get(scopeId: string): Promise<BehaviorFeedbackRecord> {
    const stored = await this.storage.get<StoredBehaviorFeedback>(documentPath(scopeId));
    return stored ? normalizeRecord(stored) : emptyRecord();
  }

  /**
   * Read and write in one transaction. The file-backed version read the whole
   * document, incremented, and wrote it back with no isolation, so two
   * increments arriving together lost one.
   */
  async record(scopeId: string, event: BehaviorFeedbackEvent, at: string): Promise<BehaviorFeedbackRecord> {
    const path = documentPath(scopeId);
    return this.storage.runTransaction(async (tx) => {
      const current = await tx.get<StoredBehaviorFeedback>(path);
      const next = increment(current ? normalizeRecord(current) : emptyRecord(), event, at);
      tx.set<StoredBehaviorFeedback>(path, { ...next, scopeId });
      return next;
    });
  }

  async clear(scopeId?: string): Promise<void> {
    if (scopeId) {
      await this.storage.delete(documentPath(scopeId));
      return;
    }
    // No scope named: clear every scope this store can see. Used by tests and
    // by the legacy "forget my history" path.
    const rows = await this.storage.listGroup<StoredBehaviorFeedback>(BEHAVIOR_FEEDBACK);
    for (const row of rows) await this.storage.delete(row.path);
  }
}

/**
 * The same implementation over a private in-memory adapter, so a test cannot
 * exercise semantics that production does not have.
 */
export class MemoryBehaviorFeedbackStore extends StorageBehaviorFeedbackStore {
  constructor() {
    super(createMemoryStorage());
  }
}

export function createDefaultBehaviorFeedbackStore(): BehaviorFeedbackStore {
  return new StorageBehaviorFeedbackStore();
}

export async function recordBehaviorFeedback(
  event: BehaviorFeedbackEvent,
  options: BehaviorFeedbackScopeOptions & { now?: Date; feedbackStore?: BehaviorFeedbackStore } = {}
): Promise<BehaviorFeedbackRecord> {
  const store = options.feedbackStore || createDefaultBehaviorFeedbackStore();
  return store.record(scopeBehaviorFeedback(options), event, (options.now || new Date()).toISOString());
}

export async function getBehaviorFeedbackSignals(
  options: BehaviorFeedbackScopeOptions & { feedbackStore?: BehaviorFeedbackStore } = {}
): Promise<BehaviorFeedbackSignals> {
  const record = await (options.feedbackStore || createDefaultBehaviorFeedbackStore())
    .get(scopeBehaviorFeedback(options));
  const actionTotal = record.completedActions + record.ignoredSuggestions + record.delayedActions;
  const clarificationTotal = record.clarificationSuccesses + record.clarificationFailures;

  return {
    ignoredCommitmentsCount: record.ignoredSuggestions || undefined,
    completionRate: actionTotal > 0 ? (record.completedActions + 1) / (actionTotal + 1) : undefined,
    delayFrequency: actionTotal > 0 ? record.delayedActions / actionTotal : undefined,
    clarificationFrequency: clarificationTotal > 0 ? record.clarificationFailures / (clarificationTotal + 1) : undefined,
  };
}

export async function clearBehaviorFeedbackHistory(
  store: BehaviorFeedbackStore = createDefaultBehaviorFeedbackStore(),
  scopeId?: string
): Promise<void> {
  await store.clear(scopeId);
}
