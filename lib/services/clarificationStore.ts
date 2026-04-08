import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { ExtractionResult } from '../../src/extraction/extractionTypes';

export interface PendingClarification {
  id: string;
  scopeId: string;
  originalInput: string;
  partialExtraction: ExtractionResult;
  createdAt: string;
  expiresAt: string;
}

export interface PendingClarificationInput {
  scopeId: string;
  originalInput: string;
  partialExtraction: ExtractionResult;
  now: Date;
  ttlMs: number;
}

export interface ClarificationStore {
  create(input: PendingClarificationInput): PendingClarification;
  getAndClear(scopeId: string, id: string, now: Date): PendingClarification | null;
  clear(scopeId: string, id: string): void;
  clearScope(scopeId: string): void;
  pruneExpired(now: Date): void;
}

type ClarificationStoreData = {
  entries: Record<string, PendingClarification>;
};

const DEFAULT_STORE_FILE = path.join(process.cwd(), '.maybesitter', 'clarifications.json');

function entryKey(scopeId: string, id: string): string {
  return `${scopeId}:${id}`;
}

function emptyData(): ClarificationStoreData {
  return { entries: {} };
}

function normalizeData(raw: unknown): ClarificationStoreData {
  if (!raw || typeof raw !== 'object') return emptyData();
  const entries = (raw as ClarificationStoreData).entries;
  return { entries: entries && typeof entries === 'object' ? entries : {} };
}

export function scopeClarification(options: {
  sessionId?: string;
  userId?: string;
  conversationId?: string;
}): string | null {
  const scope = options.conversationId || options.sessionId || options.userId;
  return typeof scope === 'string' && scope.trim() ? scope.trim() : null;
}

export class FileClarificationStore implements ClarificationStore {
  private readonly filePath: string;

  constructor(filePath = DEFAULT_STORE_FILE) {
    this.filePath = filePath;
  }

  private read(): ClarificationStoreData {
    if (!existsSync(this.filePath)) return emptyData();
    return normalizeData(JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown);
  }

  private write(data: ClarificationStoreData): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(normalizeData(data), null, 2)}\n`, 'utf8');
  }

  create(input: PendingClarificationInput): PendingClarification {
    const data = this.read();
    const id = randomUUID();
    const entry: PendingClarification = {
      id,
      scopeId: input.scopeId,
      originalInput: input.originalInput,
      partialExtraction: input.partialExtraction,
      createdAt: input.now.toISOString(),
      expiresAt: new Date(input.now.getTime() + input.ttlMs).toISOString(),
    };
    data.entries[entryKey(entry.scopeId, entry.id)] = entry;
    this.write(data);
    return entry;
  }

  getAndClear(scopeId: string, id: string, now: Date): PendingClarification | null {
    const data = this.read();
    const key = entryKey(scopeId, id);
    const entry = data.entries[key] || null;
    if (entry) delete data.entries[key];
    this.write(data);
    if (!entry || Date.parse(entry.expiresAt) <= now.getTime()) return null;
    return entry;
  }

  clear(scopeId: string, id: string): void {
    const data = this.read();
    delete data.entries[entryKey(scopeId, id)];
    this.write(data);
  }

  clearScope(scopeId: string): void {
    const data = this.read();
    for (const key of Object.keys(data.entries)) {
      if (data.entries[key].scopeId === scopeId) delete data.entries[key];
    }
    this.write(data);
  }

  pruneExpired(now: Date): void {
    const data = this.read();
    for (const key of Object.keys(data.entries)) {
      if (Date.parse(data.entries[key].expiresAt) <= now.getTime()) delete data.entries[key];
    }
    this.write(data);
  }
}

export class MemoryClarificationStore implements ClarificationStore {
  private readonly entries = new Map<string, PendingClarification>();

  create(input: PendingClarificationInput): PendingClarification {
    const id = randomUUID();
    const entry: PendingClarification = {
      id,
      scopeId: input.scopeId,
      originalInput: input.originalInput,
      partialExtraction: input.partialExtraction,
      createdAt: input.now.toISOString(),
      expiresAt: new Date(input.now.getTime() + input.ttlMs).toISOString(),
    };
    this.entries.set(entryKey(entry.scopeId, entry.id), entry);
    return entry;
  }

  getAndClear(scopeId: string, id: string, now: Date): PendingClarification | null {
    const key = entryKey(scopeId, id);
    const entry = this.entries.get(key) || null;
    this.entries.delete(key);
    if (!entry || Date.parse(entry.expiresAt) <= now.getTime()) return null;
    return entry;
  }

  clear(scopeId: string, id: string): void {
    this.entries.delete(entryKey(scopeId, id));
  }

  clearScope(scopeId: string): void {
    for (const key of Array.from(this.entries.keys())) {
      if (this.entries.get(key)?.scopeId === scopeId) this.entries.delete(key);
    }
  }

  pruneExpired(now: Date): void {
    for (const [key, entry] of Array.from(this.entries.entries())) {
      if (Date.parse(entry.expiresAt) <= now.getTime()) this.entries.delete(key);
    }
  }
}

export function createDefaultClarificationStore(): ClarificationStore {
  return new FileClarificationStore();
}
