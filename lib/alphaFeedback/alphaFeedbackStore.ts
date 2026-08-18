/**
 * SYNTHETIC — ENG/QA INFRA ONLY
 *
 * Alpha feedback flag store. Persists flags as bounded, reviewable records
 * with retention TTL, per-session and per-participant deletion, and
 * access boundaries (internal alpha-only).
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  ALPHA_FEEDBACK_FLAG_VERSION,
  FLAG_NOTE_MAX_LENGTH,
  type AlphaFeedbackFlag,
  type AlphaFeedbackFlagCategory,
  type AlphaFeedbackFlagInput,
} from '../../src/contracts/v1/feedbackFlagContracts';

export interface AlphaFeedbackStoreOptions {
  dataDir?: string;
  retentionTtlMs?: number;
}

export interface AlphaFeedbackStore {
  record(input: AlphaFeedbackFlagInput): AlphaFeedbackFlag;
  list(options?: { participantId?: string; sessionId?: string; since?: string }): AlphaFeedbackFlag[];
  count(options?: { participantId?: string }): number;
  deleteBySession(sessionId: string): number;
  deleteByParticipant(participantId: string): number;
  prune(): number;
}

const DEFAULT_DATA_DIR = path.join(process.cwd(), '.maybesitter', 'alpha-feedback');
const DEFAULT_RETENTION_TTL_MS = 30 * 24 * 60 * 60 * 1_000; // 30 days
const FLAG_FILE_EXT = '.flag.json';

function emptyFlag(input: AlphaFeedbackFlagInput): AlphaFeedbackFlag {
  const note = input.note ?? null;
  return {
    version: ALPHA_FEEDBACK_FLAG_VERSION,
    flagId: randomUUID(),
    participantId: input.participantId,
    sessionId: input.sessionId ?? `alpha-${input.participantId}-${Date.now().toString(36)}`,
    proposalId: input.proposalId,
    commitmentId: input.commitmentId ?? null,
    category: input.category,
    note: typeof note === 'string' ? note.slice(0, FLAG_NOTE_MAX_LENGTH) : null,
    createdAt: new Date().toISOString(),
  };
}

function flagFilePath(dataDir: string, flagId: string): string {
  return path.join(dataDir, `${flagId}${FLAG_FILE_EXT}`);
}

function readFlag(filePath: string): AlphaFeedbackFlag | null {
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    if (raw && raw.version === ALPHA_FEEDBACK_FLAG_VERSION && typeof raw.flagId === 'string') return raw;
  } catch {
    // corrupt or missing — skip
  }
  return null;
}

function createInMemoryStore(options?: AlphaFeedbackStoreOptions): AlphaFeedbackStore {
  const dataDir = options?.dataDir ?? DEFAULT_DATA_DIR;
  const retentionTtlMs = options?.retentionTtlMs ?? DEFAULT_RETENTION_TTL_MS;
  const now = () => Date.now();

  function ensureDir(): void {
    mkdirSync(dataDir, { recursive: true });
  }

  function loadAll(): AlphaFeedbackFlag[] {
    ensureDir();
    const entries = readdirSync(dataDir).filter((e) => e.endsWith(FLAG_FILE_EXT));
    const flags: AlphaFeedbackFlag[] = [];
    for (const entry of entries) {
      const flag = readFlag(path.join(dataDir, entry));
      if (flag) flags.push(flag);
    }
    return flags.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  return {
    record(input: AlphaFeedbackFlagInput): AlphaFeedbackFlag {
      ensureDir();
      const flag = emptyFlag(input);
      writeFileSync(flagFilePath(dataDir, flag.flagId), JSON.stringify(flag, null, 2));
      return flag;
    },

    list(filter?: { participantId?: string; sessionId?: string; since?: string }): AlphaFeedbackFlag[] {
      return loadAll().filter((flag) => {
        if (filter?.participantId && flag.participantId !== filter.participantId) return false;
        if (filter?.sessionId && flag.sessionId !== filter.sessionId) return false;
        if (filter?.since && flag.createdAt < filter.since) return false;
        return true;
      });
    },

    count(filter?: { participantId?: string }): number {
      return loadAll().filter((flag) => {
        if (filter?.participantId && flag.participantId !== filter.participantId) return false;
        return true;
      }).length;
    },

    deleteBySession(sessionId: string): number {
      const flags = loadAll();
      let deleted = 0;
      for (const flag of flags) {
        if (flag.sessionId === sessionId) {
          const filePath = flagFilePath(dataDir, flag.flagId);
          if (existsSync(filePath)) {
            unlinkSync(filePath);
            deleted++;
          }
        }
      }
      return deleted;
    },

    deleteByParticipant(participantId: string): number {
      const flags = loadAll();
      let deleted = 0;
      for (const flag of flags) {
        if (flag.participantId === participantId) {
          const filePath = flagFilePath(dataDir, flag.flagId);
          if (existsSync(filePath)) {
            unlinkSync(filePath);
            deleted++;
          }
        }
      }
      return deleted;
    },

    prune(): number {
      const flags = loadAll();
      const cutoff = new Date(now() - retentionTtlMs).toISOString();
      let pruned = 0;
      for (const flag of flags) {
        if (flag.createdAt < cutoff) {
          const filePath = flagFilePath(dataDir, flag.flagId);
          if (existsSync(filePath)) {
            unlinkSync(filePath);
            pruned++;
          }
        }
      }
      return pruned;
    },
  };
}

/** Create a store backed by a custom in-memory map (for tests). */
export function createInMemoryAlphaFeedbackStore(flags?: AlphaFeedbackFlag[]): AlphaFeedbackStore {
  const store = new Map<string, AlphaFeedbackFlag>();
  for (const flag of flags ?? []) store.set(flag.flagId, flag);
  return {
    record(input: AlphaFeedbackFlagInput): AlphaFeedbackFlag {
      const flag = emptyFlag(input);
      store.set(flag.flagId, flag);
      return flag;
    },
    list(filter?: { participantId?: string; sessionId?: string; since?: string }): AlphaFeedbackFlag[] {
      return Array.from(store.values()).filter((flag) => {
        if (filter?.participantId && flag.participantId !== filter.participantId) return false;
        if (filter?.sessionId && flag.sessionId !== filter.sessionId) return false;
        if (filter?.since && flag.createdAt < filter.since) return false;
        return true;
      }).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    count(filter?: { participantId?: string }): number {
      return Array.from(store.values()).filter((flag) => {
        if (filter?.participantId && flag.participantId !== filter.participantId) return false;
        return true;
      }).length;
    },
    deleteBySession(sessionId: string): number {
      let deleted = 0;
      for (const [id, flag] of Array.from(store.entries())) {
        if (flag.sessionId === sessionId) { store.delete(id); deleted++; }
      }
      return deleted;
    },
    deleteByParticipant(participantId: string): number {
      let deleted = 0;
      for (const [id, flag] of Array.from(store.entries())) {
        if (flag.participantId === participantId) { store.delete(id); deleted++; }
      }
      return deleted;
    },
    prune(): number { return 0; },
  };
}

export { createInMemoryStore as createFileAlphaFeedbackStore };
