import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { CommitmentMemory, CommitmentMemoryStatus, CommitmentEvent, CommitmentEventType } from './memoryTypes.ts';
import { assertValidTransition, isTerminalStatus } from './commitmentStateMachine.ts';
import { evaluateNotificationEligibility } from './memoryPolicy.ts';

export interface CreateCommitmentMemoryInput {
  userId: string;
  title: string;
  description?: string;
  status: CommitmentMemoryStatus;
  dueAt?: string;
  timePrecision: CommitmentMemory['timePrecision'];
  participants: string[];
  location?: string;
  confidence: number;
  evidenceIds: string[];
  requiresConfirmation: boolean;
  supersedesCommitmentId?: string;
}

export interface UpdateCommitmentInput {
  id: string;
  status?: CommitmentMemoryStatus;
  dueAt?: string;
  timePrecision?: CommitmentMemory['timePrecision'];
  confidence?: number;
  requiresConfirmation?: boolean;
  title?: string;
  description?: string;
  participants?: string[];
  location?: string;
}

export interface CommitmentMemoryStore {
  create(input: CreateCommitmentMemoryInput, reason: string, observationId?: string): CommitmentMemory;
  getById(id: string): CommitmentMemory | null;
  getOpenByUserId(userId: string, withinDays?: number): CommitmentMemory[];
  update(input: UpdateCommitmentInput, reason: string, actor: CommitmentEvent['actor'], observationId?: string): CommitmentMemory;
  addEvidence(commitmentId: string, observationId: string): void;
  getEvents(commitmentId: string): CommitmentEvent[];
  getAllEvents(): CommitmentEvent[];
}

interface CommitmentMemoryData {
  commitments: Record<string, CommitmentMemory>;
  events: CommitmentEvent[];
}

export class FileCommitmentMemoryStore implements CommitmentMemoryStore {
  private dataDir: string;
  private filePath: string;

  constructor(dataDir?: string) {
    this.dataDir = dataDir || path.join(process.cwd(), '.maybesitter');
    this.filePath = path.join(this.dataDir, 'commitment-memory.json');
  }

  private load(): CommitmentMemoryData {
    if (!existsSync(this.filePath)) return { commitments: {}, events: [] };
    try {
      return JSON.parse(readFileSync(this.filePath, 'utf8')) as CommitmentMemoryData;
    } catch {
      return { commitments: {}, events: [] };
    }
  }

  private save(data: CommitmentMemoryData): void {
    mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.filePath);
  }

  private createEvent(
    commitmentId: string,
    type: CommitmentEventType,
    reason: string,
    actor: CommitmentEvent['actor'],
    fromStatus?: CommitmentMemoryStatus,
    toStatus?: CommitmentMemoryStatus,
    observationId?: string,
    modelConfidence?: number,
  ): CommitmentEvent {
    return {
      id: `evt_${randomUUID()}`,
      commitmentId,
      type,
      fromStatus,
      toStatus,
      observationId,
      reason,
      actor,
      modelConfidence,
      createdAt: new Date().toISOString(),
    };
  }

  create(input: CreateCommitmentMemoryInput, reason: string, observationId?: string): CommitmentMemory {
    const data = this.load();
    const now = new Date().toISOString();
    const commitment: CommitmentMemory = {
      id: `cmem_${randomUUID()}`,
      userId: input.userId,
      title: input.title,
      description: input.description,
      status: input.status,
      dueAt: input.dueAt,
      timePrecision: input.timePrecision,
      participants: input.participants,
      location: input.location,
      confidence: input.confidence,
      createdAt: now,
      updatedAt: now,
      evidenceIds: input.evidenceIds,
      supersedesCommitmentId: input.supersedesCommitmentId,
      requiresConfirmation: input.requiresConfirmation,
      notificationEligible: false,
    };
    commitment.notificationEligible = evaluateNotificationEligibility(commitment).eligible;

    data.commitments[commitment.id] = commitment;
    data.events.push(
      this.createEvent(commitment.id, 'created', reason, 'model', undefined, input.status, observationId, input.confidence),
    );
    if (commitment.notificationEligible) {
      data.events.push(
        this.createEvent(commitment.id, 'notification_enabled', 'Met all notification criteria', 'system'),
      );
    }
    this.save(data);
    return commitment;
  }

  getById(id: string): CommitmentMemory | null {
    return this.load().commitments[id] || null;
  }

  getOpenByUserId(userId: string, withinDays = 30): CommitmentMemory[] {
    const data = this.load();
    const cutoff = new Date(Date.now() - withinDays * 24 * 60 * 60 * 1000).toISOString();
    return Object.values(data.commitments)
      .filter((c) => c.userId === userId && !isTerminalStatus(c.status) && c.createdAt >= cutoff)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  update(input: UpdateCommitmentInput, reason: string, actor: CommitmentEvent['actor'], observationId?: string): CommitmentMemory {
    const data = this.load();
    const commitment = data.commitments[input.id];
    if (!commitment) throw new Error(`Commitment not found: ${input.id}`);

    const oldStatus = commitment.status;

    if (input.status && input.status !== oldStatus) {
      if (isTerminalStatus(oldStatus)) {
        const correctionEvent = this.createEvent(
          input.id, 'corrected', reason, actor, oldStatus, input.status, observationId,
        );
        data.events.push(correctionEvent);
      } else {
        assertValidTransition(oldStatus, input.status);
      }
      commitment.status = input.status;
    }

    if (input.title !== undefined) commitment.title = input.title;
    if (input.description !== undefined) commitment.description = input.description;
    if (input.dueAt !== undefined) commitment.dueAt = input.dueAt;
    if (input.timePrecision !== undefined) commitment.timePrecision = input.timePrecision;
    if (input.confidence !== undefined) commitment.confidence = input.confidence;
    if (input.requiresConfirmation !== undefined) commitment.requiresConfirmation = input.requiresConfirmation;
    if (input.participants !== undefined) commitment.participants = input.participants;
    if (input.location !== undefined) commitment.location = input.location;
    commitment.updatedAt = new Date().toISOString();

    const wasEligible = commitment.notificationEligible;
    commitment.notificationEligible = evaluateNotificationEligibility(commitment).eligible;

    if (input.status && input.status !== oldStatus) {
      const eventType = input.status === 'cancelled' ? 'cancelled'
        : input.status === 'completed' ? 'completed'
        : input.status === 'postponed' ? 'postponed'
        : input.status === 'scheduled' ? 'scheduled'
        : input.status === 'confirmed' ? 'confirmed'
        : 'confirmed';
      data.events.push(
        this.createEvent(input.id, eventType, reason, actor, oldStatus, input.status, observationId),
      );
    }

    if (!wasEligible && commitment.notificationEligible) {
      data.events.push(this.createEvent(input.id, 'notification_enabled', 'Met all notification criteria', 'system'));
    }
    if (wasEligible && !commitment.notificationEligible) {
      data.events.push(this.createEvent(input.id, 'notification_disabled', reason, 'system'));
    }

    this.save(data);
    return commitment;
  }

  addEvidence(commitmentId: string, observationId: string): void {
    const data = this.load();
    const commitment = data.commitments[commitmentId];
    if (!commitment) return;
    if (!commitment.evidenceIds.includes(observationId)) {
      commitment.evidenceIds.push(observationId);
      commitment.updatedAt = new Date().toISOString();
      this.save(data);
    }
  }

  getEvents(commitmentId: string): CommitmentEvent[] {
    return this.load().events.filter((e) => e.commitmentId === commitmentId);
  }

  getAllEvents(): CommitmentEvent[] {
    return this.load().events;
  }
}
