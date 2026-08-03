import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { Observation, DetectedLanguage, ObservationStatus } from './memoryTypes.ts';

export interface CreateObservationInput {
  userId: string;
  sourceText: string;
  sourceMessageId: string;
  sourceConversationId?: string;
  observedAt: string;
  language?: DetectedLanguage;
  extractionVersion?: string;
}

export interface ObservationStore {
  create(input: CreateObservationInput): Observation;
  getById(id: string): Observation | null;
  getByUserId(userId: string, limit?: number): Observation[];
  updateStatus(id: string, status: ObservationStatus): void;
}

interface ObservationData {
  observations: Record<string, Observation>;
}

function detectLanguage(text: string): DetectedLanguage {
  const hasArabic = /[؀-ۿ]/.test(text);
  const hasHebrew = /[֐-׿]/.test(text);
  const hasLatin = /[a-zA-Z]/.test(text);
  const count = [hasArabic, hasHebrew, hasLatin].filter(Boolean).length;
  if (count > 1) return 'mixed';
  if (hasArabic) return 'ar';
  if (hasHebrew) return 'he';
  return 'en';
}

export class FileObservationStore implements ObservationStore {
  private dataDir: string;
  private filePath: string;

  constructor(dataDir?: string) {
    this.dataDir = dataDir || path.join(process.cwd(), '.maybesitter');
    this.filePath = path.join(this.dataDir, 'observations.json');
  }

  private load(): ObservationData {
    if (!existsSync(this.filePath)) return { observations: {} };
    try {
      return JSON.parse(readFileSync(this.filePath, 'utf8')) as ObservationData;
    } catch {
      return { observations: {} };
    }
  }

  private save(data: ObservationData): void {
    mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.filePath);
  }

  create(input: CreateObservationInput): Observation {
    const data = this.load();
    const observation: Observation = {
      id: `obs_${randomUUID()}`,
      userId: input.userId,
      sourceText: input.sourceText,
      sourceMessageId: input.sourceMessageId,
      sourceConversationId: input.sourceConversationId,
      observedAt: input.observedAt,
      createdAt: new Date().toISOString(),
      language: input.language || detectLanguage(input.sourceText),
      extractionVersion: input.extractionVersion || 'v1.0',
      status: 'active',
    };
    data.observations[observation.id] = observation;
    this.save(data);
    return observation;
  }

  getById(id: string): Observation | null {
    return this.load().observations[id] || null;
  }

  getByUserId(userId: string, limit = 100): Observation[] {
    const data = this.load();
    return Object.values(data.observations)
      .filter((o) => o.userId === userId && o.status === 'active')
      .sort((a, b) => b.observedAt.localeCompare(a.observedAt))
      .slice(0, limit);
  }

  updateStatus(id: string, status: ObservationStatus): void {
    const data = this.load();
    const obs = data.observations[id];
    if (!obs) return;
    obs.status = status;
    this.save(data);
  }
}
