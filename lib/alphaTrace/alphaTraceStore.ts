/**
 * Alpha interaction trace store.
 *
 * Bounded-retention, delete-supporting, access-bounded store for alpha trace
 * sessions. Records are kept per session and pruned after a configurable TTL.
 * Content is only accessible via explicit store methods; it is never sent to
 * analytics.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  ALPHA_TRACE_VERSION,
  type AlphaTraceSession,
  type AlphaTraceStageRecord,
  type AlphaTraceSummary,
} from '../../src/contracts/v1/alphaTraceContracts';

export interface AlphaTraceStoreOptions {
  dataDir?: string;
  retentionTtlMs?: number;
}

export interface AlphaTraceStore {
  append(sessionId: string, participantId: string, stage: AlphaTraceStageRecord): AlphaTraceSession;
  get(sessionId: string): AlphaTraceSession | null;
  listSummaries(options?: { participantId?: string; withFeedbackOnly?: boolean }): AlphaTraceSummary[];
  deleteSession(sessionId: string): boolean;
  deleteParticipant(participantId: string): number;
  prune(): number;
}

const DEFAULT_DATA_DIR = path.join(process.cwd(), '.maybesitter', 'alpha-traces');
const DEFAULT_RETENTION_TTL_MS = 30 * 24 * 60 * 60 * 1_000; // 30 days
const TRACE_FILE_EXT = '.trace.json';

/**
 * A session id is an opaque token, never a path segment and never a filename
 * fragment the caller gets to shape.
 *
 * It arrives from the request body, so an unvalidated one is both an arbitrary
 * file write outside the data dir and a way to name another participant's
 * session. Anything outside this alphabet is rejected rather than sanitised:
 * a rewritten id would silently split one session in two.
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

/**
 * A session belongs to the participant who opened it, for its whole life.
 *
 * Without this the store rewrote `participantId` on every append while keeping
 * the existing stages, so anyone who guessed a session id became its owner --
 * which both exposed the previous owner's raw capture text through the trace
 * read route and made their deletion request match nothing.
 */
function assertOwner(existing: AlphaTraceSession | null, participantId: string): void {
  if (existing && existing.participantId !== participantId) {
    throw new Error('alpha trace: session belongs to a different participant');
  }
}

function sessionFilePath(dataDir: string, sessionId: string): string {
  assertSessionId(sessionId);
  return path.join(dataDir, `${sessionId}${TRACE_FILE_EXT}`);
}

function readSession(filePath: string): AlphaTraceSession | null {
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    if (raw && raw.version === ALPHA_TRACE_VERSION && typeof raw.sessionId === 'string') return raw;
  } catch {
    // corrupt or missing
  }
  return null;
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

export function createFileAlphaTraceStore(options?: AlphaTraceStoreOptions): AlphaTraceStore {
  const dataDir = options?.dataDir ?? DEFAULT_DATA_DIR;
  const retentionTtlMs = options?.retentionTtlMs ?? DEFAULT_RETENTION_TTL_MS;

  function ensureDir(): void {
    mkdirSync(dataDir, { recursive: true });
  }

  function loadAll(): AlphaTraceSession[] {
    ensureDir();
    return readdirSync(dataDir)
      .filter((e) => e.endsWith(TRACE_FILE_EXT))
      .map((entry) => {
        const session = readSession(path.join(dataDir, entry));
        if (!session) return null;
        // The filename is the authority, not the id inside the file. Deletion
        // and pruning both delete by the id they read here, so a file whose
        // contents disagree with its name -- anything written before session
        // ids were validated -- would otherwise be unreachable by either, and
        // a participant's deletion request would quietly skip it.
        return { ...session, sessionId: entry.slice(0, -TRACE_FILE_EXT.length) };
      })
      .filter((s): s is AlphaTraceSession => s !== null)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  }

  return {
    append(sessionId, participantId, stage): AlphaTraceSession {
      ensureDir();
      const filePath = sessionFilePath(dataDir, sessionId);
      const existing = existsSync(filePath) ? readSession(filePath) : null;
      assertOwner(existing, participantId);
      const now = new Date().toISOString();
      const session: AlphaTraceSession = {
        version: ALPHA_TRACE_VERSION,
        sessionId,
        participantId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        stages: [...(existing?.stages ?? []), stage],
      };
      writeFileSync(filePath, JSON.stringify(session, null, 2));
      return session;
    },

    get(sessionId): AlphaTraceSession | null {
      // A lookup names nothing rather than throwing: the id reaches here
      // straight off a query string, and a malformed one is a 404, not a 500.
      // The write path still refuses loudly.
      if (!isValidTraceSessionId(sessionId)) return null;
      ensureDir();
      const filePath = sessionFilePath(dataDir, sessionId);
      return existsSync(filePath) ? readSession(filePath) : null;
    },

    listSummaries(filter): AlphaTraceSummary[] {
      return loadAll()
        .filter((s) => {
          if (filter?.participantId && s.participantId !== filter.participantId) return false;
          if (filter?.withFeedbackOnly && !toSummary(s).hasFeedback) return false;
          return true;
        })
        .map(toSummary);
    },

    deleteSession(sessionId): boolean {
      if (!isValidTraceSessionId(sessionId)) return false;
      ensureDir();
      const filePath = sessionFilePath(dataDir, sessionId);
      if (!existsSync(filePath)) return false;
      unlinkSync(filePath);
      return true;
    },

    deleteParticipant(participantId): number {
      let deleted = 0;
      for (const session of loadAll()) {
        if (session.participantId === participantId && this.deleteSession(session.sessionId)) deleted++;
      }
      return deleted;
    },

    prune(): number {
      const cutoff = new Date(Date.now() - retentionTtlMs).toISOString();
      let pruned = 0;
      for (const session of loadAll()) {
        if (session.updatedAt < cutoff) {
          if (this.deleteSession(session.sessionId)) pruned++;
        }
      }
      return pruned;
    },
  };
}

export function createInMemoryAlphaTraceStore(sessions?: AlphaTraceSession[]): AlphaTraceStore {
  const map = new Map<string, AlphaTraceSession>();
  for (const session of sessions ?? []) map.set(session.sessionId, session);
  return {
    append(sessionId, participantId, stage): AlphaTraceSession {
      assertSessionId(sessionId);
      const existing = map.get(sessionId) ?? null;
      assertOwner(existing, participantId);
      const now = new Date().toISOString();
      const session: AlphaTraceSession = {
        version: ALPHA_TRACE_VERSION,
        sessionId,
        participantId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        stages: [...(existing?.stages ?? []), stage],
      };
      map.set(sessionId, session);
      return session;
    },
    get(sessionId): AlphaTraceSession | null {
      return map.get(sessionId) ?? null;
    },
    listSummaries(filter): AlphaTraceSummary[] {
      return Array.from(map.values())
        .filter((s) => {
          if (filter?.participantId && s.participantId !== filter.participantId) return false;
          if (filter?.withFeedbackOnly && !toSummary(s).hasFeedback) return false;
          return true;
        })
        .map(toSummary)
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    },
    deleteSession(sessionId): boolean {
      return map.delete(sessionId);
    },
    deleteParticipant(participantId): number {
      let deleted = 0;
      for (const [id, session] of Array.from(map.entries())) {
        if (session.participantId === participantId) { map.delete(id); deleted++; }
      }
      return deleted;
    },
    prune(): number { return 0; },
  };
}
