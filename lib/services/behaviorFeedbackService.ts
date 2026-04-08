import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';

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

export interface BehaviorFeedbackStore {
  get(scopeId: string): BehaviorFeedbackRecord;
  record(scopeId: string, event: BehaviorFeedbackEvent, at: string): BehaviorFeedbackRecord;
  clear(scopeId?: string): void;
}

type BehaviorFeedbackData = {
  scopes: Record<string, BehaviorFeedbackRecord>;
};

const DEFAULT_FEEDBACK_SCOPE_ID = 'local';
const DEFAULT_FEEDBACK_FILE = path.join(process.cwd(), '.maybesitter', 'behavior-feedback.json');

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

function emptyData(): BehaviorFeedbackData {
  return { scopes: {} };
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

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

function normalizeData(raw: unknown): BehaviorFeedbackData {
  if (!raw || typeof raw !== 'object') return emptyData();
  const scopes = (raw as BehaviorFeedbackData).scopes;
  if (!scopes || typeof scopes !== 'object') return emptyData();

  return {
    scopes: Object.fromEntries(
      Object.entries(scopes).map(([scopeId, value]) => [scopeId, normalizeRecord(value)])
    ),
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

export class FileBehaviorFeedbackStore implements BehaviorFeedbackStore {
  private readonly filePath: string;

  constructor(filePath = DEFAULT_FEEDBACK_FILE) {
    this.filePath = filePath;
  }

  private read(): BehaviorFeedbackData {
    if (!existsSync(this.filePath)) return emptyData();
    try {
      return normalizeData(JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown);
    } catch {
      return emptyData();
    }
  }

  private write(data: BehaviorFeedbackData): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(normalizeData(data), null, 2)}\n`, 'utf8');
  }

  get(scopeId: string): BehaviorFeedbackRecord {
    return this.read().scopes[scopeId] || emptyRecord();
  }

  record(scopeId: string, event: BehaviorFeedbackEvent, at: string): BehaviorFeedbackRecord {
    const data = this.read();
    const next = increment(data.scopes[scopeId] || emptyRecord(), event, at);
    data.scopes[scopeId] = next;
    this.write(data);
    return next;
  }

  clear(scopeId?: string): void {
    if (scopeId) {
      const data = this.read();
      delete data.scopes[scopeId];
      this.write(data);
      return;
    }
    if (existsSync(this.filePath)) rmSync(this.filePath, { force: true });
  }
}

export class MemoryBehaviorFeedbackStore implements BehaviorFeedbackStore {
  private readonly scopes = new Map<string, BehaviorFeedbackRecord>();

  get(scopeId: string): BehaviorFeedbackRecord {
    return this.scopes.get(scopeId) || emptyRecord();
  }

  record(scopeId: string, event: BehaviorFeedbackEvent, at: string): BehaviorFeedbackRecord {
    const next = increment(this.scopes.get(scopeId) || emptyRecord(), event, at);
    this.scopes.set(scopeId, next);
    return next;
  }

  clear(scopeId?: string): void {
    if (scopeId) {
      this.scopes.delete(scopeId);
      return;
    }
    this.scopes.clear();
  }
}

export function createDefaultBehaviorFeedbackStore(): BehaviorFeedbackStore {
  return new FileBehaviorFeedbackStore();
}

export function recordBehaviorFeedback(
  event: BehaviorFeedbackEvent,
  options: BehaviorFeedbackScopeOptions & { now?: Date; feedbackStore?: BehaviorFeedbackStore } = {}
): BehaviorFeedbackRecord {
  const store = options.feedbackStore || createDefaultBehaviorFeedbackStore();
  return store.record(scopeBehaviorFeedback(options), event, (options.now || new Date()).toISOString());
}

export function getBehaviorFeedbackSignals(
  options: BehaviorFeedbackScopeOptions & { feedbackStore?: BehaviorFeedbackStore } = {}
): BehaviorFeedbackSignals {
  const record = (options.feedbackStore || createDefaultBehaviorFeedbackStore()).get(scopeBehaviorFeedback(options));
  const actionTotal = record.completedActions + record.ignoredSuggestions + record.delayedActions;
  const clarificationTotal = record.clarificationSuccesses + record.clarificationFailures;

  return {
    ignoredCommitmentsCount: record.ignoredSuggestions || undefined,
    completionRate: actionTotal > 0 ? (record.completedActions + 1) / (actionTotal + 1) : undefined,
    delayFrequency: actionTotal > 0 ? record.delayedActions / actionTotal : undefined,
    clarificationFrequency: clarificationTotal > 0 ? record.clarificationFailures / (clarificationTotal + 1) : undefined,
  };
}

export function clearBehaviorFeedbackHistory(
  store: BehaviorFeedbackStore = createDefaultBehaviorFeedbackStore(),
  scopeId?: string
): void {
  store.clear(scopeId);
}
