import {
  CAPTURE_PROPOSAL_TTL_MS,
  captureAppLocaleFrom,
  type CaptureAppLocale,
  type CaptureConfirmationResultContract,
  type CaptureEntry,
  type CaptureHabitProposalContract,
  type CaptureItemEditContract,
  type CapturePreferredWindow,
  type CaptureProposalContract,
  type CaptureProposalEditContract,
} from '../../../src/contracts/v1/captureContracts';
import { createHash, randomUUID } from 'crypto';
import { compareByCodePoint } from '../../planning/shared/compare';
import {
  analyticsContextFrom,
  emitAnalyticsEvent,
  type AnalyticsContext,
} from '../../analytics/analyticsContext';
import { appendAnalyticsEvent } from '../../analytics/eventStore';
import {
  recordCaptureConfirmed,
  recordCaptureSubmitted,
  recordFirstValueReached,
} from '../../analytics/loopAnalytics';
import { resolveUserAccess } from '../../pilot/pilotAccess';
import { applyTrustAction } from '../../pilot/pilotTrustStore';
import { captureLlmProvider } from '../../llm/captureProvider';
import { getAiConsent } from '../../consents/aiConsentService';
import { configuredProviderName } from '../../../src/extraction/llm';
import type { ExtractionResult } from '../../../src/extraction/extractionTypes';
import { mapExtractionToCommand } from '../../../src/extraction/mapExtractionToCommand';
import { hasRequestEvidence, splitCaptureClauseDetails } from '../../../src/extraction/clauseSplitter';
import { isEventOnDay } from '../../../src/extraction/priorityLexicon';
import { thoughtCommitmentTitle } from '../../../src/extraction/thoughtCommitmentTitle';
import { applyEditToCommands, eventDayOf } from '../captureBoundary/applyEdits';
import {
  appendClarificationEvent,
  captureProposalFromDocument,
  captureProposalPath,
  captureProposalToDocument,
  answerClarification,
  ClarifyError,
  confirmCapture,
  createStorageCaptureProposalStore,
  type CaptureConfirmationCommitter,
  proposeCapture,
  type CaptureProposalStore,
  type StoredProposalDocument,
  type StoredCaptureProposal,
  type CapturePersistenceAdapter,
  ProposalChangedError,
  proposalRevision,
  revisionMatches,
  buildStructuredCommitmentArtifacts,
} from '../captureBoundary';
import { getStorage } from '../../storage';
import { createEmptyDomainState, type Command, type Commitment } from '../../../src/domain/stateMachine';
import { applyCommand, configureCommandService, getCommandServiceState } from '../commandService';
import { collisionIntervalOf, collisionsForCommitment, type CollisionCandidate, type CollisionWarning } from '../timeCollision';
import { CommandServiceCapturePersistenceAdapter } from './canonicalPersistence';
import {
  applyParticipantCommand,
  commitCaptureConfirmation,
  applyParticipantCommands,
  getParticipantStateSnapshot,
} from './participantState';
import { guardedMobileExtract } from './safety';
import { DEFAULT_MOBILE_TIMEZONE, dateFromOptionalIso, normalizeTimezone } from './time';
import type { WeeklyBlockContract } from '../../../src/contracts/v1/weeklyBlockContracts';
import {
  captureWeeklyBlockId,
  materializeWeeklyBlock,
  presentWeeklyBlock,
  readWeeklyBlock,
  weeklyBlockDocumentFrom,
  weeklyBlockPath,
} from '../../weeklyBlocks/weeklyBlockService';
import { createStorageRuntimeMemoryStore } from '../../runtimeMemory/runtimeMemoryStore';
import { createStorageGoalNodeLinkStore } from '../../goalGraph/linkStore';
import { GOAL_GRAPH_FIRST_GENERATION } from '../../../src/contracts/v1/goalGraphContracts';
import type { ActiveGoal } from '../captureBoundary/proposalShape';
import { readOwnedMemory } from './memoryService';
import { referenceStateFor, withPublicRemovedItems } from '../captureChat/chatReferences';
import { mergeChatProposalByRef, type ChatRefMergePlan } from '../captureChat/refMerge';
import { resolveModuleRuntime } from '../../../src/contracts/v1/runtimeControls';
import {
  buildHabitDefinition,
  cadenceOccurrencesPerPeriod,
  parseHabitCadence,
  parseHabitDefinitionInput,
  type HabitCadence,
  type HabitDefinition,
  type HabitOccurrence,
} from '../../../src/contracts/v1/habitContracts';
import { resolveCaptureKinds } from '../captureKinds/runtime';
import {
  captureTimedIntervals,
  freeSlotStillAvailable,
  withFreeSlotClarifications,
} from '../../planning/freeSlots';
import { horizonFrom, todayLocalDateFor } from '../habits/habitService';
import { materializeHabitOccurrences } from '../../habits/materialize';
import {
  HABITS,
  HABIT_OCCURRENCES,
  INTENT_SEEDS,
  MEMORY,
  docIdForKey,
  requireUserId,
  userSubDoc,
} from '../../storage';
import { INTENT_SEED_SCHEMA_VERSION, type IntentSeed } from '../../../src/contracts/v1/intentContracts';
import {
  MEMORY_RECORD_SCHEMA_VERSION,
  USER_STATED_MEMORY_TTL_MS,
  type RuntimeMemoryRecord,
} from '../../../src/contracts/v1/memoryContracts';

export interface MobileCaptureInput {
  text?: unknown;
  referenceTime?: unknown;
  timezone?: unknown;
  scopeId?: unknown;
  /**
   * The phone's UI language, `'ar' | 'en' | 'he'` (owner request 2026-09-30):
   * a model reading titles each item in it. Anything else is ignored.
   */
  locale?: unknown;
}

export interface MobileConfirmInput {
  proposalId?: unknown;
  scopeId?: unknown;
  itemIds?: unknown;
  selectedItemIds?: unknown;
  selectedHabitItemIds?: unknown;
  selectedGoalItemIds?: unknown;
  selectedSeedItemIds?: unknown;
  idempotencyKey?: unknown;
  /** What the user changed in review, applied with the confirm (#164). */
  edits?: unknown;
  /** Selected items confirmed as weekly blocks rather than one-offs («ثابت أسبوعي»). */
  weeklyBlockItemIds?: unknown;
  /** Selected items whose suggested goal link the person kept (audit 2026-10-03 #6). */
  goalLinkItemIds?: unknown;
  revision?: unknown;
}

type CaptureConfirmationIntent = {
  selectedItemIds: string[];
  selectedHabitItemIds: string[];
  selectedGoalItemIds: string[];
  selectedSeedItemIds: string[];
  weeklyBlockItemIds: string[];
  goalLinkItemIds: string[];
  edits: CaptureItemEditContract[];
  entry: CaptureEntry | null;
};

type PreparedV8Confirmation = {
  documents: Array<{ path: string; data: object }>;
  habitsPersisted: NonNullable<CaptureConfirmationResultContract['habitsPersisted']>;
  goalsPersisted: NonNullable<CaptureConfirmationResultContract['goalsPersisted']>;
  seedsPersisted: NonNullable<CaptureConfirmationResultContract['seedsPersisted']>;
};

/** A confirmed item linked to one of the person's goals, so the goal's progress counts it. */
export interface ConfirmedGoalLink {
  itemId: string;
  goalId: string;
  commitmentId: string;
}

/** The most goals a capture is matched against; more than anybody keeps active. */
const MAX_CAPTURE_GOALS = 50;

/**
 * The person's active goals, as a capture is matched against them (audit
 * 2026-10-03 #6): the memory store's own read (`retrieve` — active, fresh,
 * in scope), goals only, their ids and their own words. A failed read is no
 * goals: a capture is never failed by the lookup of a suggestion.
 */
async function activeGoalsFor(participantId: string | undefined): Promise<ActiveGoal[]> {
  if (!participantId) return [];
  try {
    const records = await createStorageRuntimeMemoryStore().retrieve({ scopeId: participantId, now: new Date().toISOString(), kind: 'goal' });
    return records
      .filter((record) => record.status === 'active' && typeof record.content === 'string' && record.content.trim().length > 0)
      .slice(0, MAX_CAPTURE_GOALS)
      .map((record) => ({ goalId: record.id, title: record.content.trim() }));
  } catch {
    return [];
  }
}

/**
 * Links each just-confirmed item the person kept a goal link on to that goal
 * (audit 2026-10-03 #6), through the goal graph's own link store — the one
 * `deriveGoalGraphProgress` counts — keyed `capture.<commitmentId>`, so a
 * replayed confirm finds the link it already made and makes no second one.
 *
 * The goal is the one the stored proposal suggested for that item, never one
 * the request names, and it must still be the caller's own active goal
 * (`readOwnedMemory`, the goal routes' own ownership check). Anything that
 * fails here leaves the commitment saved and unlinked: the confirm has
 * already succeeded and says so. Nothing is logged but the error's name.
 */
async function linkConfirmedItemsToGoals(
  proposalId: string,
  persisted: readonly PersistedProposalItem[],
  goalLinkItemIds: readonly string[],
  context: MobileBackendContext,
): Promise<ConfirmedGoalLink[]> {
  const uid = context.participantId;
  if (!uid || goalLinkItemIds.length === 0 || persisted.length === 0) return [];
  const stored = await store.get(proposalId).catch(() => undefined);
  if (!stored) return [];
  const wanted = new Set(goalLinkItemIds);
  const links = createStorageGoalNodeLinkStore();
  const out: ConfirmedGoalLink[] = [];
  for (const item of persisted) {
    if (!wanted.has(item.itemId)) continue;
    const suggestion = stored.contract.items.find((candidate) => candidate.itemId === item.itemId)?.goalLink;
    if (!suggestion) continue;
    try {
      const goal = await readOwnedMemory(uid, suggestion.goalId);
      if (goal.kind !== 'goal' || goal.status !== 'active') continue;
      const now = new Date().toISOString();
      const { link } = await links.claim({
        scopeId: uid,
        goalMemoryId: goal.id,
        nodeId: `capture.${item.commitmentId}`,
        generation: GOAL_GRAPH_FIRST_GENERATION,
        entityKind: 'commitment',
        confirmedByUserAt: now,
      }, now);
      const settled = link.state === 'linked' ? link : await links.settle(uid, link.linkId, item.commitmentId, now);
      if (settled?.state === 'linked') out.push({ itemId: item.itemId, goalId: goal.id, commitmentId: item.commitmentId });
    } catch (error) {
      console.error('[capture/confirm] goal link failed; the commitment is saved unlinked', error instanceof Error ? error.name : 'unknown');
    }
  }
  return out;
}

export interface PersistedProposalItem {
  itemId: string;
  commitmentId: string;
  title: string;
  resolvedTime: string | null;
}

export interface FailedProposalItem {
  itemId: string;
  reason: string;
}

export interface MobileBackendContext {
  participantId?: string;
  /**
   * When the request began, in ms on `Date.now` (CL1 round 6, M-b). The
   * capture's server budget runs from here rather than from the extractor,
   * so the auth check and the consent read count against it.
   */
  requestStartedAt?: number;
}

type MobileGlobals = typeof globalThis & {
  __maybesitterMobilePersistence?: CommandServiceCapturePersistenceAdapter;
};

const mobileGlobals = globalThis as MobileGlobals;
// Durable since #252: a proposal made on one instance must be confirmable on
// another, and must survive a redeploy. Resolved per call by the adapter.
const baseStore: CaptureProposalStore = createStorageCaptureProposalStore();
function storeWithFreeSlots(now: () => string): CaptureProposalStore {
  return {
    get: (proposalId) => baseStore.get(proposalId),
    put: async (proposal) => {
      const contract = await withFreeSlotClarifications(proposal.contract, proposal.scopeId, {
        timezone: proposal.timezone ?? DEFAULT_MOBILE_TIMEZONE,
        now: now(),
      });
      // The boundary returns the same contract object it hands to `put`. Keep
      // that object in sync so callers receive the derived clarification without
      // adding a second storage read (some callers deliberately tolerate a
      // failed post-write decoration read).
      if (contract !== proposal.contract) {
        const target = proposal.contract as unknown as Record<string, unknown>;
        for (const key of Object.keys(target)) delete target[key];
        Object.assign(target, contract);
      }
      await baseStore.put({ ...proposal, contract });
    },
  };
}
const store = storeWithFreeSlots(() => new Date().toISOString());
const persistence = mobileGlobals.__maybesitterMobilePersistence ?? new CommandServiceCapturePersistenceAdapter();
mobileGlobals.__maybesitterMobilePersistence = persistence;

const HABIT_FREQUENCY_OPTIONS = [1, 2, 3, 4, 5, 6, 7] as const;
const HABIT_DURATION_OPTIONS = [15, 30, 45, 60] as const;
const CAPTURE_KIND_TITLE_MAX_CODE_POINTS = 120;

function captureKindTitleFits(title: string): boolean {
  return Array.from(title).length <= CAPTURE_KIND_TITLE_MAX_CODE_POINTS;
}

function capturePointId(entity: { pointId?: string; itemId?: string; seedItemId?: string }): string {
  return entity.pointId ?? entity.itemId ?? entity.seedItemId ?? randomUUID();
}

function habitQuestion(habit: Pick<CaptureHabitProposalContract, 'cadence' | 'durationMinutes'>): CaptureHabitProposalContract['question'] {
  if (!habit.cadence) return { field: 'frequency', options: [...HABIT_FREQUENCY_OPTIONS] };
  if (!habit.durationMinutes) return { field: 'duration', options: [...HABIT_DURATION_OPTIONS] };
  return null;
}

function habitExplanation(
  habit: Pick<CaptureHabitProposalContract, 'cadence' | 'durationMinutes' | 'preferredWindow'>,
  locale: CaptureAppLocale,
): string | null {
  if (!habit.cadence || !habit.durationMinutes) return null;
  const count = habit.cadence.kind === 'weekly_count' ? habit.cadence.count : habit.cadence.weekdays.length;
  const window = typeof habit.preferredWindow === 'string' ? habit.preferredWindow : null;
  if (locale === 'en') return `${count} times a week${window ? `, ${window}` : ''}, ${habit.durationMinutes} minutes each time.`;
  if (locale === 'he') return `${count} פעמים בשבוע${window ? `, ${window}` : ''}, ${habit.durationMinutes} דקות בכל פעם.`;
  const part = window === 'morning' ? '، الصبح' : window === 'afternoon' ? '، بعد الظهر' : window === 'evening' ? '، المسا' : '';
  return `${count} مرات بالأسبوع${part}، ${habit.durationMinutes} دقيقة كل مرة.`;
}

function completeHabit(habit: CaptureHabitProposalContract, locale: CaptureAppLocale): CaptureHabitProposalContract {
  const question = habitQuestion(habit);
  return {
    ...habit,
    question,
    explanation: question ? null : habitExplanation(habit, locale),
    confirmable: question === null,
  };
}

function numberIn(text: string): number | null {
  const normalized = text.replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)));
  const match = /(?:^|\s)([1-7])\s*(?:مر(?:ة|ات)|times?)(?=\s|$)/i.exec(normalized);
  return match ? Number(match[1]) : null;
}

function habitFields(text: string): Pick<CaptureHabitProposalContract, 'cadence' | 'durationMinutes' | 'preferredWindow'> {
  const daily = /كل\s*يوم|every\s+(?:day|morning|evening)|כל\s*יום/i.test(text);
  const count = daily ? 7 : numberIn(text);
  const halfHour = /نص\s*ساعة|half\s+an?\s+hour|חצי\s*שעה/i.test(text);
  const minutes = /(?:^|\s)(15|30|45|60)\s*(?:دقيقة|minutes?|דקות)(?=\s|$)/i.exec(text);
  const preferredWindow: CapturePreferredWindow | null = /الصبح|morning|בבוקר/i.test(text) ? 'morning'
    : /بعد\s*الظهر|afternoon|אחר\s*הצהריים/i.test(text) ? 'afternoon'
      : /المسا|المساء|evening|בערב/i.test(text) ? 'evening' : null;
  return {
    cadence: count ? { kind: 'weekly_count', count } : null,
    durationMinutes: halfHour ? 30 : minutes ? Number(minutes[1]) : null,
    preferredWindow,
  };
}

function readsAsHabit(text: string, entry: CaptureEntry | null): boolean {
  if (/عندي\s+(?:تدريب|موعد)|appointment|meeting|יש\s+לי/i.test(text)) return false;
  return entry === 'habit'
    || /(?:بدي|حابب|نفسي)\s+.*(?:كل\s*يوم|مر(?:ة|ات)\s*بالأسبوع|أتعوّد)|I\s+want\s+to\s+.*every|want\s+to\s+build\s+the\s+habit|רוצה\s+.*כל\s*יום/i.test(text);
}

/** Doubt about the speaker's own action, never a polite request to the app. */
export function readsAsDoubt(text: string): boolean {
  const source = text.trim();
  if (!source) return false;
  if (/^(?:إذا\s+)?ممكن\s+(?:تذكرني|ذكّرني|فكرني|حطلي|تحطلي|ضيف|تضيف|ساعدني|فيك|بتقدر)(?=$|[\s،,.!?؟])|^could\s+you\s+(?:remind|add|schedule|book)\b|^אפשר\s+(?:להזכיר|להוסיף|לקבוע|לתזמן)(?=$|[\s,.!?])/i.test(source)) return false;
  if (/^و?\s*(?:عم\s+بفكر|بفكر|يمكن|مش\s+متأكد|يا\s+ريت)(?=$|[\s،,.!?؟])/i.test(source)) return true;
  // Bare «ممكن» is doubt only before a first-person form, never merely because
  // it appears somewhere in a request clause.
  if (/^و?\s*ممكن\s+(?:(?:أنا|انا|إني|اني)\s+)?[أاإآ][؀-ۿ]*/.test(source)) return true;
  if (/^(?:and\s+)?(?:maybe\s+i(?:['’]ll|\s+will|\s+might|\s+should|\s+can|\s+could)?\b|i(?:['’]m|\s+am)\s+(?:thinking|considering)\b|i\s+might\b|i(?:['’]m|\s+am)\s+not\s+sure\b)/i.test(source)) return true;
  return /^ו?\s*(?:אולי(?=$|[\s,.!?])|(?:אני\s+)?חושב(?:ת)?\s+ל|לא\s+בטוח(?:ה)?(?=$|[\s,.!?]))/.test(source);
}

function sourceSegmentFor(stored: StoredCaptureProposal, itemId: string, fallback: string): string {
  const source = stored.resultsByItemId?.get(itemId)?.rawText;
  return typeof source === 'string' && source.trim() ? source.trim() : fallback;
}

function readsAsUndecidedItem(
  item: CaptureProposalContract['items'][number],
  segment: string,
): boolean {
  return item.resolvedTime === null
    && item.needsClarification
    && !hasRequestEvidence(segment)
    && !readsAsDoubt(segment)
    && !readsAsHabit(segment, null);
}

function readsAsUndecidedHabitItem(
  item: CaptureProposalContract['items'][number],
  segment: string,
): boolean {
  // In the habit entry, a leading first-person desire (for example «بدي أقرا»)
  // is the undecided reading the entry may tilt. Other request evidence remains
  // decisive, as do any concrete date/time and appointment evidence.
  const withoutDesire = segment.replace(/^\s*(?:بدي|بدّي|بدنا|بدّنا)(?=$|\s)/, '').trim();
  return item.resolvedTime === null
    && !item.resolvedDate
    && item.needsClarification
    && !hasRequestEvidence(withoutDesire)
    && !isEventOnDay(segment)
    && !readsAsDoubt(segment)
    && !readsAsHabit(segment, null);
}

function v8ProposalStatus(contract: CaptureProposalContract): CaptureProposalContract['status'] {
  const habits = contract.habits ?? [];
  const actionable = contract.items.some((item) => !item.needsClarification)
    || habits.some((habit) => habit.confirmable)
    || (contract.goals?.length ?? 0) > 0
    || (contract.entry === 'thought' && contract.seeds.length > 0);
  if (actionable) return 'proposed';
  if (contract.items.length > 0 || habits.length > 0) return 'needs_clarification';
  return contract.seeds.length > 0 ? 'unresolved_intent' : 'no_commitment';
}

function withV8Understood(contract: CaptureProposalContract): CaptureProposalContract {
  const previous = new Map((contract.understood ?? []).map((line, index) => {
    const id = 'itemId' in line ? line.itemId : 'seedItemId' in line ? line.seedItemId : 'habitItemId' in line ? line.habitItemId : line.goalItemId;
    return [id, index] as const;
  }));
  const points = [
    ...contract.items.map((item) => ({ order: previous.get(item.itemId) ?? 10_000, line: { kind: 'commitment' as const, itemId: item.itemId, pointId: capturePointId(item), text: item.title } })),
    ...contract.seeds.map((seed) => ({ order: previous.get(seed.seedItemId) ?? 10_000, line: { kind: seed.kind, seedItemId: seed.seedItemId, pointId: capturePointId(seed), text: seed.summary } })),
    ...(contract.habits ?? []).map((habit) => ({ order: previous.get(habit.habitItemId) ?? 10_000, line: { kind: 'habit' as const, habitItemId: habit.habitItemId, pointId: habit.pointId, text: habit.title } })),
    ...(contract.goals ?? []).map((goal) => ({ order: previous.get(goal.goalItemId) ?? 10_000, line: { kind: 'goal' as const, goalItemId: goal.goalItemId, pointId: goal.pointId, text: goal.title } })),
  ].sort((a, b) => a.order - b.order);
  return { ...contract, status: v8ProposalStatus(contract), understood: points.map((point) => point.line) };
}

/** Adds the v8 families to the stored proposal only while the release-locked feature is on. */
export async function applyCaptureKindsToProposal(
  proposalId: string,
  uid: string,
  input: {
    text: string;
    entry: CaptureEntry | null;
    locale: CaptureAppLocale;
    timezone: string;
    now?: Date;
    /** Scripted model classifications; rules still validate and build fields. */
    modelKinds?: readonly ('habit' | 'goal')[];
  },
): Promise<CaptureProposalContract> {
  const requestNow = input.now ?? new Date();
  const stored = await store.get(proposalId);
  if (!stored || stored.scopeId !== uid) throw new Error('proposal not found');
  const memoryWritable = resolveModuleRuntime('memory').mode === 'enabled';
  let contract: CaptureProposalContract = {
    ...stored.contract,
    entry: input.entry,
    items: stored.contract.items.map((item) => ({ ...item, pointId: capturePointId(item) })),
    seeds: stored.contract.seeds.map((seed) => ({ ...seed, pointId: capturePointId(seed), suggestedTime: seed.suggestedTime ?? null })),
    habits: [...(stored.contract.habits ?? [])],
    goals: [...(stored.contract.goals ?? [])],
  };
  const doubtfulItems = contract.items.flatMap((item) => {
    const segment = sourceSegmentFor(stored, item.itemId, item.title);
    return readsAsDoubt(segment) ? [{ item, segment }] : [];
  });
  if (doubtfulItems.length > 0) {
    const movedIds = new Set(doubtfulItems.map(({ item }) => item.itemId));
    const commands = new Map(stored.commandsByItemId);
    const results = new Map(stored.resultsByItemId ?? []);
    for (const itemId of Array.from(movedIds)) {
      commands.delete(itemId);
      results.delete(itemId);
    }
    contract = {
      ...contract,
      items: contract.items.filter((item) => !movedIds.has(item.itemId)),
      seeds: [
        ...doubtfulItems.map(({ item, segment }) => ({
          seedItemId: randomUUID(), pointId: capturePointId(item), kind: 'consideration' as const, summary: segment,
          suggestedTime: item.resolvedTime ? { at: item.resolvedTime, timeZone: input.timezone } : null,
        })),
        ...contract.seeds,
      ],
    };
    stored.commandsByItemId = commands;
    stored.resultsByItemId = results;
  }

  // A rules extractor can return no entity for a timed doubt in one language.
  // With no item to correlate, use the capture boundary's canonical segments;
  // each seed and its suggested time still come from that segment alone.
  if (contract.items.length === 0 && contract.seeds.length === 0) {
    const doubtSegments = splitCaptureClauseDetails(input.text)
      .map((clause) => clause.text)
      .filter(readsAsDoubt);
    if (doubtSegments.length > 0) {
      const seeds = await Promise.all(doubtSegments.map(async (segment) => {
        const extracted = await guardedMobileExtract(segment, { now: requestNow, timezone: input.timezone });
        const instant = extracted.result.remindAt ?? extracted.result.dueAt;
        return {
          seedItemId: randomUUID(), pointId: randomUUID(), kind: 'consideration' as const, summary: segment,
          suggestedTime: instant ? { at: instant, timeZone: input.timezone } : null,
        };
      }));
      contract = { ...contract, seeds };
    }
  }

  if ((contract.habits?.length ?? 0) === 0) {
    const itemCandidates = contract.items.map((item) => ({
      candidate: item,
      segment: sourceSegmentFor(stored, item.itemId, item.title),
    }));
    const explicit = itemCandidates.find(({ candidate, segment }) => readsAsHabit(segment, null)
      || (input.entry === 'habit' && readsAsUndecidedHabitItem(candidate, segment)));
    // A message-level model hint is unambiguous only when there is one item.
    const modelOnly = input.modelKinds?.includes('habit') && itemCandidates.length === 1 ? itemCandidates[0] : undefined;
    const seedCandidate = input.entry === 'habit' && contract.seeds.length === 1
      ? { candidate: contract.seeds[0]!, segment: contract.seeds[0]!.summary }
      : undefined;
    const selected = explicit ?? modelOnly ?? seedCandidate;
    const candidate = selected?.candidate;
    if (candidate) {
      const title = 'title' in candidate ? candidate.title : candidate.summary;
      if (captureKindTitleFits(title)) {
        const entityId = 'itemId' in candidate ? candidate.itemId : candidate.seedItemId;
        const pointId = capturePointId(candidate);
        const fields = habitFields(selected.segment);
        const habit = completeHabit({
          habitItemId: randomUUID(), pointId, title, ...fields,
          explanation: null, question: null, confirmable: false,
        }, input.locale);
        contract = {
          ...contract,
          items: contract.items.filter((item) => item.itemId !== entityId),
          seeds: contract.seeds.filter((seed) => seed.seedItemId !== entityId),
          habits: [...(contract.habits ?? []), habit],
        };
        const commands = new Map(stored.commandsByItemId);
        commands.delete(entityId);
        stored.commandsByItemId = commands;
        const results = new Map(stored.resultsByItemId ?? []);
        results.delete(entityId);
        stored.resultsByItemId = results;
      }
    }
  }

  const modelSaysGoal = input.modelKinds?.includes('goal') === true;
  if ((input.entry === 'goal' || modelSaysGoal) && memoryWritable && (contract.habits?.length ?? 0) === 0
    && (contract.goals?.length ?? 0) === 0) {
    const undecidedItems = contract.items.filter((item) => readsAsUndecidedItem(
      item,
      sourceSegmentFor(stored, item.itemId, item.title),
    ));
    const modelItem = modelSaysGoal && contract.items.length === 1 ? contract.items[0] : undefined;
    const candidate: CaptureProposalContract['seeds'][number] | CaptureProposalContract['items'][number] | undefined =
      contract.seeds.find((seed) => seed.kind === 'possible_goal')
      ?? (input.entry === 'goal' ? undecidedItems[0] : undefined)
      ?? modelItem;
    if (candidate) {
      const title = 'summary' in candidate ? candidate.summary : candidate.title;
      if (captureKindTitleFits(title)) {
        const candidateId = 'seedItemId' in candidate ? candidate.seedItemId : candidate.itemId;
        contract = {
          ...contract,
          items: contract.items.filter((item) => item.itemId !== candidateId),
          seeds: contract.seeds.filter((seed) => seed.seedItemId !== candidateId),
          goals: [...(contract.goals ?? []), {
            goalItemId: randomUUID(), pointId: capturePointId(candidate), title,
          }],
        };
        const commands = new Map(stored.commandsByItemId);
        commands.delete(candidateId);
        stored.commandsByItemId = commands;
      }
    }
  }

  contract = withV8Understood(contract);
  await storeWithFreeSlots(() => requestNow.toISOString()).put({ ...stored, contract });
  return contract;
}

export class CaptureKindsInvalidEditError extends Error {
  constructor() { super('edit invalid'); this.name = 'CaptureKindsInvalidEditError'; }
}

/** Structured edits for the two v8 families and their conversions. */
export async function editCaptureKindsProposal(
  uid: string,
  edit: CaptureProposalEditContract,
  locale: CaptureAppLocale,
  now: Date = new Date(),
): Promise<CaptureProposalContract | null> {
  if (!resolveCaptureKinds()) return null;
  const stored = await store.get(edit.proposalId);
  if (!stored || stored.scopeId !== uid || stored.confirmedResult !== undefined) throw new CaptureKindsInvalidEditError();
  const editFingerprint = createHash('sha256').update(JSON.stringify(edit)).digest('hex');
  if (stored.editReceipt?.fingerprint === editFingerprint
    && stored.editReceipt.resultingRevision === (stored.contract.revision ?? 0)) {
    const replay = stored.editReceipt.answer as { proposal?: CaptureProposalContract } | undefined;
    return replay?.proposal ?? stored.contract;
  }
  if ((stored.contract.revision ?? 0) !== edit.revision) throw new ProposalChangedError(stored.contract, 'open');
  const target = edit.target;
  const change = edit.change as Record<string, unknown>;
  const handles = 'habitItemId' in target || 'goalItemId' in target || change.kind === 'habit' || change.kind === 'goal'
    || ('seedItemId' in target && change.kind === 'commitment' && Boolean(stored.contract.seeds.find((seed) => seed.seedItemId === target.seedItemId)?.suggestedTime));
  if (!handles) return null;
  const changedTitle = typeof change.text === 'string' ? change.text.trim() : undefined;
  if (changedTitle !== undefined && !captureKindTitleFits(changedTitle)) {
    throw new CaptureKindsInvalidEditError();
  }
  let contract: CaptureProposalContract = {
    ...stored.contract,
    items: stored.contract.items.map((item) => ({ ...item })), seeds: stored.contract.seeds.map((seed) => ({ ...seed })),
    habits: (stored.contract.habits ?? []).map((habit) => ({ ...habit })), goals: (stored.contract.goals ?? []).map((goal) => ({ ...goal })),
  };
  const commands = new Map(stored.commandsByItemId);
  const results = new Map(stored.resultsByItemId ?? []);
  const editedHabitPointIds = new Set(stored.captureKindsEditedHabitPointIds ?? []);
  if ('goalItemId' in target) {
    const index = contract.goals!.findIndex((candidate) => candidate.goalItemId === target.goalItemId);
    const goal = contract.goals![index];
    if (!goal || change.kind === 'commitment') throw new CaptureKindsInvalidEditError();
    if (change.kind === 'possible_goal') {
      contract.goals!.splice(index, 1);
      contract.seeds.push({
        seedItemId: randomUUID(), pointId: goal.pointId, kind: 'possible_goal',
        summary: changedTitle || goal.title,
        suggestedTime: null,
      });
    } else if (changedTitle) goal.title = changedTitle;
    else throw new CaptureKindsInvalidEditError();
  } else if ('habitItemId' in target) {
    const index = contract.habits!.findIndex((candidate) => candidate.habitItemId === target.habitItemId);
    if (index < 0) throw new CaptureKindsInvalidEditError();
    const before = contract.habits![index]!;
    if (change.kind === 'commitment') {
      contract.habits!.splice(index, 1);
      const itemId = randomUUID();
      const title = changedTitle || before.title;
      const artifacts = buildStructuredCommitmentArtifacts(stored, itemId, title);
      contract.items.push({ itemId, pointId: before.pointId, title, resolvedTime: null, needsClarification: true, timeEstimated: false, priority: 'normal', priorityEstimated: false, clarification: null });
      results.set(itemId, artifacts.result);
      commands.set(itemId, artifacts.commands);
    } else {
      const cadence = change.cadence === undefined ? before.cadence : parseHabitCadence(change.cadence);
      const durationMinutes = change.durationMinutes === undefined ? before.durationMinutes : Number(change.durationMinutes);
      if (durationMinutes !== null && (!Number.isInteger(durationMinutes) || durationMinutes < 5 || durationMinutes > 240)) throw new CaptureKindsInvalidEditError();
      const preferredWindow = change.preferredWindow === undefined ? before.preferredWindow : change.preferredWindow as CapturePreferredWindow | null;
      const title = changedTitle || before.title;
      if (!captureKindTitleFits(title)) throw new CaptureKindsInvalidEditError();
      contract.habits![index] = completeHabit({ ...before, cadence, durationMinutes, preferredWindow, title }, locale);
      if (change.cadence !== undefined || change.durationMinutes !== undefined) editedHabitPointIds.add(before.pointId);
    }
  } else if ('itemId' in target && change.kind === 'habit') {
    const index = contract.items.findIndex((candidate) => candidate.itemId === target.itemId);
    if (index < 0) throw new CaptureKindsInvalidEditError();
    const item = contract.items[index]!;
    const title = changedTitle || item.title;
    if (!captureKindTitleFits(title)) throw new CaptureKindsInvalidEditError();
    contract.items.splice(index, 1); commands.delete(item.itemId);
    contract.habits!.push(completeHabit({ habitItemId: randomUUID(), pointId: capturePointId(item), title, cadence: null, durationMinutes: null, preferredWindow: null, explanation: null, question: null, confirmable: false }, locale));
  } else if ('seedItemId' in target && change.kind === 'goal') {
    const index = contract.seeds.findIndex((candidate) => candidate.seedItemId === target.seedItemId);
    if (index < 0 || contract.seeds[index]!.kind !== 'possible_goal'
      || resolveModuleRuntime('memory').mode !== 'enabled') throw new CaptureKindsInvalidEditError();
    const seed = contract.seeds[index]!;
    const title = changedTitle || seed.summary;
    if (!captureKindTitleFits(title)) throw new CaptureKindsInvalidEditError();
    contract.seeds.splice(index, 1);
    contract.goals!.push({ goalItemId: randomUUID(), pointId: capturePointId(seed), title });
  } else if ('seedItemId' in target && change.kind === 'commitment') {
    const index = contract.seeds.findIndex((candidate) => candidate.seedItemId === target.seedItemId);
    if (index < 0) throw new CaptureKindsInvalidEditError();
    const seed = contract.seeds[index]!;
    contract.seeds.splice(index, 1);
    const itemId = randomUUID();
    const suggestedTime = seed.suggestedTime?.at
      ? { at: seed.suggestedTime.at, zone: seed.suggestedTime.timeZone }
      : undefined;
    const title = changedTitle ?? thoughtCommitmentTitle(seed.summary, { separatedTime: Boolean(suggestedTime) });
    const artifacts = buildStructuredCommitmentArtifacts(stored, itemId, title, suggestedTime);
    contract.items.push({ itemId, pointId: capturePointId(seed), title, resolvedTime: suggestedTime?.at ?? null, needsClarification: !suggestedTime, timeEstimated: false, priority: 'normal', priorityEstimated: false, clarification: null });
    results.set(itemId, artifacts.result);
    commands.set(itemId, artifacts.commands);
  } else throw new CaptureKindsInvalidEditError();
  contract = withV8Understood({ ...contract, revision: (contract.revision ?? 0) + 1 });
  contract = await withFreeSlotClarifications(contract, uid, {
    timezone: stored.timezone ?? DEFAULT_MOBILE_TIMEZONE,
    now: now.toISOString(),
  });
  const mutated: StoredCaptureProposal = {
    ...stored,
    contract,
    commandsByItemId: commands,
    resultsByItemId: results,
    ...(editedHabitPointIds.size ? { captureKindsEditedHabitPointIds: Array.from(editedHabitPointIds).sort(compareByCodePoint) } : {}),
    editReceipt: { fingerprint: editFingerprint, resultingRevision: contract.revision ?? 0, answer: { proposal: contract } },
  };
  // The durable proposal document is the CAS boundary. A concurrent edit that
  // won after the read above is returned as proposal_changed instead of being
  // overwritten by this edit.
  await getStorage().runTransaction(async (tx) => {
    const path = captureProposalPath(uid, edit.proposalId);
    const currentDocument = await tx.get<StoredProposalDocument>(path);
    if (!currentDocument) throw new CaptureKindsInvalidEditError();
    const current = captureProposalFromDocument(currentDocument);
    if (current.scopeId !== uid || current.confirmedResult !== undefined
      || (current.contract.revision ?? 0) !== edit.revision) {
      throw new ProposalChangedError(current.contract, current.confirmedResult === undefined ? 'open' : 'confirmed');
    }
    tx.set(path, captureProposalToDocument(mutated, new Date()));
  });
  return contract;
}

/**
 * Marks the items that happen *on* their day (UAT round 3, N11).
 *
 * The review edit sheet's «بدون وقت» sends `resolvedTime: null`, and the
 * confirm then keeps an event on its day as an all-day event but drops a
 * task's day (`keepEventOnItsDay`, FY1 M1). The card showed only «بدون وقت»
 * either way, so the dentist the calendar kept on Friday read as having no
 * day. The flag is the confirm's own test — `eventDayOf`, a `YYYY-MM-DD` day on
 * the stored reading and `isEventOnDay` over its words — read from the stored proposal,
 * which holds the readings the contract does not. One read, and only when some
 * item has a day to keep.
 */
async function withEventsOnTheirDay<T extends { proposalId: string; items: ReadonlyArray<{ itemId: string; resolvedDate?: string; needsClarification?: boolean }> }>(
  contract: T,
): Promise<T> {
  if (!contract.proposalId || !contract.items.some((item) => item.resolvedDate)) return contract;
  // The proposal (or the clarify answer) is already stored when this runs. A
  // failed read here must not turn a saved answer into an error — a retry
  // would meet `already_clarified` — so it degrades to no flag, which reads a
  // bare «بدون وقت»: the safe direction (review M3).
  let results: StoredCaptureProposal['resultsByItemId'];
  try {
    results = (await store.get(contract.proposalId))?.resultsByItemId;
  } catch {
    return contract;
  }
  if (!results) return contract;
  return {
    ...contract,
    items: contract.items.map((item) => {
      // Still asking for its hour: the confirm keeps nothing of it as it is,
      // so no day is promised (review M2).
      if (item.needsClarification) return item;
      // The confirm's own test (`eventDayOf`, shared with `keepEventOnItsDay`),
      // on the day this card shows.
      const onDay = Boolean(item.resolvedDate) && eventDayOf(results.get(item.itemId)) === item.resolvedDate;
      return onDay ? { ...item, eventOnDay: true } : item;
    }),
  };
}

function scopeIdFrom(value: unknown, context: MobileBackendContext = {}): string {
  if (context.participantId) return context.participantId;
  return typeof value === 'string' && value.trim() ? value.trim() : 'default';
}

function selectedIdsFrom(input: MobileConfirmInput): string[] {
  const raw = Array.isArray(input.selectedItemIds) ? input.selectedItemIds : input.itemIds;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function stringIds(value: unknown): string[] {
  return Array.isArray(value)
    ? Array.from(new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0))).sort(compareByCodePoint)
    : [];
}

function confirmationFingerprint(proposalId: string, scopeId: string, intent: CaptureConfirmationIntent): string {
  const edits = [...intent.edits].sort((a, b) => compareByCodePoint(a.itemId, b.itemId));
  return createHash('sha256').update(JSON.stringify({
    proposalId,
    scopeId,
    selectedItemIds: [...intent.selectedItemIds].sort(compareByCodePoint),
    selectedHabitItemIds: [...intent.selectedHabitItemIds].sort(compareByCodePoint),
    selectedGoalItemIds: [...intent.selectedGoalItemIds].sort(compareByCodePoint),
    selectedSeedItemIds: [...intent.selectedSeedItemIds].sort(compareByCodePoint),
    goalLinkItemIds: [...intent.goalLinkItemIds].sort(compareByCodePoint),
    weeklyBlockItemIds: [...intent.weeklyBlockItemIds].sort(compareByCodePoint),
    edits,
  })).digest('hex');
}

function preferredWindows(value: CapturePreferredWindow | null): Array<{ start: string; end: string }> {
  if (value === null) return [];
  if (typeof value === 'object') return [{ start: value.start, end: value.end }];
  if (value === 'morning') return [{ start: '06:00', end: '12:00' }];
  if (value === 'afternoon') return [{ start: '12:00', end: '17:00' }];
  return [{ start: '17:00', end: '22:00' }];
}

function buildCaptureHabit(
  uid: string,
  proposalId: string,
  key: string,
  point: CaptureHabitProposalContract,
  now: string,
  timezone: string,
  acceptedSuggestedValues: boolean,
): { habit: HabitDefinition; occurrences: readonly HabitOccurrence[] } {
  if (!captureKindTitleFits(point.title)
    || !point.confirmable || !point.cadence || !point.durationMinutes || point.question !== null) throw new Error('habit_invalid');
  const count = cadenceOccurrencesPerPeriod(point.cadence);
  const input = parseHabitDefinitionInput({
    scopeId: uid,
    title: point.title,
    cadence: point.cadence,
    durationMinutes: point.durationMinutes,
    preferredWindows: preferredWindows(point.preferredWindow),
    minimumOccurrences: count,
    maximumOccurrences: count,
    flexibility: 'flexible',
    recoveryPolicy: 'skip',
    source: 'capture_chat',
    confirmation: {
      confirmedByUserAt: now,
      sourceRef: proposalId,
      acceptedSuggestedValues,
    },
  });
  const habitId = docIdForKey(`capture-habit\0${key}\0${point.pointId}`);
  const habit = buildHabitDefinition(habitId, input, now);
  const materialized = materializeHabitOccurrences(habit, horizonFrom(todayLocalDateFor(now, timezone)));
  return { habit, occurrences: materialized.created };
}

function buildCaptureGoalMemory(uid: string, proposalId: string, key: string, point: { pointId: string; title: string }, now: string, language: CaptureAppLocale): RuntimeMemoryRecord {
  if (!captureKindTitleFits(point.title)) throw new Error('goal_invalid');
  const id = `mem_${createHash('sha256').update(`${uid}\0${key}\0${point.pointId}`).digest('hex')}`;
  return {
    version: MEMORY_RECORD_SCHEMA_VERSION,
    id,
    scopeId: uid,
    kind: 'goal',
    content: point.title,
    language,
    source: 'user_stated',
    confidence: 1,
    exportPolicy: 'personal_never_export',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    observedAt: now,
    staleAfter: new Date(Date.parse(now) + USER_STATED_MEMORY_TTL_MS).toISOString(),
    evidenceIds: [],
    provenance: { origin: 'capture', originRef: proposalId, confirmedByUserAt: now },
  };
}

function buildCaptureSeed(uid: string, proposal: CaptureProposalContract, key: string, seedItemId: string, now: string): IntentSeed {
  const point = proposal.seeds.find((seed) => seed.seedItemId === seedItemId);
  if (!point) throw new Error('seed_invalid');
  return {
    version: INTENT_SEED_SCHEMA_VERSION,
    seedId: docIdForKey(`capture-seed\0${key}\0${capturePointId(point)}`),
    scopeId: uid,
    kind: point.kind,
    summary: point.summary,
    status: 'open',
    revisitAt: null,
    source: 'capture',
    sourceRef: proposal.proposalId,
    provenance: { proposalId: proposal.proposalId, extractor: proposal.provenance.executedEngine, confirmedByUserAt: now },
    promotedTo: null,
    createdAt: now,
    updatedAt: now,
  };
}

function prepareV8Confirmation(
  uid: string,
  stored: StoredCaptureProposal,
  intent: CaptureConfirmationIntent,
  key: string,
  now: string,
): PreparedV8Confirmation {
  const habits = stored.contract.habits ?? [];
  const goals = stored.contract.goals ?? [];
  const habitIds = new Set(habits.map((point) => point.habitItemId));
  const goalIds = new Set(goals.map((point) => point.goalItemId));
  const seedIds = new Set(stored.contract.seeds.map((point) => point.seedItemId));
  if (intent.selectedHabitItemIds.some((id) => !habitIds.has(id))) throw new Error('habit_invalid');
  if (intent.selectedGoalItemIds.some((id) => !goalIds.has(id))) throw new Error('goal_invalid');
  if (intent.selectedSeedItemIds.some((id) => !seedIds.has(id))) throw new Error('seed_invalid');
  if (intent.selectedSeedItemIds.length > 0 && stored.contract.entry !== 'thought') throw new Error('invalid_selection');
  const documents: Array<{ path: string; data: object }> = [];
  const habitsPersisted: NonNullable<CaptureConfirmationResultContract['habitsPersisted']> = [];
  const goalsPersisted: NonNullable<CaptureConfirmationResultContract['goalsPersisted']> = [];
  const seedsPersisted: NonNullable<CaptureConfirmationResultContract['seedsPersisted']> = [];
  for (const id of intent.selectedHabitItemIds) {
    const point = habits.find((candidate) => candidate.habitItemId === id)!;
    const built = buildCaptureHabit(
      uid,
      stored.contract.proposalId,
      key,
      point,
      now,
      stored.timezone ?? 'UTC',
      !(stored.captureKindsEditedHabitPointIds ?? []).includes(point.pointId),
    );
    documents.push({ path: userSubDoc(requireUserId(uid), HABITS, built.habit.habitId), data: built.habit });
    for (const occurrence of built.occurrences) documents.push({ path: userSubDoc(requireUserId(uid), HABIT_OCCURRENCES, occurrence.occurrenceId), data: occurrence });
    habitsPersisted.push({ habitItemId: id, pointId: point.pointId, habitId: built.habit.habitId, title: point.title });
  }
  for (const id of intent.selectedGoalItemIds) {
    const point = goals.find((candidate) => candidate.goalItemId === id)!;
    const memory = buildCaptureGoalMemory(uid, stored.contract.proposalId, key, point, now, stored.responseLocale ?? 'ar');
    documents.push({ path: userSubDoc(requireUserId(uid), MEMORY, memory.id), data: memory });
    goalsPersisted.push({ goalItemId: id, pointId: point.pointId, goalId: memory.id, title: point.title });
  }
  for (const id of intent.selectedSeedItemIds) {
    const point = stored.contract.seeds.find((candidate) => candidate.seedItemId === id)!;
    const seed = buildCaptureSeed(uid, stored.contract, key, id, now);
    documents.push({ path: userSubDoc(requireUserId(uid), INTENT_SEEDS, seed.seedId), data: seed });
    seedsPersisted.push({ seedItemId: id, pointId: capturePointId(point), seedId: seed.seedId, kind: seed.kind, title: seed.summary });
  }
  if (documents.length > 450) throw new Error('too_many_writes');
  return { documents, habitsPersisted, goalsPersisted, seedsPersisted };
}

/**
 * The key two confirms of the same intent share.
 *
 * The edits are part of it (UC-2.4, #164). Without them, a user who confirms,
 * sees the title was wrong, goes back and confirms again with a correction would
 * send the same key — and the boundary would replay the first result and report
 * success while writing nothing. The second confirm is a different intent and
 * has to look like one.
 *
 * Edits are sorted by item id first, so two requests that differ only in the
 * order the client happened to collect them share a key rather than persisting
 * twice.
 */
/** Exported for the host-locale probe in `tests/contract/persistedOutputLocale.test.ts`. */
export function idempotencyKeyFor(
  proposalId: string,
  scopeId: string,
  selectedItemIds: string[],
  explicit: unknown,
  edits: CaptureItemEditContract[] = [],
  weeklyBlockItemIds: readonly string[] = [],
): string {
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  const stableEdits = [...edits]
    // Code-point order: the key is hashed and stored, and `localeCompare` would
    // make it depend on the serving host's locale (#121).
    .sort((a, b) => compareByCodePoint(a.itemId, b.itemId))
    .map((edit) => ({
      itemId: edit.itemId,
      ...(edit.title !== undefined ? { title: edit.title } : {}),
      ...(edit.resolvedTime !== undefined ? { resolvedTime: edit.resolvedTime } : {}),
      ...(edit.priority !== undefined ? { priority: edit.priority } : {}),
    }));
  return createHash('sha256')
    // Weekly choices only when made, so every key minted before weekly blocks
    // existed is unchanged; a weekly confirm is a different intent from a
    // one-off confirm of the same items and must not replay it.
    .update(JSON.stringify({
      proposalId, scopeId, selectedItemIds, edits: stableEdits,
      ...(weeklyBlockItemIds.length > 0 ? { weeklyBlockItemIds: [...weeklyBlockItemIds].sort(compareByCodePoint) } : {}),
    }))
    .digest('hex');
}

/**
 * The edits from a request body, with anything unrecognised dropped.
 *
 * Shape only — every value is validated by the boundary, which is the single
 * place that decides what a legal edit is. This just refuses to pass along
 * something that is not an array of objects with an item id.
 */
function editsFrom(value: unknown): CaptureItemEditContract[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): CaptureItemEditContract[] => {
    if (!entry || typeof entry !== 'object') return [];
    const edit = entry as Record<string, unknown>;
    if (typeof edit.itemId !== 'string' || !edit.itemId.trim()) return [];
    return [{
      itemId: edit.itemId,
      ...(edit.title !== undefined ? { title: edit.title as string } : {}),
      ...(edit.resolvedTime !== undefined ? { resolvedTime: edit.resolvedTime as string | null } : {}),
      ...(edit.priority !== undefined ? { priority: edit.priority as 'low' | 'normal' | 'high' } : {}),
      ...(edit.locationTrigger !== undefined ? { locationTrigger: edit.locationTrigger } : {}),
    }];
  });
}

function commitmentIdForCommands(commands: readonly Command[] | undefined): string | null {
  const createDraft = commands?.find((command): command is Extract<Command, { type: 'CreateDraft' }> => command.type === 'CreateDraft');
  return createDraft?.commitment.id ?? null;
}

function persistenceFor(context: MobileBackendContext = {}): CapturePersistenceAdapter {
  if (!context.participantId) return persistence;
  return {
    persistAtomically: async (commands: readonly Command[]) => applyParticipantCommands(context.participantId as string, commands),
    snapshot: () => getParticipantStateSnapshot(context.participantId as string),
  };
}

/**
 * Commits a confirmation atomically for an authenticated request (#148).
 *
 * Undefined without a participant: the in-process path has no user tree holding
 * the proposal, so there is no document to claim, and the boundary falls back to
 * its development behaviour rather than pretending to a guarantee.
 */
/**
 * Which engine to name in provenance, when there is one to name.
 *
 * `none` is not an extraction engine — it is the absence of one — so it
 * contributes no label and the capture is reported as whatever actually
 * answered, which is the rule-based extractor.
 */
function engineLabel(): { llmEngine?: 'gemini' | 'ollama' } {
  const configured = configuredProviderName();
  return configured === 'none' ? {} : { llmEngine: configured };
}

function committerFor(
  context: MobileBackendContext = {},
  v8?: { documents: ReadonlyArray<{ path: string; data: object }>; fingerprint: string; intent: CaptureConfirmationIntent },
): CaptureConfirmationCommitter | undefined {
  const participantId = context.participantId;
  if (!participantId) return undefined;
  return async ({ scopeId, proposalId, idempotencyKey, expectedRevision, commands, commandsByItemId, result, weeklyBlocks }) => {
    // The confirm is the person's "yes": that instant is the block's
    // `confirmedAt`, and the id is derived from the proposal and the item so a
    // retried confirm addresses the same document.
    const now = new Date();
    const blocks = weeklyBlocks.map(({ itemId, offer }) => {
      const doc = weeklyBlockDocumentFrom(
        { ...offer, confirmedAt: now.toISOString() },
        { id: captureWeeklyBlockId(proposalId, itemId), source: 'capture', now },
      );
      return { path: weeklyBlockPath(participantId, doc.id), data: doc };
    });
    return commitCaptureConfirmation(
      participantId,
      captureProposalPath(scopeId, proposalId),
      commands,
      idempotencyKey,
      expectedRevision,
      result,
      commandsByItemId,
      [...blocks, ...(v8?.documents ?? [])],
      v8?.fingerprint,
      v8?.intent,
    );
  };
}

/**
 * Materializes the weekly blocks a confirm created, and presents them.
 *
 * After the transaction, like the activation above it: busy blocks are written
 * through `replaceBusyBlocks`, which is its own set of commits. A failure here
 * leaves the block stored with `renewAt` already due, so the nightly sweep
 * materializes it; the confirm itself has succeeded and says so. Idempotent,
 * so a replay re-running it announces nothing new.
 */
async function materializeConfirmedWeeklyBlocks(
  proposalId: string,
  itemIds: readonly string[],
  context: MobileBackendContext,
): Promise<Array<{ itemId: string; block: WeeklyBlockContract }>> {
  const participantId = context.participantId;
  if (!participantId || itemIds.length === 0) return [];
  const out: Array<{ itemId: string; block: WeeklyBlockContract }> = [];
  for (const itemId of itemIds) {
    const block = await readWeeklyBlock(participantId, captureWeeklyBlockId(proposalId, itemId));
    if (!block) continue;
    try {
      await materializeWeeklyBlock(participantId, block);
    } catch (error) {
      console.error('[capture/confirm] weekly block materialization failed; the nightly sweep will retry', error instanceof Error ? error.name : 'unknown');
    }
    out.push({ itemId, block: presentWeeklyBlock((await readWeeklyBlock(participantId, block.id)) ?? block) });
  }
  return out;
}

async function persistedItem(
  proposalStore: CaptureProposalStore,
  proposalId: string,
  itemId: string,
  context: MobileBackendContext = {},
): Promise<PersistedProposalItem | null> {
  const stored = await proposalStore.get(proposalId);
  const item = stored?.contract.items.find((candidate) => candidate.itemId === itemId);
  const commitmentId = commitmentIdForCommands(stored?.commandsByItemId.get(itemId));
  if (!item || !commitmentId) return null;
  const state = context.participantId ? await getParticipantStateSnapshot(context.participantId) : getCommandServiceState();
  const commitment = state.commitments[commitmentId];
  return {
    itemId,
    commitmentId,
    title: commitment?.title ?? item.title,
    // An all-day commitment has no hour (FX3); its `dueAt` is the day's
    // midnight, which the saved screen would otherwise print as «00:00».
    // What was stored, when it can be read: a time cleared at confirm is no
    // time, not the proposal's old one (FY1 re-review, R-M4). The proposal's
    // time is only the fallback for a commitment the snapshot does not hold.
    resolvedTime: !commitment
      ? item.resolvedTime
      : commitment.timeSpec.allDay
        ? null
        : commitment.timeSpec.remindAt ?? commitment.timeSpec.dueAt ?? null,
  };
}

/**
 * Whether any commitment just confirmed lands on top of another open,
 * timed one (`collisionIntervalOf`: a `due_by` with a time counts, which is
 * what capture writes) -- the warning half of #football-fixtures task 10 ("warn him
 * if he adds a commitment that there is a collision"). Read against the same
 * participant-scoped snapshot `persistedItem` and `activateConfirmedItems`
 * already use, so this sees exactly the state the confirm just wrote, not a
 * stale read from before it.
 *
 * Each newly-persisted item is checked against every *other* commitment in
 * that snapshot, including a batch-mate confirmed in the same request: two
 * things captured together that overlap each other are still a collision
 * worth surfacing, not a pair the check is blind to because they arrived
 * together.
 */
async function collisionsForPersisted(
  persisted: readonly PersistedProposalItem[],
  context: MobileBackendContext = {},
): Promise<CollisionWarning[]> {
  if (persisted.length === 0) return [];
  const state = context.participantId
    ? await getParticipantStateSnapshot(context.participantId)
    : getCommandServiceState();
  const all = Object.values(state.commitments);
  return persisted.flatMap((item) => [...collisionsForCommitment(state.commitments[item.commitmentId], all)]);
}

async function activateConfirmedItems(
  proposalId: string,
  itemIds: readonly string[],
  context: MobileBackendContext = {},
): Promise<void> {
  const stored = await store.get(proposalId);
  if (!stored) return;

  for (const itemId of itemIds) {
    const commitmentId = commitmentIdForCommands(stored.commandsByItemId.get(itemId));
    if (!commitmentId) continue;
    const state = context.participantId ? await getParticipantStateSnapshot(context.participantId) : getCommandServiceState();
    const commitment = state.commitments[commitmentId];
    if (!commitment || commitment.status !== 'pending_confirmation') continue;
    const command: Command = {
      type: 'ConfirmCommitment',
      commitmentId,
      now: new Date().toISOString(),
    };
    if (context.participantId) {
      await applyParticipantCommand(context.participantId, command);
    } else {
      configureCommandService({});
      applyCommand(command);
    }
  }
}

export interface MobileClarifyInput {
  proposalId?: unknown;
  itemId?: unknown;
  questionId?: unknown;
  optionId?: unknown;
  freeText?: unknown;
  timezone?: unknown;
  referenceTime?: unknown;
  scopeId?: unknown;
  revision?: unknown;
}

/**
 * Runs one analytics write for the capture funnel, and never lets it matter.
 *
 * Two things are load-bearing here. The consent is read from the stored trust
 * record by `analyticsContextFrom` — the caller's word is not an input, and a
 * user who declined gets a context whose `emitAnalyticsEvent` writes nothing —
 * and every failure is swallowed into a log. A capture that succeeded must not
 * be reported to the user as failed because a metrics write fell over (#153);
 * the bookkeeping being wrong is the smaller of the two wrongs.
 */
async function recordCaptureFunnelEvent(
  participantId: string | undefined,
  record: (analytics: AnalyticsContext) => Promise<unknown>,
  now = new Date(),
): Promise<void> {
  if (!participantId) return;
  try {
    const analytics = await analyticsContextFrom(
      { anonymousUserId: participantId },
      appendAnalyticsEvent,
      now,
    );
    if (analytics) await record(analytics);
  } catch (error) {
    console.error('[capture] funnel analytics failed; the capture itself is unaffected', error);
  }
}

export async function proposeMobileCapture(input: MobileCaptureInput, context: MobileBackendContext = {}) {
  const requestStartedAt = context.requestStartedAt ?? Date.now();
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!text) throw new Error('text is required');

  // Layer 1 of UC-2.1 (#161): the server decides whether a model may be asked,
  // from the consent it holds. The client sends no such flag and could not be
  // believed if it did — `requestedEngine` is computed here, never read from
  // the request.
  const consent = context.participantId ? await getAiConsent(context.participantId) : 'declined';

  const locale = captureAppLocaleFrom(input.locale);
  const requestNow = dateFromOptionalIso(input.referenceTime, new Date(), 'referenceTime');
  const proposal = await proposeCapture(text, {
    now: requestNow,
    timezone: normalizeTimezone(input.timezone),
    scopeId: scopeIdFrom(input.scopeId, context),
    requestedEngine: consent === 'granted' ? 'model' : 'rules',
    requestStartedAt,
    ...(locale ? { locale } : {}),
    ...(locale ? { responseLocale: locale } : {}),
    activeGoals: await activeGoalsFor(context.participantId),
  }, {
    store: storeWithFreeSlots(() => requestNow.toISOString()),
    persistence: persistenceFor(context),
    commitConfirmation: committerFor(context),
    extractor: guardedMobileExtract,
    // The hosted model, metered and logged, for this account only (#160). With
    // no participant there is nobody to meter, so the capture stays on rules.
    ...(context.participantId
      ? { llmProvider: captureLlmProvider(context.participantId), ...engineLabel() }
      : {}),
  });

  // The funnel's first step (UC-2.R2, #172). Recorded for every submission the
  // server actually handled, including the ones that found nothing to save:
  // without the refusals the denominator is only the successes, and a funnel
  // measured that way cannot get worse.
  //
  // Length, never the text. And after the proposal, not before, so a capture
  // the extractor threw on is not counted as one that happened.
  await recordCaptureFunnelEvent(context.participantId, (analytics) =>
    recordCaptureSubmitted(analytics, { inputLength: text.length }));

  // What the capture offered as unresolved intent (#519). A count, and only a
  // count: a proposal is not yet anybody's seed, and what somebody may be
  // considering is the last thing that belongs in telemetry. Recorded through
  // the same swallow-and-log path as the line above, for the same reason —
  // a capture that worked must not be reported as failed because a metrics
  // write fell over.
  if (proposal.seeds.length > 0) {
    await recordCaptureFunnelEvent(context.participantId, (analytics) =>
      emitAnalyticsEvent(analytics, 'seed_proposed', { proposedCount: proposal.seeds.length }));
  }

  return withEventsOnTheirDay(proposal);
}

type WordToken = { text: string; index: number; length: number };

function correctionWordTokens(text: string): WordToken[] {
  return Array.from(text.matchAll(new RegExp('[\\p{L}\\p{M}\\p{N}]+', 'gu')), (match) => ({
    text: match[0], index: match.index ?? 0, length: match[0].length,
  }));
}

function singleCorrectionWord(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const tokens = correctionWordTokens(value);
  return tokens.length === 1 && tokens[0]!.text === value ? value : null;
}

/** Choose the corrected title token by the words around the uniquely heard token. */
function correctedToken(message: string, title: string, from: string, to: string): WordToken | null {
  const messageTokens = correctionWordTokens(message);
  const fromAt = messageTokens.flatMap((token, index) => token.text === from ? [index] : []);
  if (fromAt.length !== 1) return null;
  const titleTokens = correctionWordTokens(title);
  const candidates = titleTokens.flatMap((token, index) => token.text === to ? [{ token, index }] : []);
  if (candidates.length === 0) return null;
  const source = fromAt[0]!;
  let best: { token: WordToken; score: number } | null = null;
  for (const candidate of candidates) {
    let score = 0;
    for (let distance = 1; distance <= 3; distance += 1) {
      if (messageTokens[source - distance]?.text === titleTokens[candidate.index - distance]?.text) score += 4 - distance;
      if (messageTokens[source + distance]?.text === titleTokens[candidate.index + distance]?.text) score += 4 - distance;
    }
    if (!best || score > best.score) best = { token: candidate.token, score };
  }
  return best?.token ?? null;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CORRECTION = /[\u0000-\u001F\u007F-\u009F]/;
const URL_CORRECTION = /https?:\/\/|www\.|\.[a-z]{2,}/i;

/** Validate model correction reports, mint ids, and persist their title positions. */
async function attachSpokenCorrections(
  proposal: CaptureProposalContract,
  modelItems: readonly unknown[],
  message: string,
  proposalStore: CaptureProposalStore = store,
): Promise<CaptureProposalContract> {
  const stored = await proposalStore.get(proposal.proposalId);
  if (!stored) return proposal;
  const spans: NonNullable<StoredCaptureProposal['correctionSpans']> = { ...(stored.correctionSpans ?? {}) };
  const items = proposal.items.map((item) => {
    const operationIndex = stored.chatOperationIndices?.items[item.itemId];
    const raw = Number.isFinite(operationIndex) ? modelItems[Math.floor(operationIndex!)] : undefined;
    if (!raw || typeof raw !== 'object') return item;
    const reports = (raw as Record<string, unknown>).corrections;
    if (!Array.isArray(reports)) return item;
    const corrections: NonNullable<typeof item.corrections> = [];
    const seen = new Set<string>();
    for (const report of reports) {
      if (corrections.length >= 3 || !report || typeof report !== 'object') continue;
      const from = singleCorrectionWord((report as Record<string, unknown>).from);
      const to = singleCorrectionWord((report as Record<string, unknown>).to);
      if (!from || !to || CONTROL_CORRECTION.test(from) || CONTROL_CORRECTION.test(to) || URL_CORRECTION.test(from) || URL_CORRECTION.test(to)) continue;
      const key = `${from}\u0000${to}`;
      if (seen.has(key)) continue;
      const token = correctedToken(message, item.title, from, to);
      if (!token) continue;
      seen.add(key);
      const id = randomUUID();
      corrections.push({ id, from, to });
      spans[id] = { itemId: item.itemId, index: token.index, length: token.length };
    }
    return corrections.length > 0 ? { ...item, corrections } : item;
  });
  if (Object.keys(spans).length === Object.keys(stored.correctionSpans ?? {}).length) return proposal;
  const contract = { ...proposal, items };
  await proposalStore.put({ ...stored, contract, correctionSpans: spans });
  return contract;
}

function proposalStatus(contract: CaptureProposalContract): CaptureProposalContract['status'] {
  if (contract.items.length === 0) return contract.seeds.length > 0 ? 'unresolved_intent' : 'no_commitment';
  return contract.items.every((item) => item.needsClarification) ? 'needs_clarification' : 'proposed';
}

/**
 * One capture-chat turn's proposal (owner decision 2026-09-30).
 *
 * The same boundary, store, persistence, committer and guarded extractor as
 * `proposeMobileCapture`, so the proposal it stores is one the existing
 * clarify and confirm routes accept unchanged — weekly-block opt-in included.
 *
 *   items    the model's objects: each is validated against the person's
 *            turns together (`ProposeCaptureOptions.chat`); `text` is the
 *            newest message.
 *   null     the rules path, on `text` — the person's turns joined — exactly
 *            as a capture without a model is read.
 */
export async function proposeMobileChatTurn(
  input: {
    text: string;
    userTurns: readonly string[];
    /** First user-turn index each model delta item may use as evidence. */
    evidenceStartIndices?: readonly number[];
    /** First user-turn index usable to justify changed fields on existing items. */
    changedFieldEvidenceStartIndices?: readonly number[];
    items: readonly unknown[] | null;
    now: Date;
    timezone: string;
    /** The list the person saw before this message (chat UAT round 2), each title in the person's own words. */
    previous?: readonly { title: string; appTitle?: string; date: string | null; time: string | null; needsDayOrTime?: boolean; kind?: 'possible_goal' | 'consideration' | 'idea' | 'waiting_for'; result?: ExtractionResult }[];
    /** Ref-derived previous entry for each model delta item; null for an add. */
    previousMatchIndices?: readonly (number | null)[];
    /** Validated citation span for each model delta item, in the same order. */
    operationSources?: readonly string[];
    /** Exact clocks selected by chat answers to a pending AM/PM question. */
    answeredAmPmClocks?: readonly (string | null)[];
    /** Current proposal whose server refs form this new proposal's base. */
    baseProposalId?: string;
    /** Parsed model operations. Absent on the append-only rules path. */
    refPlan?: ChatRefMergePlan;
    /** The phone's UI language: the items' titles are shown in it (owner request 2026-09-30). */
    locale?: CaptureAppLocale;
    /** Language already resolved by the chat service, including its fallback. */
    responseLocale?: CaptureAppLocale;
    /** True only for the newest dictated turn; enables server-validated model corrections. */
    spoken?: boolean;
  },
  context: MobileBackendContext & { participantId: string },
) {
  const configured = configuredProviderName();
  const requestStore = storeWithFreeSlots(() => input.now.toISOString());
  const boundaryItems = input.items?.map((entry, index) => (
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? { ...(entry as Record<string, unknown>), __chatOpIndex: index }
      : entry
  )) ?? null;
  let proposal = await proposeCapture(input.text, {
    now: input.now,
    timezone: input.timezone,
    scopeId: context.participantId,
    requestedEngine: input.items ? 'model' : 'rules',
    ...(context.requestStartedAt === undefined ? {} : { requestStartedAt: context.requestStartedAt }),
    ...(boundaryItems ? { chat: {
      userTurns: input.userTurns,
      items: boundaryItems,
      previous: input.previous ?? [],
      ...(input.previousMatchIndices ? { previousMatchIndices: input.previousMatchIndices } : {}),
      ...(input.evidenceStartIndices ? { evidenceStartIndices: input.evidenceStartIndices } : {}),
      ...(input.changedFieldEvidenceStartIndices
        ? { changedFieldEvidenceStartIndices: input.changedFieldEvidenceStartIndices }
        : {}),
      ...(input.operationSources ? { operationSources: input.operationSources } : {}),
      ...(input.answeredAmPmClocks ? { answeredAmPmClocks: input.answeredAmPmClocks } : {}),
    } } : {}),
    titleWithoutLeadIn: true,
    guardUnresolvedIntentWithSchedule: true,
    ...(input.locale ? { locale: input.locale } : {}),
    ...(input.responseLocale ? { responseLocale: input.responseLocale } : {}),
    activeGoals: await activeGoalsFor(context.participantId),
  }, {
    store: requestStore,
    persistence: persistenceFor(context),
    commitConfirmation: committerFor(context),
    extractor: guardedMobileExtract,
    // The chat's items came from the configured hosted model; name it.
    ...(boundaryItems ? { llmEngine: configured === 'ollama' ? 'ollama' as const : 'gemini' as const } : {}),
  });
  if (input.spoken && input.items) proposal = await attachSpokenCorrections(proposal, input.items, input.text, requestStore);
  proposal = await mergeChatProposalByRef(requestStore, input.baseProposalId, proposal, input.refPlan);
  // A proposal the chat produced is a capture submitted, counted as the
  // capture route counts one: its length, never its words.
  if (proposal.items.length > 0) {
    await recordCaptureFunnelEvent(context.participantId, (analytics) =>
      recordCaptureSubmitted(analytics, { inputLength: input.text.length }));
  }
  return withEventsOnTheirDay(proposal);
}

/**
 * A chat conversation's current proposal, as the review cards show it — or
 * null when it is gone, is somebody else's, was already confirmed, or is older
 * than a proposal stays confirmable.
 *
 * With it, each item's title in the person's own words, where the card shows
 * an app-language one (owner request 2026-09-30): the chat matches the next
 * message to an item by those words (`chatEvidence`), and they are kept only
 * on the stored proposal, never in the answer.
 */
export async function readMobileChatProposal(proposalId: string, participantId: string, options: { includeConfirmed?: boolean } = {}) {
  let stored: StoredCaptureProposal | undefined;
  try {
    stored = await store.get(proposalId);
  } catch {
    return null;
  }
  if (!stored || stored.scopeId !== participantId || (stored.confirmedResult && !options.includeConfirmed)) return null;
  const age = stored.proposedAt ? Date.now() - Date.parse(stored.proposedAt) : 0;
  if (!Number.isFinite(age) || age > CAPTURE_PROPOSAL_TTL_MS) return null;
  const sourceTitles = new Map<string, string>();
  for (const item of stored.contract.items) {
    const source = stored.resultsByItemId?.get(item.itemId)?.sourceTitle;
    if (typeof source === 'string' && source.trim()) sourceTitles.set(item.itemId, source);
  }
  const refs = referenceStateFor(stored);
  const proposal = withPublicRemovedItems(stored.contract, stored);
  return {
    proposal: await withEventsOnTheirDay(proposal),
    confirmed: stored.confirmedResult !== undefined,
    sourceTitles,
    refs: refs.refs,
    lockedRefs: new Set(stored.lockedChatRefs ?? []),
    resultsByItemId: new Map(stored.resultsByItemId ?? []),
  };
}

/**
 * What each timed item of a stored proposal would occupy, by item id — read
 * off the draft commitment the confirm would write (`collisionIntervalOf`, the
 * confirm's own rule), so a proposal-time clash (the capture chat's, owner
 * request 2026-09-30) is measured exactly as the confirm will measure it. An
 * item with no time, or still asking for its hour, has none. A failed read is
 * no candidates: nothing to warn about is the safe answer to a lookup, never
 * an error on the person's message.
 */
export async function proposalCollisionCandidates(
  proposal: { proposalId: string; items: ReadonlyArray<{ itemId: string; resolvedTime: string | null; needsClarification?: boolean }> },
): Promise<Map<string, CollisionCandidate>> {
  const candidates = new Map<string, CollisionCandidate>();
  if (!proposal.proposalId || !proposal.items.some((item) => item.resolvedTime)) return candidates;
  let stored: StoredCaptureProposal | undefined;
  try {
    stored = await store.get(proposal.proposalId);
  } catch {
    return candidates;
  }
  for (const item of proposal.items) {
    if (!item.resolvedTime || item.needsClarification) continue;
    const draft = stored?.commandsByItemId.get(item.itemId)
      ?.find((command): command is Extract<Command, { type: 'CreateDraft' }> => command.type === 'CreateDraft')?.commitment;
    const interval = draft?.timeSpec ? collisionIntervalOf({ timeSpec: draft.timeSpec }) : null;
    if (interval) candidates.set(item.itemId, interval);
  }
  return candidates;
}

/**
 * Answer the one clarification (UC-2.5, #165).
 *
 * The scope is the authenticated uid, exactly as the confirm does it — a
 * `scopeId` in the body is not read. Without that a caller could answer a
 * question on somebody else's proposal, and the answer is applied to a
 * commitment.
 *
 * The answer is also written down, under the same uid the proposal lives
 * under. That was the one dependency this call never supplied, and because the
 * port was optional and optional-chained it compiled, ran, and recorded
 * nothing.
 */
export async function clarifyMobileCapture(input: MobileClarifyInput, context: MobileBackendContext = {}) {
  const proposalId = typeof input.proposalId === 'string' ? input.proposalId : '';
  const itemId = typeof input.itemId === 'string' ? input.itemId : '';
  const questionId = typeof input.questionId === 'string' ? input.questionId : '';
  if (!proposalId || !itemId || !questionId) {
    throw new Error('proposalId, itemId and questionId are required');
  }

  const scopeId = scopeIdFrom(input.scopeId, context);
  const clarifyNow = dateFromOptionalIso(input.referenceTime, new Date(), 'referenceTime');
  const before = await store.get(proposalId);
  if (!before || before.scopeId !== scopeId) throw new ClarifyError('proposal_not_found');
  const currentRevision = proposalRevision(before.contract);
  if (before.confirmedResult !== undefined) {
    throw new ProposalChangedError(before.contract, 'confirmed', before.confirmedResult as CaptureConfirmationResultContract);
  }
  const legacyClarify = input.revision === undefined && before.legacyConfirmRevision === currentRevision;
  if (!legacyClarify && !revisionMatches(currentRevision, input.revision)) throw new ProposalChangedError(before.contract, 'open');
  // The typed answer is read by the engine the capture itself may use (#161):
  // the metered model only when this account's AI consent is granted, the
  // rules otherwise. Decided here from the stored consent, never the request.
  const consent = context.participantId ? await getAiConsent(context.participantId) : 'declined';

  const storage = getStorage();
  const proposalPath = captureProposalPath(scopeId, proposalId);
  const compareAndSwapStore: CaptureProposalStore = {
    // `answerClarification` must transform exactly the version checked above.
    // Its final put re-reads inside the transaction below, so a slow free-text
    // extraction cannot overwrite an edit or reopen a proposal confirmed while
    // the extraction was in flight.
    get: async (requestedProposalId) => requestedProposalId === proposalId ? before : undefined,
    put: async (candidate) => {
      const enrichedContract = await withFreeSlotClarifications(candidate.contract, scopeId, {
        timezone: before.timezone ?? normalizeTimezone(input.timezone),
        now: clarifyNow.toISOString(),
        storage,
      });
      if (enrichedContract !== candidate.contract) {
        const target = candidate.contract as unknown as Record<string, unknown>;
        for (const key of Object.keys(target)) delete target[key];
        Object.assign(target, enrichedContract);
      }
      const next = { ...candidate, contract: enrichedContract };
      await storage.runTransaction(async (tx) => {
        const document = await tx.get<StoredProposalDocument>(proposalPath);
        if (!document) throw new ClarifyError('proposal_not_found');
        const current = captureProposalFromDocument(document);
        if (current.scopeId !== scopeId) throw new ClarifyError('proposal_not_found');
        if (current.confirmedResult !== undefined) {
          throw new ProposalChangedError(
            current.contract,
            'confirmed',
            current.confirmedResult as CaptureConfirmationResultContract,
          );
        }
        if (proposalRevision(current.contract) !== currentRevision) {
          throw new ProposalChangedError(current.contract, 'open');
        }
        if (legacyClarify && current.legacyConfirmRevision !== currentRevision) {
          throw new ProposalChangedError(current.contract, 'open');
        }
        // A seed keep is revision-neutral and can commit after the clarify's
        // initial read. Merge its markers from the transaction's current
        // document so this clarification cannot erase the keep while still
        // legitimately advancing the proposal revision.
        const refState = referenceStateFor(current);
        const answeredRef = refState.refs[itemId];
        tx.set(proposalPath, captureProposalToDocument({
          ...next,
          keptSeedItemIds: current.keptSeedItemIds,
          seedKeepReceipt: current.seedKeepReceipt,
          chatRefs: refState.refs,
          nextChatItemRef: refState.nextItem,
          nextChatSeedRef: refState.nextSeed,
          lockedChatRefs: Array.from(new Set([
            ...(current.lockedChatRefs ?? []),
            ...(answeredRef ? [answeredRef] : []),
          ])),
        }, new Date()));
      });
    },
  };

  const selectedOption = typeof input.optionId === 'string'
    ? before.contract.items.find((item) => item.itemId === itemId)?.clarification?.options
      .find((option) => option.optionId === input.optionId)
    : undefined;
  if (selectedOption?.labelKey === 'freeSlot'
    && selectedOption.value.localDate && selectedOption.value.localTime
    && !await freeSlotStillAvailable(scopeId, selectedOption.value.localDate, selectedOption.value.localTime, {
      timezone: before.timezone ?? normalizeTimezone(input.timezone),
      now: clarifyNow.toISOString(),
      held: captureTimedIntervals(before.contract),
      storage,
    })) {
    const refreshed = await withFreeSlotClarifications(
      { ...before.contract, revision: currentRevision + 1 },
      scopeId,
      {
        timezone: before.timezone ?? normalizeTimezone(input.timezone),
        now: clarifyNow.toISOString(),
        storage,
      },
    );
    await compareAndSwapStore.put({ ...before, contract: refreshed, legacyConfirmRevision: undefined });
    return { ...(await withEventsOnTheirDay(refreshed)), reason: 'not_free' as const };
  }

  const answered = await answerClarification(
    {
      proposalId,
      itemId,
      questionId,
      ...(typeof input.optionId === 'string' ? { optionId: input.optionId } : {}),
      ...(typeof input.freeText === 'string' ? { freeText: input.freeText } : {}),
    },
    {
      now: clarifyNow,
      timezone: normalizeTimezone(input.timezone),
      scopeId,
    },
    {
      store: compareAndSwapStore,
      resultingRevision: currentRevision + 1,
      // Every revisionless hop re-arms the compatibility marker. A request
      // carrying a revision deliberately ends the legacy chain.
      legacyConfirmRevision: input.revision === undefined ? currentRevision + 1 : undefined,
      extractor: guardedMobileExtract,
      ...(context.participantId && consent === 'granted'
        ? { llmProvider: captureLlmProvider(context.participantId), ...engineLabel() }
        : {}),
      recordEvent: (event) => appendClarificationEvent(scopeId, event),
    },
  );
  return withEventsOnTheirDay(answered);
}

export interface MobileCaptureConfirmationResponse {
  success: boolean;
  /** Safe machine-readable summary on contract-v8 refusal bodies. */
  error?: string;
  replayed: boolean;
  persisted: PersistedProposalItem[];
  failed: FailedProposalItem[];
  /** Why the boundary refused, so the route can answer 404 rather than 400 (#252). */
  failureCode?: CaptureConfirmationResultContract['failureCode'];
  /**
   * Which kind of write failure `persistence_failed` was (#419). Carried for
   * the same reason as `failureCode` above: dropping it here is what left the
   * emulator idempotency test unable to say whether it had found a durability
   * bug or a busy database.
   */
  failureCause?: CaptureConfirmationResultContract['failureCause'];
  /**
   * What just got persisted lands on top of, if anything (#football-fixtures
   * task 10). Always present, always empty on a failed confirm -- a field
   * that only sometimes exists is a field every client has to guard, and an
   * added field that is sometimes missing is indistinguishable from one an
   * older client already can't see.
   */
  collisions: CollisionWarning[];
  /**
   * The weekly blocks this confirm created («ثابت أسبوعي»), each with the
   * item it came from and everything the phone needs to write its recurring
   * device event (`block.deviceEvent`). Always present; empty otherwise.
   */
  weeklyBlocks: Array<{ itemId: string; block: WeeklyBlockContract }>;
  /**
   * The confirmed items now counted toward one of the person's goals (audit
   * 2026-10-03 #6): those named in `goalLinkItemIds` whose stored proposal
   * suggested that goal. Always present; empty otherwise.
   */
  goalLinks: ConfirmedGoalLink[];
  habitsPersisted?: NonNullable<CaptureConfirmationResultContract['habitsPersisted']>;
  goalsPersisted?: NonNullable<CaptureConfirmationResultContract['goalsPersisted']>;
  seedsPersisted?: NonNullable<CaptureConfirmationResultContract['seedsPersisted']>;
}

type CaptureFinalizeStep = 'activate' | 'weeklyBlocks' | 'goalLinks' | 'response';
let captureFinalizeFaultForTests: ((step: CaptureFinalizeStep) => boolean) | null = null;

/** Test seam for a process death after the atomic confirmation transaction. */
export function setCaptureFinalizeFaultForTests(fault: ((step: CaptureFinalizeStep) => boolean) | null): void {
  captureFinalizeFaultForTests = fault;
}

export class CaptureConfirmRefusedError extends Error {
  constructor(readonly reason: 'kinds_unavailable' | 'goals_unavailable' | 'key_reused') {
    super(reason);
    this.name = 'CaptureConfirmRefusedError';
  }
}

function maybeFailFinalize(step: CaptureFinalizeStep): void {
  if (captureFinalizeFaultForTests?.(step)) throw new Error(`injected capture finalizer fault before ${step}`);
}

export async function finalizeConfirmedCapture(proposalId: string, context: MobileBackendContext, replayed = false): Promise<MobileCaptureConfirmationResponse> {
  const stored = await store.get(proposalId);
  if (!stored || !stored.confirmedResult || stored.scopeId !== context.participantId) throw new Error('confirmed proposal not found');
  const result = stored.confirmedResult as CaptureConfirmationResultContract;
  const intent = stored.confirmationIntent as CaptureConfirmationIntent | undefined;
  maybeFailFinalize('activate');
  await activateConfirmedItems(proposalId, result.persistedItemIds, context);
  maybeFailFinalize('weeklyBlocks');
  const weeklyBlocks = await materializeConfirmedWeeklyBlocks(proposalId, intent?.weeklyBlockItemIds ?? [], context);
  const persisted = (await Promise.all(result.persistedItemIds.map((itemId) => persistedItem(store, proposalId, itemId, context))))
    .filter((item): item is PersistedProposalItem => item !== null);
  maybeFailFinalize('goalLinks');
  const goalLinks = await linkConfirmedItemsToGoals(proposalId, persisted, intent?.goalLinkItemIds ?? [], context);
  maybeFailFinalize('response');
  return {
    success: true,
    replayed,
    persisted,
    failed: [],
    collisions: await collisionsForPersisted(persisted, context),
    weeklyBlocks,
    goalLinks,
    habitsPersisted: result.habitsPersisted ?? [],
    goalsPersisted: result.goalsPersisted ?? [],
    seedsPersisted: result.seedsPersisted ?? [],
  };
}

export async function confirmMobileCapture(input: MobileConfirmInput, context: MobileBackendContext = {}): Promise<MobileCaptureConfirmationResponse> {
  const proposalId = typeof input.proposalId === 'string' ? input.proposalId : '';
  if (!proposalId) throw new Error('proposalId is required');

  const scopeId = scopeIdFrom(input.scopeId, context);
  const selectedItemIds = selectedIdsFrom(input);
  const selectedHabitItemIds = stringIds(input.selectedHabitItemIds);
  const selectedGoalItemIds = stringIds(input.selectedGoalItemIds);
  const selectedSeedItemIds = stringIds(input.selectedSeedItemIds);

  const edits = editsFrom(input.edits);
  const weeklyBlockItemIds = Array.isArray(input.weeklyBlockItemIds)
    ? input.weeklyBlockItemIds.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  const goalLinkItemIds = Array.isArray(input.goalLinkItemIds)
    ? input.goalLinkItemIds.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, 50)
    : [];
  const storedBefore = await store.get(proposalId);
  const isV8Proposal = Boolean(storedBefore && storedBefore.scopeId === scopeId
    && (storedBefore.contract.entry !== undefined || storedBefore.contract.habits !== undefined || storedBefore.contract.goals !== undefined));
  const hasV8Selection = selectedHabitItemIds.length + selectedGoalItemIds.length + selectedSeedItemIds.length > 0;
  if (selectedItemIds.length === 0 && !hasV8Selection) {
    if (isV8Proposal) {
      return { success: false, error: 'invalid_selection', replayed: false, failureCode: 'invalid_selection', persisted: [], failed: [], collisions: [], weeklyBlocks: [], goalLinks: [], habitsPersisted: [], goalsPersisted: [], seedsPersisted: [] };
    }
    throw new Error('itemIds is required');
  }
  if (hasV8Selection && !resolveCaptureKinds()) throw new CaptureConfirmRefusedError('kinds_unavailable');
  if (selectedGoalItemIds.length > 0 && resolveModuleRuntime('memory').mode !== 'enabled') throw new CaptureConfirmRefusedError('goals_unavailable');

  const intent: CaptureConfirmationIntent = {
    selectedItemIds: [...selectedItemIds].sort(compareByCodePoint),
    selectedHabitItemIds,
    selectedGoalItemIds,
    selectedSeedItemIds,
    weeklyBlockItemIds: [...weeklyBlockItemIds].sort(compareByCodePoint),
    goalLinkItemIds: [...goalLinkItemIds].sort(compareByCodePoint),
    edits,
    entry: storedBefore?.contract.entry ?? null,
  };
  const fingerprint = confirmationFingerprint(proposalId, scopeId, intent);
  const confirmationKey = typeof input.idempotencyKey === 'string' && input.idempotencyKey.trim()
    ? input.idempotencyKey.trim()
    : fingerprint;
  let prepared: PreparedV8Confirmation | undefined;
  if (isV8Proposal && storedBefore) {
    try {
      prepared = prepareV8Confirmation(scopeId, storedBefore, intent, confirmationKey, new Date().toISOString());
    } catch (error) {
      const code = error instanceof Error ? error.message : 'invalid_selection';
      const failureCode = (['too_many_writes', 'habit_invalid', 'goal_invalid', 'seed_invalid', 'invalid_selection'].includes(code) ? code : 'invalid_selection') as CaptureConfirmationResultContract['failureCode'];
      return { success: false, error: failureCode, replayed: false, failureCode, persisted: [], failed: [], collisions: [], weeklyBlocks: [], goalLinks: [], habitsPersisted: [], goalsPersisted: [], seedsPersisted: [] };
    }
  }
  let result: CaptureConfirmationResultContract;
  try {
    result = await confirmCapture({
    proposalId,
    scopeId,
    selectedItemIds,
    edits,
    ...(prepared ? {
      additionalWriteCount: prepared.documents.length,
      confirmationFingerprint: fingerprint,
      resultExtras: {
        habitsPersisted: prepared.habitsPersisted,
        goalsPersisted: prepared.goalsPersisted,
        seedsPersisted: prepared.seedsPersisted,
      },
    } : {}),
    ...(weeklyBlockItemIds.length > 0 ? { weeklyBlockItemIds } : {}),
    idempotencyKey: isV8Proposal ? confirmationKey : idempotencyKeyFor(proposalId, scopeId, selectedItemIds, input.idempotencyKey, edits, weeklyBlockItemIds),
    ...(input.revision === undefined
      ? (isV8Proposal && storedBefore ? { revision: storedBefore.contract.revision ?? 0 } : {})
      : { revision: input.revision as number }),
  }, {
    store,
    persistence: persistenceFor(context),
    commitConfirmation: committerFor(context, prepared ? { documents: prepared.documents, fingerprint, intent } : undefined),
  });
  } catch (error) {
    if (error instanceof Error && error.name === 'ConfirmationKeyReusedError') throw new CaptureConfirmRefusedError('key_reused');
    if ((error instanceof ProposalChangedError || (error instanceof Error && error.name === 'ProposalChangedError'))
      && (error as ProposalChangedError).state === 'confirmed' && isV8Proposal) {
      const finalized = await finalizeConfirmedCapture(proposalId, context, false);
      throw new ProposalChangedError((error as ProposalChangedError).proposal, 'confirmed', finalized as never);
    }
    throw error;
  }

  if (!result.success) {
    return {
      success: false,
      ...(isV8Proposal ? { error: result.failureCode ?? 'confirmation_failed' } : {}),
      // Kept, not dropped: the route needs it to answer 404 for a proposal
      // that is gone versus 400 for a request it refuses (#252). `failed[]`
      // still names each item, which is what a client shows the user.
      failureCode: result.failureCode,
      ...(result.failureCause === undefined ? {} : { failureCause: result.failureCause }),
      replayed: result.replayed,
      persisted: [],
      failed: selectedItemIds.map((itemId) => ({
        itemId,
        reason: result.failureCode ?? 'confirmation_failed',
      })),
      collisions: [],
      weeklyBlocks: [],
      goalLinks: [],
      ...(isV8Proposal ? { habitsPersisted: [], goalsPersisted: [], seedsPersisted: [] } : {}),
    };
  }

  if (isV8Proposal) {
    const finalized = await finalizeConfirmedCapture(proposalId, context, result.replayed);
    if (!result.replayed && context.participantId && (result.seedsPersisted?.length ?? 0) > 0) {
      for (const seed of result.seedsPersisted ?? []) {
        try {
          const analytics = await analyticsContextFrom({ anonymousUserId: context.participantId }, appendAnalyticsEvent, new Date());
          if (analytics) await emitAnalyticsEvent(analytics, 'seed_confirmed', { seedKind: seed.kind });
        } catch (error) {
          console.error('[capture/confirm] seed analytics failed; the seed itself is unaffected', error);
        }
      }
    }
    return finalized;
  }

  await activateConfirmedItems(proposalId, result.persistedItemIds, context);
  const weeklyBlocks = await materializeConfirmedWeeklyBlocks(
    proposalId,
    weeklyBlockItemIds.filter((itemId) => result.persistedItemIds.includes(itemId)),
    context,
  );
  const persisted = (await Promise.all(
    result.persistedItemIds.map((itemId) => persistedItem(store, proposalId, itemId, context)),
  )).filter((item): item is PersistedProposalItem => item !== null);

  if (context.participantId && persisted.length > 0) {
    // Everything above this line is the user's: the commitment is persisted and
    // activated. What follows is bookkeeping — the funnel event, the
    // first-value marker and the analytics event that goes with it.
    //
    // So it cannot be allowed to decide the answer. When it threw, this confirm
    // returned HTTP 400 and told the user their capture had failed while it sat
    // safely in Firestore, which is a worse outcome than the bookkeeping simply
    // being wrong. It is logged instead, loudly enough to find (#153).
    const now = new Date();

    // The funnel's second step (UC-2.R2, #172), counted off committed state
    // rather than off the request. `persisted` is what the boundary says it
    // wrote; this reads the user's own tree back and counts the commitments
    // that actually carry a `confirmedAt`. A confirm that wrote nothing, or
    // whose activation did not take, therefore records no confirmation —
    // which is the only way the number can be checked against anything.
    //
    // A replay records nothing. `replayed` means this exact confirm already
    // landed and the boundary is handing back the first result; counting it
    // again would turn one person's flaky connection into funnel progress.
    if (!result.replayed) {
      await recordCaptureFunnelEvent(context.participantId, async (analytics) => {
        const committed = await getParticipantStateSnapshot(context.participantId as string);
        const confirmedCount = persisted
          .filter((item) => Boolean(committed.commitments[item.commitmentId]?.confirmedAt))
          .length;
        if (confirmedCount === 0) return;
        await recordCaptureConfirmed(analytics, { confirmedCount });
      }, now);
    }

    try {
      const access = await resolveUserAccess(context.participantId, now.toISOString(), false);
      if (access.trust && !access.trust.firstValueAt) {
        await applyTrustAction(context.participantId, {
          type: 'record_first_value',
          at: now.toISOString(),
        });
        const analytics = await analyticsContextFrom({
          anonymousUserId: context.participantId,
          consent: access.trust.analyticsConsent ? 'granted' : 'essential',
        }, appendAnalyticsEvent, now);
        if (analytics) {
          await recordFirstValueReached(analytics, {
            surface: 'capture',
            reason: 'commitment_saved',
          });
        }
      }
    } catch (error) {
      console.error('[capture/confirm] first-value bookkeeping failed after the commitment was saved', error);
    }
  }

  return {
    success: true,
    replayed: result.replayed,
    persisted,
    failed: selectedItemIds
      .filter((itemId) => !result.persistedItemIds.includes(itemId))
      .map((itemId) => ({ itemId, reason: 'not_selected' })),
    collisions: await collisionsForPersisted(persisted, context),
    weeklyBlocks,
    goalLinks: await linkConfirmedItemsToGoals(proposalId, persisted, goalLinkItemIds, context),
  };
}

export function resetMobileBackendForTests(): void {
  // No state file since UC-1.0c (#142): commandService keeps its state in the
  // process, so a reset is just an empty state rather than a fresh temp path.
  configureCommandService({
    initialState: createEmptyDomainState(),
    schedulerStore: null,
  });
}

export function allMobileCommitments(): Commitment[] {
  return Object.values(getCommandServiceState().commitments);
}
