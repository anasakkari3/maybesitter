/**
 * Alpha interaction traces, in the participant's own tree (UC-1.0c, #142).
 *
 * ── What this replaced ───────────────────────────────────────────
 *
 * One `<dataDir>/alpha-traces/<sessionId>.trace.json` per session, on the
 * local filesystem. A trace holds the participant's **raw capture text**, so
 * this was the most sensitive thing still sitting on a per-instance disk: it
 * survived no deploy, it was invisible to the instance that did not write it,
 * and it was outside the user tree, which meant account deletion did not reach
 * it. Traces now live at `users/{uid}/alphaTraces/{sessionId}` and go with the
 * account.
 *
 * Retention is the `expiresAt` stamp Firestore's TTL reads, written at 30 days
 * — the constant that used to live in `scripts/alpha-trace-prune.ts`, which is
 * deleted. A prune script that stops being run fails silently and the raw text
 * simply stays; a TTL policy is enforced by the database.
 *
 * ── Two lookups take a session id and no participant ─────────────
 *
 * `get` and `deleteSession` are addressed by session alone, but the path needs
 * a uid. They resolve through a collection-group query on `sessionId` rather
 * than by asking the caller for an owner they do not have — which also keeps
 * the ownership rule below honest, since a caller cannot influence the lookup
 * by naming a different participant.
 *
 * ── The ownership rule is kept, and it is load-bearing ───────────
 *
 * `assertOwner` predates this migration and the reason for it does not change:
 * without it the store rewrote `participantId` on every append while keeping
 * the existing stages, so anyone who guessed a session id became its owner —
 * exposing the previous owner's raw capture text through the trace read route
 * and making their deletion request match nothing.
 */
import {
  ALPHA_TRACE_VERSION,
  type AlphaTraceSession,
  type AlphaTraceStageRecord,
  type AlphaTraceSummary,
} from '../../src/contracts/v1/alphaTraceContracts';
import {
  ALPHA_TRACES,
  createMemoryStorage,
  getStorage,
  requireDocId,
  userCol,
  userIdForKey,
  type StorageAdapter,
} from '../storage';

export interface AlphaTraceStoreOptions {
  storage?: StorageAdapter;
  retentionTtlMs?: number;
}

/** Async since UC-1.0c (#142): every method is a storage round trip. */
export interface AlphaTraceStore {
  append(sessionId: string, participantId: string, stage: AlphaTraceStageRecord): Promise<AlphaTraceSession>;
  get(sessionId: string): Promise<AlphaTraceSession | null>;
  listSummaries(options?: { participantId?: string; withFeedbackOnly?: boolean }): Promise<AlphaTraceSummary[]>;
  deleteSession(sessionId: string): Promise<boolean>;
  deleteParticipant(participantId: string): Promise<number>;
  prune(): Promise<number>;
}

export const DEFAULT_RETENTION_TTL_MS = 30 * 24 * 60 * 60 * 1_000; // 30 days

/**
 * A session id is an opaque token, never a path segment the caller gets to
 * shape.
 *
 * It arrives from the request body, so an unvalidated one was both an
 * arbitrary file write outside the data dir and a way to name another
 * participant's session. Anything outside this alphabet is rejected rather
 * than sanitised: a rewritten id would silently split one session in two.
 */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidTraceSessionId(sessionId: string): boolean {
  return SESSION_ID.test(sessionId);
}

function assertSessionId(sessionId: string): void {
  if (!isValidTraceSessionId(sessionId)) {
    throw new Error('alpha trace: session id must be 1-128 chars of [A-Za-z0-9_-]');
  }
}

function assertOwner(existing: AlphaTraceSession | null, participantId: string): void {
  if (existing && existing.participantId !== participantId) {
    throw new Error('alpha trace: session belongs to a different participant');
  }
}

/** The session plus the retention stamp the TTL policy reads. */
interface StoredTrace extends AlphaTraceSession {
  expiresAt: Date;
}

function toSession(stored: StoredTrace): AlphaTraceSession {
  const { expiresAt: _retention, ...session } = stored;
  return session as AlphaTraceSession;
}

function toSummary(session: AlphaTraceSession): AlphaTraceSummary {
  const stages = session.stages.map((s) => s.stage);
  return {
    sessionId: session.sessionId,
    participantId: session.participantId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    stageCount: session.stages.length,
    stages,
    hasDecisions: stages.some((s) => s === 'proposal_decided'),
    hasFeedback: stages.some((s) => s === 'feedback_flagged'),
    hasErrors: session.stages.some((s) => s.payload && typeof s.payload === 'object' && 'error' in s.payload && Boolean(s.payload.error)),
  };
}

function tracePath(participantId: string, sessionId: string): string {
  return `${userCol(userIdForKey(participantId), ALPHA_TRACES)}/${requireDocId(sessionId)}`;
}

export class StorageAlphaTraceStore implements AlphaTraceStore {
  private readonly retentionTtlMs: number;

  constructor(private readonly options: AlphaTraceStoreOptions = {}) {
    this.retentionTtlMs = options.retentionTtlMs ?? DEFAULT_RETENTION_TTL_MS;
  }

  /** Resolved per call so a test may swap the adapter after construction. */
  private get storage(): StorageAdapter {
    return this.options.storage ?? getStorage();
  }

  /** Every trace, with its path, for the session- and cross-participant reads. */
  private async all(): Promise<Array<{ path: string; session: AlphaTraceSession }>> {
    const rows = await this.storage.listGroup<StoredTrace>(ALPHA_TRACES);
    return rows
      .filter((row) => row.data && row.data.version === ALPHA_TRACE_VERSION)
      .map((row) => ({ path: row.path, session: toSession(row.data) }))
      .sort((a, b) => a.session.updatedAt.localeCompare(b.session.updatedAt));
  }

  private async findBySession(sessionId: string): Promise<{ path: string; session: AlphaTraceSession } | null> {
    const rows = await this.storage.listGroup<StoredTrace>(ALPHA_TRACES, {
      where: [['sessionId', '==', sessionId]],
      limit: 1,
    });
    const row = rows[0];
    return row ? { path: row.path, session: toSession(row.data) } : null;
  }

  async append(sessionId: string, participantId: string, stage: AlphaTraceStageRecord): Promise<AlphaTraceSession> {
    assertSessionId(sessionId);
    // Looked up by session rather than by the caller's own path, so a caller
    // naming a different participant cannot dodge the ownership check.
    const held = await this.findBySession(sessionId);
    assertOwner(held?.session ?? null, participantId);

    const now = new Date().toISOString();
    const session: AlphaTraceSession = {
      version: ALPHA_TRACE_VERSION,
      sessionId,
      participantId,
      createdAt: held?.session.createdAt ?? now,
      updatedAt: now,
      stages: [...(held?.session.stages ?? []), stage],
    };
    await this.storage.set<StoredTrace>(tracePath(participantId, sessionId), {
      ...session,
      expiresAt: new Date(Date.parse(now) + this.retentionTtlMs),
    });
    return session;
  }

  async get(sessionId: string): Promise<AlphaTraceSession | null> {
    // A lookup names nothing rather than throwing: the id reaches here straight
    // off a query string, and a malformed one is a 404, not a 500. The write
    // path still refuses loudly.
    if (!isValidTraceSessionId(sessionId)) return null;
    return (await this.findBySession(sessionId))?.session ?? null;
  }

  async listSummaries(filter?: { participantId?: string; withFeedbackOnly?: boolean }): Promise<AlphaTraceSummary[]> {
    const held = filter?.participantId
      ? (await this.storage.list<StoredTrace>(userCol(userIdForKey(filter.participantId), ALPHA_TRACES)))
        .map((row) => ({ session: toSession(row.data) }))
        .sort((a, b) => a.session.updatedAt.localeCompare(b.session.updatedAt))
      : await this.all();

    return held
      .filter(({ session }) => !filter?.withFeedbackOnly || toSummary(session).hasFeedback)
      .map(({ session }) => toSummary(session));
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    if (!isValidTraceSessionId(sessionId)) return false;
    const held = await this.findBySession(sessionId);
    if (!held) return false;
    await this.storage.delete(held.path);
    return true;
  }

  async deleteParticipant(participantId: string): Promise<number> {
    const collection = userCol(userIdForKey(participantId), ALPHA_TRACES);
    const rows = await this.storage.list<StoredTrace>(collection);
    for (const row of rows) await this.storage.delete(`${collection}/${row.id}`);
    return rows.length;
  }

  /**
   * Belt-and-braces against the TTL policy, which is eventual. Retention is
   * enforced by Firestore; this exists so an operator can force the sweep.
   */
  async prune(): Promise<number> {
    const cutoff = new Date(Date.now() - this.retentionTtlMs).toISOString();
    let pruned = 0;
    for (const { path, session } of await this.all()) {
      if (session.updatedAt < cutoff) {
        await this.storage.delete(path);
        pruned += 1;
      }
    }
    return pruned;
  }
}

/**
 * The same implementation over a private in-memory adapter, so a test cannot
 * exercise semantics production does not have. Seeded sessions are written
 * through `append`-equivalent paths so they are shaped identically.
 */
export function createInMemoryAlphaTraceStore(sessions?: AlphaTraceSession[]): AlphaTraceStore {
  const storage = createMemoryStorage();
  const store = new StorageAlphaTraceStore({ storage });
  const seeded = (async () => {
    for (const session of sessions ?? []) {
      await storage.set<StoredTrace>(tracePath(session.participantId, session.sessionId), {
        ...session,
        expiresAt: new Date(Date.parse(session.updatedAt) + DEFAULT_RETENTION_TTL_MS),
      });
    }
  })();

  // Every method waits for the seed, so a constructor that cannot be async
  // still yields a fully-populated store on first use.
  return {
    append: async (...args) => { await seeded; return store.append(...args); },
    get: async (...args) => { await seeded; return store.get(...args); },
    listSummaries: async (...args) => { await seeded; return store.listSummaries(...args); },
    deleteSession: async (...args) => { await seeded; return store.deleteSession(...args); },
    deleteParticipant: async (...args) => { await seeded; return store.deleteParticipant(...args); },
    prune: async () => { await seeded; return store.prune(); },
  };
}

export function createStorageAlphaTraceStore(options?: AlphaTraceStoreOptions): AlphaTraceStore {
  return new StorageAlphaTraceStore(options);
}
