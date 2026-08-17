import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { FactMemory, FactEvent, FactEventType, StatementStatus } from './memoryTypes.ts';

export interface CreateFactMemoryInput {
  userId: string;
  statement: string;
  scope: string;
  confidence: number;
  evidenceIds: string[];
  supersedesFactId?: string;
}

export interface UpdateFactInput {
  id: string;
  statement?: string;
  confidence?: number;
  status?: StatementStatus;
}

export interface FactMemoryStore {
  create(input: CreateFactMemoryInput, reason: string, observationId?: string): FactMemory;
  getById(id: string): FactMemory | null;
  getActiveByUserId(userId: string): FactMemory[];
  update(input: UpdateFactInput, reason: string, actor: FactEvent['actor'], observationId?: string): FactMemory;
  addEvidence(factId: string, observationId: string): void;
  adjustConfidence(id: string, delta: number, reason: string): FactMemory;
  getEvents(factId: string): FactEvent[];
  getAllEvents(): FactEvent[];
}

interface FactMemoryData {
  facts: Record<string, FactMemory>;
  events: FactEvent[];
}

const MIN_CONFIDENCE = 0.2;
const MAX_CONFIDENCE = 0.99;

export class FileFactMemoryStore implements FactMemoryStore {
  private dataDir: string;
  private filePath: string;

  constructor(dataDir?: string) {
    this.dataDir = dataDir || path.join(process.cwd(), '.maybesitter');
    this.filePath = path.join(this.dataDir, 'fact-memory.json');
  }

  private load(): FactMemoryData {
    if (!existsSync(this.filePath)) return { facts: {}, events: [] };
    try {
      return JSON.parse(readFileSync(this.filePath, 'utf8')) as FactMemoryData;
    } catch {
      return { facts: {}, events: [] };
    }
  }

  private save(data: FactMemoryData): void {
    mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.filePath);
  }

  private createEvent(
    factId: string,
    type: FactEventType,
    reason: string,
    actor: FactEvent['actor'],
    fromStatus?: StatementStatus,
    toStatus?: StatementStatus,
    fromConfidence?: number,
    toConfidence?: number,
    observationId?: string,
  ): FactEvent {
    return {
      id: `fevt_${randomUUID()}`,
      factId, type, fromStatus, toStatus, fromConfidence, toConfidence,
      observationId, reason, actor, createdAt: new Date().toISOString(),
    };
  }

  create(input: CreateFactMemoryInput, reason: string, observationId?: string): FactMemory {
    const data = this.load();
    const now = new Date().toISOString();
    const fact: FactMemory = {
      id: `fact_${randomUUID()}`,
      userId: input.userId,
      statement: input.statement,
      scope: input.scope,
      confidence: input.confidence,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      evidenceIds: input.evidenceIds,
      ...(input.supersedesFactId !== undefined ? { supersedesFactId: input.supersedesFactId } : {}),
    };
    data.facts[fact.id] = fact;
    data.events.push(this.createEvent(fact.id, 'created', reason, 'model', undefined, 'active', undefined, input.confidence, observationId));
    this.save(data);
    return fact;
  }

  getById(id: string): FactMemory | null {
    return this.load().facts[id] || null;
  }

  getActiveByUserId(userId: string): FactMemory[] {
    return Object.values(this.load().facts)
      .filter((fact) => fact.userId === userId && fact.status === 'active')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  update(input: UpdateFactInput, reason: string, actor: FactEvent['actor'], observationId?: string): FactMemory {
    const data = this.load();
    const fact = data.facts[input.id];
    if (!fact) throw new Error(`Fact not found: ${input.id}`);

    const fromStatus = fact.status;
    if (input.statement !== undefined) fact.statement = input.statement;
    if (input.confidence !== undefined) fact.confidence = input.confidence;
    if (input.status !== undefined) fact.status = input.status;
    fact.updatedAt = new Date().toISOString();

    if (input.status !== undefined && input.status !== fromStatus) {
      data.events.push(this.createEvent(input.id, 'corrected', reason, actor, fromStatus, input.status, undefined, undefined, observationId));
    }

    this.save(data);
    return fact;
  }

  addEvidence(factId: string, observationId: string): void {
    const data = this.load();
    const fact = data.facts[factId];
    if (!fact) return;
    if (!fact.evidenceIds.includes(observationId)) {
      fact.evidenceIds.push(observationId);
      fact.updatedAt = new Date().toISOString();
      this.save(data);
    }
  }

  adjustConfidence(id: string, delta: number, reason: string): FactMemory {
    const data = this.load();
    const fact = data.facts[id];
    if (!fact) throw new Error(`Fact not found: ${id}`);
    const from = fact.confidence;
    const to = Math.max(MIN_CONFIDENCE, Math.min(MAX_CONFIDENCE, from + delta));
    fact.confidence = to;
    fact.updatedAt = new Date().toISOString();
    data.events.push(this.createEvent(id, 'confidence_adjusted', reason, 'system', undefined, undefined, from, to));
    this.save(data);
    return fact;
  }

  getEvents(factId: string): FactEvent[] {
    return this.load().events.filter((event) => event.factId === factId);
  }

  getAllEvents(): FactEvent[] {
    return this.load().events;
  }
}
