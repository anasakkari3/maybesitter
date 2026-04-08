import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { getAdaptiveBehavior, mergeAdaptiveSignals, type AdaptiveBehavior, type AdaptiveSignals } from './adaptiveService';
import { getBehaviorFeedbackSignals, type BehaviorFeedbackStore } from './behaviorFeedbackService';
import { getCommandServiceState } from './commandService';
import type { Commitment, DomainState, Reminder } from '../../src/domain/stateMachine';
import type { AgendaItem } from './agendaService';
import { createAssistantTurn, type RealizationPath, type ResponseStrategy } from './responseEngine/assistantTurn';
import { getConversationStateStore } from './responseEngine/conversationStateStore';

export type PressureTone = 'soft' | 'firm';
export type PressureIntensity = 'low' | 'medium' | 'high';

export interface PressureMessage {
  message: string;
  tone: PressureTone;
  intensity: PressureIntensity;
}

export interface PressureCandidateMessage extends PressureMessage {
  commitmentId: string;
  strategy: ResponseStrategy;
  path: RealizationPath;
}

export interface PressureOptions {
  now?: Date;
  cooldownMs?: number;
  agendaItems?: readonly AgendaItem[];
  deliveryStore?: PressureDeliveryStore;
  sessionId?: string;
  userId?: string;
  conversationId?: string;
  pressureScopeId?: string;
  adaptiveSignals?: AdaptiveSignals;
  behaviorFeedbackStore?: BehaviorFeedbackStore;
  surfacedMessage?: unknown;
  surfacedStrategy?: unknown;
  surfacedPath?: unknown;
}

export interface PressureDeliveryResult {
  success: boolean;
  message: string;
}

export interface PressureDeliveryStore {
  getLastSurfacedAt(scopeId: string, commitmentId: string): string | null;
  getLastMessage(scopeId: string, commitmentId: string): string | null;
  getLastRecord(scopeId: string, commitmentId: string): PressureDeliveryRecord | null;
  recordSurface(scopeId: string, commitmentId: string, surfacedAt: string, message?: string | null, metadata?: PressureDeliveryMetadata): void;
  clear(scopeId?: string): void;
}

interface PressureCandidate {
  item: AgendaItem;
  commitment: Commitment;
  reminders: Reminder[];
  ignoredCount: number;
  oldestOverdueMs: number | null;
}

export type PressureDeliveryRecord = {
  surfacedAt: string;
  message: string | null;
  strategy: ResponseStrategy | null;
  path: RealizationPath | null;
  recentPaths: RealizationPath[];
};

type PressureDeliveryMetadata = {
  strategy?: ResponseStrategy | null;
  path?: RealizationPath | null;
};

type PressureDeliveryData = {
  surfaced: Record<string, Record<string, PressureDeliveryRecord>>;
};

export const PRESSURE_DELIVERY_COOLDOWN_MS = 60 * 60 * 1_000;
const DEFAULT_PRESSURE_SCOPE_ID = 'local';
const HIGH_URGENCY_SCORE = 5_800;
const DEFAULT_DELIVERY_FILE = path.join(process.cwd(), '.maybesitter', 'pressure-delivery.json');

function emptyData(): PressureDeliveryData {
  return { surfaced: {} };
}

function normalizeSurfacedMessage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const message = value.trim();
  if (!message) return null;
  return message.slice(0, 240);
}

const PRESSURE_STRATEGIES = new Set<ResponseStrategy>(['easy_choice', 'smaller_step', 'blocker_probe', 'reset_plan', 'close_loop']);
const REALIZATION_PATHS = new Set<RealizationPath>([
  'assistant_commitment',
  'task_set_for_time',
  'done_assistant_commitment',
  'time_first_commitment',
  'reminder_ready',
  'direct_question',
  'context_question',
  'known_time_question',
  'specific_missing_question',
  'careful_confirmation',
  'proposed_change_question',
  'boundary_ack',
  'context_boundary',
  'plain_no_change',
  'done_state',
  'item_state_closure',
  'assistant_closed',
  'moved_by_assistant',
  'cancelled_by_assistant',
  'continuity_choice',
  'continuity_small_step',
  'continuity_blocker',
  'continuity_reset',
  'decision_close',
  'pressure_decision_choice',
  'pressure_decision_reset',
  'pressure_time_choice',
  'pressure_direct_small_step',
  'pressure_blocker_first',
  'pressure_reset_first',
  'pressure_close_direct',
  'multi_direct',
  'multi_with_detail',
]);

function normalizeStrategy(value: unknown): ResponseStrategy | null {
  return typeof value === 'string' && PRESSURE_STRATEGIES.has(value as ResponseStrategy)
    ? value as ResponseStrategy
    : null;
}

function normalizePath(value: unknown): RealizationPath | null {
  return typeof value === 'string' && REALIZATION_PATHS.has(value as RealizationPath)
    ? value as RealizationPath
    : null;
}

function normalizeDeliveryRecord(value: unknown): PressureDeliveryRecord | null {
  if (typeof value === 'string') {
    return { surfacedAt: value, message: null, strategy: null, path: null, recentPaths: [] };
  }

  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<PressureDeliveryRecord>;
  if (typeof record.surfacedAt !== 'string') return null;
  const recentPaths = Array.isArray(record.recentPaths)
    ? record.recentPaths.map(normalizePath).filter((item): item is RealizationPath => item !== null).slice(-18)
    : [];
  const path = normalizePath(record.path);
  return {
    surfacedAt: record.surfacedAt,
    message: normalizeSurfacedMessage(record.message),
    strategy: normalizeStrategy(record.strategy),
    path,
    recentPaths: recentPaths.length > 0 ? recentPaths : path ? [path] : [],
  };
}

function normalizeData(raw: unknown): PressureDeliveryData {
  if (!raw || typeof raw !== 'object') return emptyData();
  const surfaced = (raw as PressureDeliveryData).surfaced;
  if (!surfaced || typeof surfaced !== 'object') return emptyData();

  const scoped: PressureDeliveryData['surfaced'] = {};
  for (const [scopeId, value] of Object.entries(surfaced)) {
    if (typeof value === 'string') {
      const record = normalizeDeliveryRecord(value);
      if (!record) continue;
      scoped[DEFAULT_PRESSURE_SCOPE_ID] = {
        ...(scoped[DEFAULT_PRESSURE_SCOPE_ID] || {}),
        [scopeId]: record,
      };
      continue;
    }
    if (value && typeof value === 'object') {
      const scopedRecords: Record<string, PressureDeliveryRecord> = {};
      for (const [commitmentId, recordValue] of Object.entries(value)) {
        const record = normalizeDeliveryRecord(recordValue);
        if (record) scopedRecords[commitmentId] = record;
      }
      scoped[scopeId] = scopedRecords;
    }
  }

  return { surfaced: scoped };
}

function noPressure(): PressureMessage {
  return {
    message: '',
    tone: 'soft',
    intensity: 'low',
  };
}

function deliveryStoreFrom(options: PressureOptions): PressureDeliveryStore {
  return options.deliveryStore || createDefaultPressureDeliveryStore();
}

export function scopePressureDelivery(options: Pick<PressureOptions, 'conversationId' | 'sessionId' | 'userId' | 'pressureScopeId'>): string {
  const scope = options.pressureScopeId || options.conversationId || options.sessionId || options.userId;
  return typeof scope === 'string' && scope.trim() ? scope.trim() : DEFAULT_PRESSURE_SCOPE_ID;
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function relevantTimes(commitment: Commitment, reminders: readonly Reminder[]): number[] {
  return [
    parseTime(commitment.timeSpec.dueAt),
    parseTime(commitment.timeSpec.remindAt),
    ...reminders.map((reminder) => parseTime(reminder.scheduledFor)),
  ].filter((time): time is number => time !== null);
}

function oldestOverdueMs(commitment: Commitment, reminders: readonly Reminder[], nowMs: number): number | null {
  const overdueTimes = relevantTimes(commitment, reminders)
    .filter((time) => time < nowMs)
    .sort((a, b) => a - b);
  if (overdueTimes.length === 0) return null;
  return nowMs - overdueTimes[0];
}

function ignoredCount(commitment: Commitment, reminders: readonly Reminder[], state: DomainState): number {
  const ignoredReminders = reminders.filter((reminder) => reminder.status === 'ignored').length;
  const escalationCount = state.escalationStates[commitment.id]?.perCycleCount || 0;
  const ackCount = commitment.currentAckState === 'ignored' && ignoredReminders === 0 ? 1 : 0;
  return ignoredReminders + escalationCount + ackCount;
}

function isCoolingDown(
  scopeId: string,
  commitmentId: string,
  nowMs: number,
  cooldownMs: number,
  deliveryStore: PressureDeliveryStore
): boolean {
  const lastPressureAt = parseTime(deliveryStore.getLastSurfacedAt(scopeId, commitmentId));
  return lastPressureAt !== null && nowMs - lastPressureAt < cooldownMs;
}

function isPressureEligible(candidate: PressureCandidate): boolean {
  if (candidate.commitment.currentAckState === 'aware' || candidate.commitment.currentAckState === 'postponed') {
    return false;
  }
  return (
    candidate.item.reason === 'overdue' ||
    candidate.ignoredCount >= 2 ||
    candidate.item.urgencyScore >= HIGH_URGENCY_SCORE
  );
}

function adaptiveSignalsFor(candidate: PressureCandidate, state: DomainState, options: PressureOptions): AdaptiveSignals {
  const commitmentCount = Math.max(1, Object.keys(state.commitments).length);
  const completedCount = Object.values(state.commitments).filter((commitment) => commitment.status === 'completed').length;
  const delayedCommitmentIds = new Set<string>();
  for (const commitment of Object.values(state.commitments)) {
    if (commitment.currentAckState === 'postponed' || commitment.postponedUntil) delayedCommitmentIds.add(commitment.id);
  }
  for (const reminder of Object.values(state.reminders)) {
    if (reminder.status === 'snoozed' || reminder.snoozedUntil) delayedCommitmentIds.add(reminder.commitmentId);
  }

  const stateSignals: AdaptiveSignals = {
    ignoredCommitmentsCount: candidate.ignoredCount,
    completionRate: completedCount > 0 ? completedCount / commitmentCount : 1,
    delayFrequency: delayedCommitmentIds.size / commitmentCount,
    clarificationFrequency: 0,
  };

  const shouldUseFeedback = Boolean(
    options.behaviorFeedbackStore ||
    options.pressureScopeId ||
    options.conversationId ||
    options.sessionId ||
    options.userId
  );

  const feedbackSignals = shouldUseFeedback
    ? getBehaviorFeedbackSignals({
        feedbackStore: options.behaviorFeedbackStore,
        feedbackScopeId: options.pressureScopeId,
        conversationId: options.conversationId,
        sessionId: options.sessionId,
        userId: options.userId,
      })
    : {};

  return mergeAdaptiveSignals(mergeAdaptiveSignals(stateSignals, feedbackSignals), options.adaptiveSignals);
}

function adaptiveBehaviorFor(candidate: PressureCandidate, state: DomainState, options: PressureOptions): AdaptiveBehavior {
  return getAdaptiveBehavior(adaptiveSignalsFor(candidate, state, options));
}

function toneFor(behavior: AdaptiveBehavior): PressureTone {
  return behavior.userType === 'avoidant' ? 'firm' : 'soft';
}

function intensityFor(behavior: AdaptiveBehavior): PressureIntensity {
  return behavior.pressureLevel;
}

function durationText(durationMs: number | null): string | null {
  if (durationMs === null || durationMs < 0) return null;
  const minutes = Math.max(1, Math.round(durationMs / (60 * 1000)));
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `about ${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `about ${days} day${days === 1 ? '' : 's'}`;
}

function delayBucket(durationMs: number | null): 'none' | 'short' | 'long' {
  if (durationMs === null) return 'none';
  return durationMs >= 24 * 60 * 60 * 1_000 ? 'long' : 'short';
}

function countText(value: number): string {
  if (value === 2) return 'twice';
  if (value === 3) return 'three times';
  return `${value} times`;
}

function pressureTurnFor(
  candidate: PressureCandidate,
  behavior: AdaptiveBehavior,
  scopeId: string,
  lastRecord: PressureDeliveryRecord | null
) {
  const conversationStore = getConversationStateStore();
  const baseCommitmentState = conversationStore.getCommitment(scopeId, candidate.commitment.id);
  const behaviorPressureCount = behavior.userType === 'avoidant' ? 2 : behavior.userType === 'inconsistent' ? 1 : 0;
  const commitmentState = {
    ...baseCommitmentState,
    ignoredCount: candidate.ignoredCount,
    lastStrategy: lastRecord?.strategy || baseCommitmentState.lastStrategy,
    lastPath: lastRecord?.path || baseCommitmentState.lastPath,
    pressureCount: Math.max(baseCommitmentState.pressureCount, lastRecord ? 1 : 0, behaviorPressureCount),
  };
  const baseConversationState = conversationStore.get(scopeId);
  const persistedPaths = lastRecord?.recentPaths || [];
  const persistedPathCounts = persistedPaths.reduce<Partial<Record<RealizationPath, number>>>((counts, path) => {
    counts[path] = (counts[path] || 0) + 1;
    return counts;
  }, {});
  const conversationState = persistedPaths.length > 0 ? {
    ...baseConversationState,
    pathCounts: {
      ...persistedPathCounts,
      ...Object.fromEntries(Object.entries(baseConversationState.pathCounts).map(([path, count]) => [
        path,
        (persistedPathCounts[path as RealizationPath] || 0) + (count || 0),
      ])),
    },
    recentPaths: [...persistedPaths, ...baseConversationState.recentPaths].slice(-18),
  } : baseConversationState;

  return createAssistantTurn({
    event: {
      type: 'pressure_due',
      commitmentId: candidate.commitment.id,
      title: candidate.commitment.title || candidate.item.title || (candidate.commitment.kind === 'follow_up' ? 'This follow-up' : 'This task'),
      overdueText: durationText(candidate.oldestOverdueMs),
      ignoredText: candidate.ignoredCount >= 2 ? countText(candidate.ignoredCount) : null,
      kind: candidate.commitment.kind,
    },
    scopeId,
    conversationState,
    commitmentState,
    record: false,
  });
}

function candidateFor(item: AgendaItem, state: DomainState, nowMs: number): PressureCandidate | null {
  const commitment = state.commitments[item.id];
  if (!commitment) return null;
  if (commitment.status === 'pending_confirmation' || commitment.priority.level === 'low') return null;

  const reminders = Object.values(state.reminders).filter((reminder) => reminder.commitmentId === commitment.id);
  return {
    item,
    commitment,
    reminders,
    ignoredCount: ignoredCount(commitment, reminders, state),
    oldestOverdueMs: oldestOverdueMs(commitment, reminders, nowMs),
  };
}

export class FilePressureDeliveryStore implements PressureDeliveryStore {
  private readonly filePath: string;

  constructor(filePath = DEFAULT_DELIVERY_FILE) {
    this.filePath = filePath;
  }

  private read(): PressureDeliveryData {
    if (!existsSync(this.filePath)) return emptyData();
    return normalizeData(JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown);
  }

  private write(data: PressureDeliveryData): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(normalizeData(data), null, 2)}\n`, 'utf8');
  }

  getLastSurfacedAt(scopeId: string, commitmentId: string): string | null {
    return this.read().surfaced[scopeId]?.[commitmentId]?.surfacedAt || null;
  }

  getLastMessage(scopeId: string, commitmentId: string): string | null {
    return this.read().surfaced[scopeId]?.[commitmentId]?.message || null;
  }

  getLastRecord(scopeId: string, commitmentId: string): PressureDeliveryRecord | null {
    return this.read().surfaced[scopeId]?.[commitmentId] || null;
  }

  recordSurface(scopeId: string, commitmentId: string, surfacedAt: string, message?: string | null, metadata: PressureDeliveryMetadata = {}): void {
    const data = this.read();
    data.surfaced[scopeId] = data.surfaced[scopeId] || {};
    const previous = data.surfaced[scopeId][commitmentId];
    const strategy = normalizeStrategy(metadata.strategy);
    const realizedPath = normalizePath(metadata.path);
    data.surfaced[scopeId][commitmentId] = {
      surfacedAt,
      message: normalizeSurfacedMessage(message),
      strategy,
      path: realizedPath,
      recentPaths: realizedPath ? [...(previous?.recentPaths || []), realizedPath].slice(-18) : previous?.recentPaths || [],
    };
    this.write(data);
  }

  clear(scopeId?: string): void {
    if (scopeId) {
      const data = this.read();
      delete data.surfaced[scopeId];
      this.write(data);
      return;
    }
    if (existsSync(this.filePath)) rmSync(this.filePath, { force: true });
  }
}

export class MemoryPressureDeliveryStore implements PressureDeliveryStore {
  private readonly surfaced = new Map<string, Map<string, PressureDeliveryRecord>>();

  getLastSurfacedAt(scopeId: string, commitmentId: string): string | null {
    return this.surfaced.get(scopeId)?.get(commitmentId)?.surfacedAt || null;
  }

  getLastMessage(scopeId: string, commitmentId: string): string | null {
    return this.surfaced.get(scopeId)?.get(commitmentId)?.message || null;
  }

  getLastRecord(scopeId: string, commitmentId: string): PressureDeliveryRecord | null {
    return this.surfaced.get(scopeId)?.get(commitmentId) || null;
  }

  recordSurface(scopeId: string, commitmentId: string, surfacedAt: string, message?: string | null, metadata: PressureDeliveryMetadata = {}): void {
    const scoped = this.surfaced.get(scopeId) || new Map<string, PressureDeliveryRecord>();
    const previous = scoped.get(commitmentId);
    const strategy = normalizeStrategy(metadata.strategy);
    const realizedPath = normalizePath(metadata.path);
    scoped.set(commitmentId, {
      surfacedAt,
      message: normalizeSurfacedMessage(message),
      strategy,
      path: realizedPath,
      recentPaths: realizedPath ? [...(previous?.recentPaths || []), realizedPath].slice(-18) : previous?.recentPaths || [],
    });
    this.surfaced.set(scopeId, scoped);
  }

  clear(scopeId?: string): void {
    if (scopeId) {
      this.surfaced.delete(scopeId);
      return;
    }
    this.surfaced.clear();
  }
}

export function createDefaultPressureDeliveryStore(): PressureDeliveryStore {
  return new FilePressureDeliveryStore();
}

export function clearPressureHistory(
  store: PressureDeliveryStore = createDefaultPressureDeliveryStore(),
  scopeId?: string
): void {
  store.clear(scopeId);
}

export function getPressureCandidateForAgenda(
  items: readonly AgendaItem[],
  options: PressureOptions = {},
  state: DomainState = getCommandServiceState()
): PressureCandidateMessage | null {
  const now = options.now || new Date();
  const nowMs = now.getTime();
  const cooldownMs = options.cooldownMs ?? PRESSURE_DELIVERY_COOLDOWN_MS;
  const deliveryStore = deliveryStoreFrom(options);
  const scopeId = scopePressureDelivery(options);

  const candidate = items
    .map((item) => candidateFor(item, state, nowMs))
    .filter((item): item is PressureCandidate => item !== null)
    .filter(isPressureEligible)
    .find((item) => !isCoolingDown(scopeId, item.commitment.id, nowMs, cooldownMs, deliveryStore));

  if (!candidate) return null;

  const behavior = adaptiveBehaviorFor(candidate, state, options);
  const tone = toneFor(behavior);
  const lastRecord = deliveryStore.getLastRecord(scopeId, candidate.commitment.id);
  const turn = pressureTurnFor(candidate, behavior, scopeId, lastRecord);

  return {
    commitmentId: candidate.commitment.id,
    message: turn.message,
    strategy: turn.plan.strategy,
    path: turn.debug?.realizationPath || 'continuity_choice',
    tone,
    intensity: intensityFor(behavior),
  };
}

export function getPressureMessage(
  options: PressureOptions = {},
  state: DomainState = getCommandServiceState()
): PressureMessage {
  return getPressureMessageForAgenda(options.agendaItems || [], options, state);
}

export function getPressureMessageForAgenda(
  items: readonly AgendaItem[],
  options: PressureOptions = {},
  state: DomainState = getCommandServiceState()
): PressureMessage {
  return getPressureCandidateForAgenda(items, options, state) || noPressure();
}

export function recordPressureDelivery(
  commitmentId: unknown,
  options: PressureOptions = {},
  state: DomainState = getCommandServiceState()
): PressureDeliveryResult {
  if (typeof commitmentId !== 'string' || !commitmentId.trim()) {
    return { success: false, message: 'Missing pressure commitment.' };
  }

  const id = commitmentId.trim();
  if (!state.commitments[id]) {
    return { success: false, message: 'Pressure commitment was not found.' };
  }

  const now = options.now || new Date();
  const nowMs = now.getTime();
  const cooldownMs = options.cooldownMs ?? PRESSURE_DELIVERY_COOLDOWN_MS;
  const deliveryStore = deliveryStoreFrom(options);
  const scopeId = scopePressureDelivery(options);
  if (isCoolingDown(scopeId, id, nowMs, cooldownMs, deliveryStore)) {
    return { success: true, message: 'Pressure was already recorded recently.' };
  }

  const strategy = normalizeStrategy(options.surfacedStrategy);
  const realizedPath = normalizePath(options.surfacedPath);
  deliveryStore.recordSurface(scopeId, id, now.toISOString(), normalizeSurfacedMessage(options.surfacedMessage), {
    strategy,
    path: realizedPath,
  });
  if (strategy && realizedPath) {
    getConversationStateStore().recordTurn(scopeId, {
      eventType: 'pressure_due',
      intent: strategy === 'blocker_probe' ? 'probe_blocker' : strategy === 'reset_plan' ? 'reset_plan' : strategy === 'close_loop' ? 'escalate_choice' : 'nudge',
      strategy,
      path: realizedPath,
      move: 'name_continuity',
      commitmentId: id,
    });
  }
  return { success: true, message: 'Pressure delivery recorded.' };
}
