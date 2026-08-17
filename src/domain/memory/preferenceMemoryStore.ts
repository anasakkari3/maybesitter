import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type {
  PreferenceMemory, PreferenceEvent, PreferenceEventType, PreferenceStrength, PreferencePolarity, StatementStatus,
} from './memoryTypes.ts';

export interface CreatePreferenceMemoryInput {
  userId: string;
  statement: string;
  scope: string;
  strength: PreferenceStrength;
  polarity: PreferencePolarity;
  confidence: number;
  evidenceIds: string[];
  supersedesPreferenceId?: string;
}

export interface UpdatePreferenceInput {
  id: string;
  statement?: string;
  strength?: PreferenceStrength;
  polarity?: PreferencePolarity;
  confidence?: number;
  status?: StatementStatus;
}

export interface PreferenceMemoryStore {
  create(input: CreatePreferenceMemoryInput, reason: string, observationId?: string): PreferenceMemory;
  getById(id: string): PreferenceMemory | null;
  getActiveByUserId(userId: string): PreferenceMemory[];
  update(input: UpdatePreferenceInput, reason: string, actor: PreferenceEvent['actor'], observationId?: string): PreferenceMemory;
  addEvidence(preferenceId: string, observationId: string): void;
  adjustConfidence(id: string, delta: number, reason: string): PreferenceMemory;
  getEvents(preferenceId: string): PreferenceEvent[];
  getAllEvents(): PreferenceEvent[];
}

interface PreferenceMemoryData {
  preferences: Record<string, PreferenceMemory>;
  events: PreferenceEvent[];
}

const MIN_CONFIDENCE = 0.2;
const MAX_CONFIDENCE = 0.99;

export class FilePreferenceMemoryStore implements PreferenceMemoryStore {
  private dataDir: string;
  private filePath: string;

  constructor(dataDir?: string) {
    this.dataDir = dataDir || path.join(process.cwd(), '.maybesitter');
    this.filePath = path.join(this.dataDir, 'preference-memory.json');
  }

  private load(): PreferenceMemoryData {
    if (!existsSync(this.filePath)) return { preferences: {}, events: [] };
    try {
      return JSON.parse(readFileSync(this.filePath, 'utf8')) as PreferenceMemoryData;
    } catch {
      return { preferences: {}, events: [] };
    }
  }

  private save(data: PreferenceMemoryData): void {
    mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.filePath);
  }

  private createEvent(
    preferenceId: string,
    type: PreferenceEventType,
    reason: string,
    actor: PreferenceEvent['actor'],
    fromStatus?: StatementStatus,
    toStatus?: StatementStatus,
    fromConfidence?: number,
    toConfidence?: number,
    observationId?: string,
  ): PreferenceEvent {
    return {
      id: `pevt_${randomUUID()}`,
      preferenceId, type, fromStatus, toStatus, fromConfidence, toConfidence,
      observationId, reason, actor, createdAt: new Date().toISOString(),
    };
  }

  create(input: CreatePreferenceMemoryInput, reason: string, observationId?: string): PreferenceMemory {
    const data = this.load();
    const now = new Date().toISOString();
    const preference: PreferenceMemory = {
      id: `pref_${randomUUID()}`,
      userId: input.userId,
      statement: input.statement,
      scope: input.scope,
      strength: input.strength,
      polarity: input.polarity,
      confidence: input.confidence,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      evidenceIds: input.evidenceIds,
      ...(input.supersedesPreferenceId !== undefined ? { supersedesPreferenceId: input.supersedesPreferenceId } : {}),
    };
    data.preferences[preference.id] = preference;
    data.events.push(this.createEvent(preference.id, 'created', reason, 'model', undefined, 'active', undefined, input.confidence, observationId));
    this.save(data);
    return preference;
  }

  getById(id: string): PreferenceMemory | null {
    return this.load().preferences[id] || null;
  }

  getActiveByUserId(userId: string): PreferenceMemory[] {
    return Object.values(this.load().preferences)
      .filter((preference) => preference.userId === userId && preference.status === 'active')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  update(input: UpdatePreferenceInput, reason: string, actor: PreferenceEvent['actor'], observationId?: string): PreferenceMemory {
    const data = this.load();
    const preference = data.preferences[input.id];
    if (!preference) throw new Error(`Preference not found: ${input.id}`);

    const fromStatus = preference.status;
    if (input.statement !== undefined) preference.statement = input.statement;
    if (input.strength !== undefined) preference.strength = input.strength;
    if (input.polarity !== undefined) preference.polarity = input.polarity;
    if (input.confidence !== undefined) preference.confidence = input.confidence;
    if (input.status !== undefined) preference.status = input.status;
    preference.updatedAt = new Date().toISOString();

    if (input.status !== undefined && input.status !== fromStatus) {
      data.events.push(this.createEvent(input.id, 'corrected', reason, actor, fromStatus, input.status, undefined, undefined, observationId));
    }

    this.save(data);
    return preference;
  }

  addEvidence(preferenceId: string, observationId: string): void {
    const data = this.load();
    const preference = data.preferences[preferenceId];
    if (!preference) return;
    if (!preference.evidenceIds.includes(observationId)) {
      preference.evidenceIds.push(observationId);
      preference.updatedAt = new Date().toISOString();
      this.save(data);
    }
  }

  adjustConfidence(id: string, delta: number, reason: string): PreferenceMemory {
    const data = this.load();
    const preference = data.preferences[id];
    if (!preference) throw new Error(`Preference not found: ${id}`);
    const from = preference.confidence;
    const to = Math.max(MIN_CONFIDENCE, Math.min(MAX_CONFIDENCE, from + delta));
    preference.confidence = to;
    preference.updatedAt = new Date().toISOString();
    data.events.push(this.createEvent(id, 'confidence_adjusted', reason, 'system', undefined, undefined, from, to));
    this.save(data);
    return preference;
  }

  getEvents(preferenceId: string): PreferenceEvent[] {
    return this.load().events.filter((event) => event.preferenceId === preferenceId);
  }

  getAllEvents(): PreferenceEvent[] {
    return this.load().events;
  }
}
