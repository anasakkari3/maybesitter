import {
  CAPTURE_PROPOSAL_TTL_MS,
  type CaptureConfirmationResultContract,
  type CaptureItemEditContract,
} from '../../../src/contracts/v1/captureContracts';
import { createHash } from 'crypto';
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
import { eventDayOf } from '../captureBoundary/applyEdits';
import {
  appendClarificationEvent,
  captureProposalPath,
  answerClarification,
  confirmCapture,
  createStorageCaptureProposalStore,
  type CaptureConfirmationCommitter,
  proposeCapture,
  type CaptureProposalStore,
  type StoredCaptureProposal,
  type CapturePersistenceAdapter,
} from '../captureBoundary';
import { createEmptyDomainState, type Command, type Commitment } from '../../../src/domain/stateMachine';
import { applyCommand, configureCommandService, getCommandServiceState } from '../commandService';
import { collisionsForCommitment, type CollisionWarning } from '../timeCollision';
import { CommandServiceCapturePersistenceAdapter } from './canonicalPersistence';
import {
  applyParticipantCommand,
  commitCaptureConfirmation,
  applyParticipantCommands,
  getParticipantStateSnapshot,
} from './participantState';
import { guardedMobileExtract } from './safety';
import { dateFromOptionalIso, normalizeTimezone } from './time';
import type { WeeklyBlockContract } from '../../../src/contracts/v1/weeklyBlockContracts';
import {
  captureWeeklyBlockId,
  materializeWeeklyBlock,
  presentWeeklyBlock,
  readWeeklyBlock,
  weeklyBlockDocumentFrom,
  weeklyBlockPath,
} from '../../weeklyBlocks/weeklyBlockService';

export interface MobileCaptureInput {
  text?: unknown;
  referenceTime?: unknown;
  timezone?: unknown;
  scopeId?: unknown;
}

export interface MobileConfirmInput {
  proposalId?: unknown;
  scopeId?: unknown;
  itemIds?: unknown;
  selectedItemIds?: unknown;
  idempotencyKey?: unknown;
  /** What the user changed in review, applied with the confirm (#164). */
  edits?: unknown;
  /** Selected items confirmed as weekly blocks rather than one-offs («ثابت أسبوعي»). */
  weeklyBlockItemIds?: unknown;
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
const store: CaptureProposalStore = createStorageCaptureProposalStore();
const persistence = mobileGlobals.__maybesitterMobilePersistence ?? new CommandServiceCapturePersistenceAdapter();
mobileGlobals.__maybesitterMobilePersistence = persistence;

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

function committerFor(context: MobileBackendContext = {}): CaptureConfirmationCommitter | undefined {
  const participantId = context.participantId;
  if (!participantId) return undefined;
  return async ({ scopeId, proposalId, idempotencyKey, commands, commandsByItemId, result, weeklyBlocks }) => {
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
      result,
      commandsByItemId,
      blocks,
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

  const proposal = await proposeCapture(text, {
    now: dateFromOptionalIso(input.referenceTime, new Date(), 'referenceTime'),
    timezone: normalizeTimezone(input.timezone),
    scopeId: scopeIdFrom(input.scopeId, context),
    requestedEngine: consent === 'granted' ? 'model' : 'rules',
    requestStartedAt,
  }, {
    store,
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
    items: readonly unknown[] | null;
    now: Date;
    timezone: string;
  },
  context: MobileBackendContext & { participantId: string },
) {
  const configured = configuredProviderName();
  const proposal = await proposeCapture(input.text, {
    now: input.now,
    timezone: input.timezone,
    scopeId: context.participantId,
    requestedEngine: input.items ? 'model' : 'rules',
    ...(context.requestStartedAt === undefined ? {} : { requestStartedAt: context.requestStartedAt }),
    ...(input.items ? { chat: { userTurns: input.userTurns, items: input.items } } : {}),
  }, {
    store,
    persistence: persistenceFor(context),
    commitConfirmation: committerFor(context),
    extractor: guardedMobileExtract,
    // The chat's items came from the configured hosted model; name it.
    ...(input.items ? { llmEngine: configured === 'ollama' ? 'ollama' as const : 'gemini' as const } : {}),
  });
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
 */
export async function readMobileChatProposal(proposalId: string, participantId: string) {
  let stored: StoredCaptureProposal | undefined;
  try {
    stored = await store.get(proposalId);
  } catch {
    return null;
  }
  if (!stored || stored.scopeId !== participantId || stored.confirmedResult) return null;
  const age = stored.proposedAt ? Date.now() - Date.parse(stored.proposedAt) : 0;
  if (!Number.isFinite(age) || age > CAPTURE_PROPOSAL_TTL_MS) return null;
  return withEventsOnTheirDay(stored.contract);
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
  // The typed answer is read by the engine the capture itself may use (#161):
  // the metered model only when this account's AI consent is granted, the
  // rules otherwise. Decided here from the stored consent, never the request.
  const consent = context.participantId ? await getAiConsent(context.participantId) : 'declined';

  return withEventsOnTheirDay(await answerClarification(
    {
      proposalId,
      itemId,
      questionId,
      ...(typeof input.optionId === 'string' ? { optionId: input.optionId } : {}),
      ...(typeof input.freeText === 'string' ? { freeText: input.freeText } : {}),
    },
    {
      now: dateFromOptionalIso(input.referenceTime, new Date(), 'referenceTime'),
      timezone: normalizeTimezone(input.timezone),
      scopeId,
    },
    {
      store,
      extractor: guardedMobileExtract,
      ...(context.participantId && consent === 'granted'
        ? { llmProvider: captureLlmProvider(context.participantId), ...engineLabel() }
        : {}),
      recordEvent: (event) => appendClarificationEvent(scopeId, event),
    },
  ));
}

export async function confirmMobileCapture(input: MobileConfirmInput, context: MobileBackendContext = {}): Promise<{
  success: boolean;
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
}> {
  const proposalId = typeof input.proposalId === 'string' ? input.proposalId : '';
  if (!proposalId) throw new Error('proposalId is required');

  const scopeId = scopeIdFrom(input.scopeId, context);
  const selectedItemIds = selectedIdsFrom(input);
  if (selectedItemIds.length === 0) throw new Error('itemIds is required');

  const edits = editsFrom(input.edits);
  const weeklyBlockItemIds = Array.isArray(input.weeklyBlockItemIds)
    ? input.weeklyBlockItemIds.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  const result = await confirmCapture({
    proposalId,
    scopeId,
    selectedItemIds,
    edits,
    ...(weeklyBlockItemIds.length > 0 ? { weeklyBlockItemIds } : {}),
    idempotencyKey: idempotencyKeyFor(proposalId, scopeId, selectedItemIds, input.idempotencyKey, edits, weeklyBlockItemIds),
  }, {
    store,
    persistence: persistenceFor(context),
    commitConfirmation: committerFor(context),
  });

  if (!result.success) {
    return {
      success: false,
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
    };
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
