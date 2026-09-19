/**
 * Pressure delivery, on durable storage (UC-1.0c, #142).
 *
 * ── What this replaced ───────────────────────────────────────────
 *
 * One `pressure-delivery.json` holding every scope's delivery history,
 * rewritten whole on each surface. The cooldown is read from it, and a
 * cooldown that lives on a per-instance filesystem is not a cooldown: on Cloud
 * Run instance B has never heard of the nudge instance A just sent, so a user
 * who is already behind gets pushed again immediately. Over-nudging is the
 * failure that makes people turn the assistant off.
 *
 * Delivery history now lives at `users/{uid}/pressureDelivery/{sha256(scope)}`
 * — one document per scope holding its commitment map, which is the shape the
 * file had, so the cooldown is shared by every instance. `recordSurface` reads
 * and writes inside one transaction, because two surfaces racing used to lose
 * one and a lost record is a missing cooldown.
 */
import { getAdaptiveBehavior, mergeAdaptiveSignals, type AdaptiveBehavior, type AdaptiveSignals } from './adaptiveService';
import { getBehaviorFeedbackSignals, type BehaviorFeedbackStore } from './behaviorFeedbackService';
import { getCommandServiceState } from './commandService';
import type { Commitment, DomainState, Reminder } from '../../src/domain/stateMachine';
import type { AgendaItem } from './agendaService';
import { createAssistantTurn, type RealizationPath, type ResponseStrategy } from './responseEngine/assistantTurn';
import { getConversationStateStore } from './responseEngine/conversationStateStore';
import {
  PRESSURE_DELIVERY,
  createMemoryStorage,
  docIdForKey,
  getStorage,
  userCol,
  userIdForKey,
  type StorageAdapter,
} from '../storage';

export type PressureTone = 'soft' | 'firm';
export type PressureIntensity = 'low' | 'medium' | 'high';

/**
 * The strongest reminder the user has agreed to receive — the setting written
 * by UC-3.11 (#196)/UC-3.12a (#197) as `users/{uid}.reminderSettings
 * .escalationCeiling`, and read from storage through `readEscalationCeiling`
 * (#446). A caller with no account to read supplies nothing and the default
 * applies, which is the gentlest value, not the absent one.
 */
export type PressureCeiling = 'soft' | 'followUp' | 'hard';

export const DEFAULT_PRESSURE_CEILING: PressureCeiling = 'soft';

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
  /** The user's own escalation ceiling. Absent means `DEFAULT_PRESSURE_CEILING`. */
  ceiling?: PressureCeiling;
  behaviorFeedbackStore?: BehaviorFeedbackStore;
  surfacedMessage?: unknown;
  surfacedStrategy?: unknown;
  surfacedPath?: unknown;
}

export interface PressureDeliveryResult {
  success: boolean;
  message: string;
}

/** Async since UC-1.0c (#142): every method is a storage round trip. */
export interface PressureDeliveryStore {
  getLastSurfacedAt(scopeId: string, commitmentId: string): Promise<string | null>;
  getLastMessage(scopeId: string, commitmentId: string): Promise<string | null>;
  getLastRecord(scopeId: string, commitmentId: string): Promise<PressureDeliveryRecord | null>;
  recordSurface(scopeId: string, commitmentId: string, surfacedAt: string, message?: string | null, metadata?: PressureDeliveryMetadata): Promise<void>;
  clear(scopeId?: string): Promise<void>;
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

/** One document per scope: the commitment map the file used to hold. */
interface StoredPressureDelivery {
  scopeId: string;
  surfaced: Record<string, PressureDeliveryRecord>;
}

export const PRESSURE_DELIVERY_COOLDOWN_MS = 60 * 60 * 1_000;
const DEFAULT_PRESSURE_SCOPE_ID = 'local';
const HIGH_URGENCY_SCORE = 5_800;

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

/** A hand-edited or half-written document must not surface as a partial record. */
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

function normalizeSurfaced(value: unknown): Record<string, PressureDeliveryRecord> {
  if (!value || typeof value !== 'object') return {};
  const surfaced: Record<string, PressureDeliveryRecord> = {};
  for (const [commitmentId, recordValue] of Object.entries(value as Record<string, unknown>)) {
    const record = normalizeDeliveryRecord(recordValue);
    if (record) surfaced[commitmentId] = record;
  }
  return surfaced;
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

async function isCoolingDown(
  scopeId: string,
  commitmentId: string,
  nowMs: number,
  cooldownMs: number,
  deliveryStore: PressureDeliveryStore
): Promise<boolean> {
  const lastPressureAt = parseTime(await deliveryStore.getLastSurfacedAt(scopeId, commitmentId));
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

async function adaptiveSignalsFor(candidate: PressureCandidate, state: DomainState, options: PressureOptions): Promise<AdaptiveSignals> {
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
    ? await getBehaviorFeedbackSignals({
        feedbackStore: options.behaviorFeedbackStore,
        feedbackScopeId: options.pressureScopeId,
        conversationId: options.conversationId,
        sessionId: options.sessionId,
        userId: options.userId,
      })
    : {};

  return mergeAdaptiveSignals(mergeAdaptiveSignals(stateSignals, feedbackSignals), options.adaptiveSignals);
}

async function adaptiveBehaviorFor(candidate: PressureCandidate, state: DomainState, options: PressureOptions): Promise<AdaptiveBehavior> {
  return getAdaptiveBehavior(await adaptiveSignalsFor(candidate, state, options));
}

/* ══ THE INVARIANT (UC-3.13, #199; resolves #107) ══════════════════
 *
 * **Avoidance may lower or hold pressure. It may never raise it. No pressure
 * may exceed the user's own ceiling.**
 *
 * Read in the issue's own words, that is two rules, and neither is conditional
 * on the other:
 *
 *   1. *Nothing derived from what the person failed to do may raise any
 *      dimension of pressure.* Not the intensity, not the tone, not the
 *      strategy the conversational ladder picks, and not the wording that
 *      counts the misses back at them. Ignores, delays and a low completion
 *      rate enter this module in exactly two places — as a reason to consider
 *      surfacing anything at all (`isPressureEligible`), and as a cap that can
 *      only subtract (`AdaptiveBehavior.maxPressureLevel`).
 *   2. *Whatever survives rule 1 is still capped by the ceiling the user
 *      chose*, and an absent or unrecognised ceiling means the gentlest one,
 *      never the absent one.
 *
 * The intensity is therefore the lowest of three independent caps:
 *
 *     intensity = min( base from the commitment's own priority,
 *                      the classification's cap,
 *                      the user's ceiling )
 *
 * All three terms are live. The base moves with the commitment the *user*
 * marked high-priority — the issue's `baseIntensityFromCommitment` — so the
 * clamp has something to clamp and its false branch is reachable from a real
 * request. The classification's term is the one that can only ever subtract,
 * which is how "avoidance may lower or hold pressure" is spelled in code
 * rather than in a comment. A previous pass instead flattened the classifier
 * to a constant and clamped the constant: green, and guaranteeing nothing,
 * because a clamp whose input can never exceed the cap is dead code wearing a
 * guarantee's clothes.
 *
 * `tone: 'firm'` is derived only from the ceiling and the commitment's own
 * priority, both of which the user sets. `'high'` is this codebase's spelling
 * of the issue's "Must".
 *
 * The ladder gate that rule 1 also requires lives at `pressureTurnFor` and
 * `situationAnalysis`; see the note there.
 *
 * ── How far this reaches today, stated plainly ───────────────────
 *
 * `getPressureCandidateForAgenda` has exactly two callers:
 * `src/app/api/agenda/route.ts` — the frozen legacy web surface — and
 * `src/scheduler/scheduler.ts`. **No `/api/mobile/**` route reaches it**; the
 * React Native client enforces the ceiling locally (#444).
 *
 * The agenda route passes the ceiling the account stored, read through
 * `readEscalationCeiling` — the same resolution the settings response uses
 * (#446). The scheduler hook evaluates the process-local, accountless legacy
 * state, so there is no stored ceiling to read for it and the default
 * applies — which is why the default being the gentlest value and not the
 * absent one is load-bearing.
 */
const CEILING_INTENSITY: Readonly<Record<PressureCeiling, PressureIntensity>> = Object.freeze({
  soft: 'low',
  followUp: 'medium',
  hard: 'high',
});

const INTENSITY_RANK: Readonly<Record<PressureIntensity, number>> = Object.freeze({
  low: 0,
  medium: 1,
  high: 2,
});

/**
 * Exported so the ceiling can be validated at the boundary that reads it. The
 * stored setting arrives as a Firestore string, where a value written by an
 * older build, a hand edit or a failed migration is ordinary — and
 * `PressureCeiling` is a compile-time type, which is no protection at all
 * against a document. Anything not on the whitelist is the gentlest ceiling,
 * because the failure mode of guessing wrong here is pushing a person harder
 * than they agreed to.
 */
export function normalizePressureCeiling(value: unknown): PressureCeiling {
  return value === 'soft' || value === 'followUp' || value === 'hard' ? value : DEFAULT_PRESSURE_CEILING;
}

function ceilingFrom(options: PressureOptions): PressureCeiling {
  return normalizePressureCeiling(options.ceiling);
}

function toneFor(candidate: PressureCandidate, ceiling: PressureCeiling): PressureTone {
  return ceiling === 'hard' && candidate.commitment.priority.level === 'high' ? 'firm' : 'soft';
}

/**
 * The base the commitment itself asks for, before any cap — the issue's
 * `baseIntensityFromCommitment`. It reads the priority the *user* set, which
 * is the only thing on the commitment that is theirs. `'low'` never appears
 * because `candidateFor` refuses low-priority commitments outright.
 */
function baseIntensityFor(commitment: Commitment): PressureIntensity {
  return commitment.priority.level === 'high' ? 'high' : 'medium';
}

function lowestIntensity(...levels: readonly PressureIntensity[]): PressureIntensity {
  return levels.reduce((lowest, level) => (INTENSITY_RANK[level] < INTENSITY_RANK[lowest] ? level : lowest));
}

/**
 * Exported as the seam the invariant is tested through: a test must be able to
 * hand this a base above the cap, which no production input can produce while
 * the classifier and the priority agree. A clamp that can only be exercised
 * with inputs that do not need clamping is untested by construction.
 */
export function intensityFor(
  base: PressureIntensity,
  behavior: AdaptiveBehavior,
  ceiling: PressureCeiling
): PressureIntensity {
  return lowestIntensity(base, behavior.maxPressureLevel, CEILING_INTENSITY[ceiling]);
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

/**
 * Rule 1 of the invariant above, applied to the conversational ladder.
 *
 * **The ladder advances on what the product did, never on what the person
 * failed to do.** `pressureCount` — pressure this product actually delivered —
 * is the only thing here that may move it.
 *
 * Two routes used to violate that, and both are closed:
 *
 *   - The classification is not a parameter. A behaviour-derived pressure
 *     counter of 2 for `avoidant` and 1 for `inconsistent` was folded into
 *     `pressureCount`, so being read as avoidant jumped a person straight to
 *     `blocker_probe` with no pressure having been delivered at all.
 *   - Nothing downstream reads the count of ignores as a reason to move. It
 *     used to, twice over: `ignoredCount >= 2` made `situationAnalysis` call
 *     the person `avoiding`, which `intentSelection` turned into
 *     `blocker_probe` with `tone: 'direct'` and a required question, and the
 *     event carried the count into the wording — "Call Maya has come back
 *     twice. What's blocking it?" — at the default ceiling, on the second
 *     ignored reminder. That is the harm #199 names, arriving by a route the
 *     first pass left open while the reported intensity label stayed `'low'`.
 *     The condition is gone from `situationAnalysis`, the count is gone from
 *     the `pressure_due` event, and `intentSelection` no longer has a term
 *     reading it.
 *
 * This is not gated by the ceiling. A raised ceiling means the user accepted
 * louder reminders; it is not a statement that missing one should be answered
 * with a harder question, and there is no evidence for that ordering either
 * way (#378). The issue's sentence has no ceiling clause in it — "avoidance may
 * lower or hold pressure, it may never raise it" — so neither does this.
 *
 * `ignoredCount` still gates *eligibility* (`isPressureEligible`) and still
 * feeds the classifier, which can only lower. Neither can raise anything.
 */
function pressureTurnFor(
  candidate: PressureCandidate,
  scopeId: string,
  lastRecord: PressureDeliveryRecord | null
) {
  const conversationStore = getConversationStateStore();
  const baseCommitmentState = conversationStore.getCommitment(scopeId, candidate.commitment.id);
  const commitmentState = {
    ...baseCommitmentState,
    // Observed, and deliberately still passed: the turn may know how many
    // reminders went unanswered (it is how the situation is *described*), and
    // nothing downstream may answer it with a harder move. Keeping the fact
    // here rather than hiding it is what makes that refusal testable —
    // `situationAnalysis` is handed the real count and still must not escalate.
    ignoredCount: candidate.ignoredCount,
    lastStrategy: lastRecord?.strategy || baseCommitmentState.lastStrategy,
    lastPath: lastRecord?.path || baseCommitmentState.lastPath,
    pressureCount: Math.max(baseCommitmentState.pressureCount, lastRecord ? 1 : 0),
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

/**
 * The scope key is the uid, per UC-1.0c's decision, and the document id is the
 * hash of the same key. The raw scope is kept in a field so the record stays
 * findable when the id is a digest.
 */
function documentPath(scopeId: string): string {
  return `${userCol(userIdForKey(scopeId), PRESSURE_DELIVERY)}/${docIdForKey(scopeId)}`;
}

export class StoragePressureDeliveryStore implements PressureDeliveryStore {
  constructor(private readonly injected?: StorageAdapter) {}

  /** Resolved per call so a test may swap the adapter after construction. */
  private get storage(): StorageAdapter {
    return this.injected ?? getStorage();
  }

  private async read(scopeId: string): Promise<Record<string, PressureDeliveryRecord>> {
    const stored = await this.storage.get<StoredPressureDelivery>(documentPath(scopeId));
    return stored ? normalizeSurfaced(stored.surfaced) : {};
  }

  async getLastSurfacedAt(scopeId: string, commitmentId: string): Promise<string | null> {
    return (await this.read(scopeId))[commitmentId]?.surfacedAt || null;
  }

  async getLastMessage(scopeId: string, commitmentId: string): Promise<string | null> {
    return (await this.read(scopeId))[commitmentId]?.message || null;
  }

  async getLastRecord(scopeId: string, commitmentId: string): Promise<PressureDeliveryRecord | null> {
    return (await this.read(scopeId))[commitmentId] || null;
  }

  /**
   * Transactional: two surfaces racing used to lose one, and a lost delivery
   * record is a missing cooldown — the user gets nudged twice.
   */
  async recordSurface(
    scopeId: string,
    commitmentId: string,
    surfacedAt: string,
    message?: string | null,
    metadata: PressureDeliveryMetadata = {},
  ): Promise<void> {
    const path = documentPath(scopeId);
    const strategy = normalizeStrategy(metadata.strategy);
    const realizedPath = normalizePath(metadata.path);

    await this.storage.runTransaction(async (tx) => {
      const stored = await tx.get<StoredPressureDelivery>(path);
      const surfaced = stored ? normalizeSurfaced(stored.surfaced) : {};
      const previous = surfaced[commitmentId];
      surfaced[commitmentId] = {
        surfacedAt,
        message: normalizeSurfacedMessage(message),
        strategy,
        path: realizedPath,
        recentPaths: realizedPath
          ? [...(previous?.recentPaths || []), realizedPath].slice(-18)
          : previous?.recentPaths || [],
      };
      tx.set<StoredPressureDelivery>(path, { scopeId, surfaced });
    });
  }

  async clear(scopeId?: string): Promise<void> {
    if (scopeId) {
      await this.storage.delete(documentPath(scopeId));
      return;
    }
    const rows = await this.storage.listGroup<StoredPressureDelivery>(PRESSURE_DELIVERY);
    for (const row of rows) await this.storage.delete(row.path);
  }
}

/**
 * The same implementation over a private in-memory adapter, so a test cannot
 * exercise semantics production does not have.
 */
export class MemoryPressureDeliveryStore extends StoragePressureDeliveryStore {
  constructor() {
    super(createMemoryStorage());
  }
}

export function createDefaultPressureDeliveryStore(): PressureDeliveryStore {
  return new StoragePressureDeliveryStore();
}

export async function clearPressureHistory(
  store: PressureDeliveryStore = createDefaultPressureDeliveryStore(),
  scopeId?: string
): Promise<void> {
  await store.clear(scopeId);
}

export async function getPressureCandidateForAgenda(
  items: readonly AgendaItem[],
  options: PressureOptions = {},
  state: DomainState = getCommandServiceState()
): Promise<PressureCandidateMessage | null> {
  const now = options.now || new Date();
  const nowMs = now.getTime();
  const cooldownMs = options.cooldownMs ?? PRESSURE_DELIVERY_COOLDOWN_MS;
  const deliveryStore = deliveryStoreFrom(options);
  const scopeId = scopePressureDelivery(options);

  const eligible = items
    .map((item) => candidateFor(item, state, nowMs))
    .filter((item): item is PressureCandidate => item !== null)
    .filter(isPressureEligible);

  // Sequential rather than `find`, because the cooldown check is now a storage
  // read: the first candidate not cooling down wins, and the ones after it are
  // never queried, exactly as the synchronous `find` behaved.
  let candidate: PressureCandidate | null = null;
  for (const item of eligible) {
    if (!(await isCoolingDown(scopeId, item.commitment.id, nowMs, cooldownMs, deliveryStore))) {
      candidate = item;
      break;
    }
  }

  if (!candidate) return null;

  const behavior = await adaptiveBehaviorFor(candidate, state, options);
  const ceiling = ceilingFrom(options);
  const tone = toneFor(candidate, ceiling);
  const lastRecord = await deliveryStore.getLastRecord(scopeId, candidate.commitment.id);
  const turn = pressureTurnFor(candidate, scopeId, lastRecord);

  return {
    commitmentId: candidate.commitment.id,
    message: turn.message,
    strategy: turn.plan.strategy,
    path: turn.debug?.realizationPath || 'continuity_choice',
    tone,
    intensity: intensityFor(baseIntensityFor(candidate.commitment), behavior, ceiling),
  };
}

export async function getPressureMessage(
  options: PressureOptions = {},
  state: DomainState = getCommandServiceState()
): Promise<PressureMessage> {
  return getPressureMessageForAgenda(options.agendaItems || [], options, state);
}

export async function getPressureMessageForAgenda(
  items: readonly AgendaItem[],
  options: PressureOptions = {},
  state: DomainState = getCommandServiceState()
): Promise<PressureMessage> {
  return (await getPressureCandidateForAgenda(items, options, state)) || noPressure();
}

export async function recordPressureDelivery(
  commitmentId: unknown,
  options: PressureOptions = {},
  state: DomainState = getCommandServiceState()
): Promise<PressureDeliveryResult> {
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
  if (await isCoolingDown(scopeId, id, nowMs, cooldownMs, deliveryStore)) {
    return { success: true, message: 'Pressure was already recorded recently.' };
  }

  const strategy = normalizeStrategy(options.surfacedStrategy);
  const realizedPath = normalizePath(options.surfacedPath);
  await deliveryStore.recordSurface(scopeId, id, now.toISOString(), normalizeSurfacedMessage(options.surfacedMessage), {
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
