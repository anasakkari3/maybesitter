/**
 * Seeds: the things somebody is considering or waiting on (#519).
 *
 * ── A Seed is the third thing, and the product has to keep it third ──
 *
 * Between "this message asked for nothing" (#166) and "this is a commitment"
 * there is «يمكن أقدّم على NVIDIA هالفصل». Today that is forgotten. A Seed is
 * what remains instead, and every rule below exists to stop it quietly
 * becoming one of the other two:
 *
 *  - it does not enter Priority — nothing in `lib/priority/**` reads this
 *    store, and it holds no priority field to read;
 *  - it does not enter the Daily Plan — the planner builds from `commitments`
 *    and this is not in that tree;
 *  - it creates no reminders — a seed has no `timeSpec` and produces no
 *    `Command`, and reminders are scheduled from commands;
 *  - it never becomes actionable because a model grew more confident — there
 *    is no confidence anywhere in the contract, and no background writer;
 *  - `revisitAt` is the user's own "ask me again" marker, and promotion does
 *    not copy it onto anything.
 *
 * Each of those is asserted in `tests/mobile/intentSeeds.test.ts` rather than
 * trusted, because "we simply don't call it" is the kind of invariant that
 * survives exactly until somebody adds a reader.
 *
 * ── Promotion goes through the existing boundaries, or not at all ──
 *
 * "Turn into a task" does not write a commitment. It builds the same
 * `Command`s `mapExtractionToCommand` builds for every other commitment, from
 * an extraction marked `user_explicit` because the user said it, and applies
 * them through `applyParticipantCommands` — the one atomic write path — then
 * confirms through `ConfirmCommitment`. A promoted commitment is therefore
 * constructed by exactly the code every captured one is, and cannot drift
 * from it.
 *
 * "Turn into a goal" calls `createManualMemory` with kind `goal`: #168's
 * confirmed-goal representation, user-stated, confidence 1. There is no
 * second goal store.
 *
 * The claim comes first in both cases. `claimPromotion` flips the seed to
 * `promoted` in a transaction and refuses a second claim, so two taps cannot
 * produce two commitments for one seed — and if the create then fails, the
 * claim is released again so the user can try. The window that leaves is a
 * seed briefly marked promoted with nothing behind it, which is the harmless
 * direction: the alternative is two commitments for one thought.
 *
 * ── The telemetry cannot carry the sentence ──────────────────────
 *
 * The five lifecycle events are analytics events whose property allowlist
 * (`lib/analytics/privacySafeEvents.ts`) contains a kind and a count and
 * nothing else. `summary` is not omitted by convention here; there is no key
 * it could be sent under that the validator would accept.
 */
import { createHash } from 'crypto';
import {
  SEED_KINDS,
  SEED_SUMMARY_MAX_CHARACTERS,
  SEED_USER_STATUSES,
  type CreateSeedInput,
  type IntentSeed,
  type IntentSeedStore,
  type PatchSeedInput,
  type SeedExport,
  type SeedKind,
  type SeedStatus,
} from '../../../src/contracts/v1/intentContracts';
import type { MemoryLanguage } from '../../../src/contracts/v1/memoryContracts';
import type { ExtractionResult } from '../../../src/extraction/extractionTypes';
import { mapExtractionToCommand } from '../../../src/extraction/mapExtractionToCommand';
import type { Command } from '../../../src/domain/stateMachine';
import {
  analyticsContextFrom,
  emitAnalyticsEvent,
  type AnalyticsContext,
} from '../../analytics/analyticsContext';
import { appendAnalyticsEvent } from '../../analytics/eventStore';
import { createStorageIntentSeedStore } from '../../intentSeeds/intentSeedStore';
import { createStorageCaptureProposalStore, type CaptureProposalStore } from '../captureBoundary';
import { createManualMemory } from './memoryService';
import { applyParticipantCommand, applyParticipantCommands } from './participantState';

export class SeedNotFoundError extends Error {
  constructor() {
    super('seed not found');
    this.name = 'SeedNotFoundError';
  }
}

export class SeedValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedValidationError';
  }
}

/** A promotion that somebody else already claimed, or that the seed is past. */
export class SeedAlreadyResolvedError extends Error {
  constructor() {
    super('seed is already promoted or dismissed');
    this.name = 'SeedAlreadyResolvedError';
  }
}

export interface SeedServiceOptions {
  store?: IntentSeedStore;
  proposals?: CaptureProposalStore;
}

function storeOf(options: SeedServiceOptions): IntentSeedStore {
  return options.store ?? createStorageIntentSeedStore();
}

function proposalsOf(options: SeedServiceOptions): CaptureProposalStore {
  return options.proposals ?? createStorageCaptureProposalStore();
}

const LANGUAGES: readonly MemoryLanguage[] = ['ar', 'he', 'en', 'mixed'];

function requireKind(value: unknown): SeedKind {
  if (typeof value !== 'string' || !SEED_KINDS.includes(value as SeedKind)) {
    throw new SeedValidationError(`kind must be one of ${SEED_KINDS.join(', ')}`);
  }
  return value as SeedKind;
}

/**
 * A summary is one sentence somebody wrote, bounded in code points for the
 * reason `SEED_SUMMARY_MAX_CHARACTERS` gives.
 */
function requireSummary(value: unknown): string {
  if (typeof value !== 'string') throw new SeedValidationError('summary must be a string');
  const trimmed = value.trim();
  if (trimmed === '') throw new SeedValidationError('summary must not be empty');
  if (Array.from(trimmed).length > SEED_SUMMARY_MAX_CHARACTERS) {
    throw new SeedValidationError(`summary must be at most ${SEED_SUMMARY_MAX_CHARACTERS} characters`);
  }
  return trimmed;
}

/**
 * An ISO instant, or null to clear it. Absent means the patch did not mention
 * it, which is a different thing from clearing it.
 */
function optionalRevisitAt(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new SeedValidationError('revisitAt must be an ISO instant or null');
  }
  return new Date(value).toISOString();
}

function optionalStatus(value: unknown): SeedStatus | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !SEED_USER_STATUSES.includes(value as SeedStatus)) {
    // `promoted` lands here too, and deliberately: a client asking a patch to
    // mark a seed promoted is asking the seed to promote itself.
    throw new SeedValidationError(`status must be one of ${SEED_USER_STATUSES.join(', ')}`);
  }
  return value as SeedStatus;
}

function requireLanguage(value: unknown): MemoryLanguage {
  if (value === undefined || value === null) return 'mixed';
  if (typeof value !== 'string' || !LANGUAGES.includes(value as MemoryLanguage)) {
    throw new SeedValidationError(`language must be one of ${LANGUAGES.join(', ')}`);
  }
  return value as MemoryLanguage;
}

/**
 * One content-free lifecycle line, and never something that can fail the call.
 *
 * Exactly the arrangement `recordCaptureFunnelEvent` uses: consent is read
 * from the stored trust record by `analyticsContextFrom` rather than taken
 * from the caller, and every failure is swallowed into a log. A seed that was
 * saved must not be reported as failed because a metrics write fell over
 * (#153).
 */
async function recordSeedEvent(
  uid: string,
  record: (analytics: AnalyticsContext) => Promise<unknown>,
  now = new Date(),
): Promise<void> {
  try {
    const analytics = await analyticsContextFrom({ anonymousUserId: uid }, appendAnalyticsEvent, now);
    if (analytics) await record(analytics);
  } catch (error) {
    console.error('[seeds] lifecycle analytics failed; the seed itself is unaffected', error);
  }
}

export interface CreateSeedRequest {
  /** The capture proposal this seed was offered by, when there is one. */
  proposalId?: unknown;
  /** Which of that proposal's seed proposals the user picked. */
  seedItemId?: unknown;
  /** A seed the user typed themselves, with no proposal behind it. */
  kind?: unknown;
  summary?: unknown;
  idempotencyKey?: unknown;
}

/**
 * Keeps a seed the user picked (#519).
 *
 * ── The summary comes from the stored proposal, not from the request ──
 *
 * When `proposalId` and `seedItemId` are given, the sentence is read back out
 * of the proposal this server wrote, and the request's own `summary` — if it
 * sent one — is ignored. That is the issue's "exact source evidence" as a
 * mechanism rather than a promise: there is no path by which a client can
 * store a sentence under the provenance of a capture, so nothing a model was
 * asked to paraphrase can arrive wearing the user's own words.
 *
 * A manual seed carries `origin: manual` and no proposal, and its summary is
 * the user's typing, which is the only case where the request is the source.
 */
export async function createSeed(
  uid: string,
  request: CreateSeedRequest,
  at: string,
  options: SeedServiceOptions = {},
): Promise<{ seed: IntentSeed; replayed: boolean }> {
  const proposalId = typeof request.proposalId === 'string' && request.proposalId.trim()
    ? request.proposalId.trim()
    : null;
  const seedItemId = typeof request.seedItemId === 'string' && request.seedItemId.trim()
    ? request.seedItemId.trim()
    : null;

  let input: Omit<CreateSeedInput, 'idempotencyKey'>;
  if (proposalId) {
    if (!seedItemId) throw new SeedValidationError('seedItemId is required with proposalId');
    const stored = await proposalsOf(options).get(proposalId);
    // A proposal belonging to somebody else reads as one that does not exist,
    // the same answer `memoryService` gives for a foreign id: anything else
    // confirms the proposal is real and is somebody's.
    if (!stored || stored.scopeId !== uid) throw new SeedNotFoundError();
    const offered = stored.contract.seeds?.find((candidate) => candidate.seedItemId === seedItemId);
    if (!offered) throw new SeedNotFoundError();
    input = {
      scopeId: uid,
      kind: offered.kind,
      summary: offered.summary,
      source: 'capture',
      sourceRef: proposalId,
      provenance: {
        proposalId,
        extractor: stored.contract.provenance.executedEngine,
        confirmedByUserAt: at,
      },
    };
  } else {
    input = {
      scopeId: uid,
      kind: requireKind(request.kind),
      summary: requireSummary(request.summary),
      source: 'manual',
      sourceRef: null,
      // A manual seed is confirmed by the act of typing and saving it, so the
      // confirmation stamp is this call. There is nothing to attribute to an
      // extractor, and the field says so rather than naming one.
      provenance: { proposalId: null, extractor: null, confirmedByUserAt: at },
    };
  }

  const idempotencyKey = typeof request.idempotencyKey === 'string' && request.idempotencyKey.trim()
    ? request.idempotencyKey.trim()
    // No key sent: derive one from what makes this seed *this* seed. Two taps
    // of the same Keep therefore still collapse, which is the point — the
    // client supplying a key is an optimisation, not the guarantee.
    : createHash('sha256')
      .update(JSON.stringify({ uid, proposalId, seedItemId, summary: input.summary, kind: input.kind }))
      .digest('hex');

  const created = await storeOf(options).create({ ...input, idempotencyKey }, at);
  // A replay is not a new seed, so it is not a new event either: counting it
  // would turn somebody's flaky connection into two confirmations.
  if (!created.replayed) {
    await recordSeedEvent(uid, (analytics) =>
      emitAnalyticsEvent(analytics, 'seed_confirmed', { seedKind: created.seed.kind }));
  }
  return created;
}

export async function listSeeds(uid: string, options: SeedServiceOptions = {}): Promise<readonly IntentSeed[]> {
  return storeOf(options).list(uid);
}

export async function exportSeeds(uid: string, at: string, options: SeedServiceOptions = {}): Promise<SeedExport> {
  return storeOf(options).export(uid, at);
}

export interface PatchSeedRequest {
  summary?: unknown;
  kind?: unknown;
  status?: unknown;
  revisitAt?: unknown;
}

export async function patchSeed(
  uid: string,
  seedId: string,
  request: PatchSeedRequest,
  at: string,
  options: SeedServiceOptions = {},
): Promise<IntentSeed> {
  const input: PatchSeedInput = {
    ...(request.summary === undefined ? {} : { summary: requireSummary(request.summary) }),
    ...(request.kind === undefined ? {} : { kind: requireKind(request.kind) }),
    ...(() => {
      const status = optionalStatus(request.status);
      return status === undefined ? {} : { status };
    })(),
    ...(() => {
      const revisitAt = optionalRevisitAt(request.revisitAt);
      return revisitAt === undefined ? {} : { revisitAt };
    })(),
  };
  const updated = await storeOf(options).patch(uid, seedId, input, at);
  if (!updated) throw new SeedNotFoundError();

  // "Later" and "Dismiss" are the two the product wants to be able to count.
  // `hasRevisitAt` is a boolean, never the date: when somebody wants to be
  // asked again is their calendar, not our metric.
  if (input.status === 'snoozed') {
    await recordSeedEvent(uid, (analytics) => emitAnalyticsEvent(analytics, 'seed_snoozed', {
      seedKind: updated.kind,
      hasRevisitAt: updated.revisitAt !== null,
    }));
  } else if (input.status === 'dismissed') {
    await recordSeedEvent(uid, (analytics) =>
      emitAnalyticsEvent(analytics, 'seed_dismissed', { seedKind: updated.kind }));
  }
  return updated;
}

export async function deleteSeed(
  uid: string,
  seedId: string,
  options: SeedServiceOptions = {},
): Promise<boolean> {
  const removed = await storeOf(options).remove(uid, seedId);
  if (!removed) throw new SeedNotFoundError();
  return removed;
}

/**
 * What a promoted seed becomes: a commitment with no time, or a confirmed goal.
 *
 * Deliberately no third option and no `revisitAt` carried across. A seed's
 * revisit marker means "ask me about this again"; a commitment's time means
 * "this is due". Copying one onto the other would turn the reminder the issue
 * forbids into the reminder the user never asked for.
 */
export type SeedPromotionTarget = 'commitment' | 'goal';

/**
 * The extraction a promoted seed is built from.
 *
 * Confidence 1 and `user_explicit` throughout, because none of it is inferred
 * — the person pressed "Turn into a task" on a sentence they wrote. It is fed
 * through `mapExtractionToCommand` rather than hand-building a command, so a
 * promoted commitment is constructed by exactly the same code as a captured
 * one; `manuallyCompleted` in the capture boundary exists for the same reason.
 *
 * No time, in any field. `unscheduled` is a real `TimeSpec` kind, and it is
 * the only honest one here: the seed named no time, so inventing one would be
 * the "no invented date" rule broken at the last possible moment.
 */
function promotedCommitment(summary: string): ExtractionResult {
  return {
    type: 'task',
    action: summary,
    title: summary,
    person: null,
    dueAt: null,
    remindAt: null,
    localTimeSpec: null,
    timeEvidence: 'none',
    priority: { level: 'normal', source: 'user_explicit', pressureAllowed: false, pressureImplied: false },
    flexibility: 'movable',
    category: null,
    categoryConfidence: 0,
    confidence: { overall: 1, type: 1, action: 1, time: 1, priority: 1 },
    missingFields: [],
    ambiguityFlags: [],
    explicitReminderRequest: false,
    explicitPressureRequest: false,
    rawText: summary,
    parserVersion: 'seed-promotion-v1',
  };
}

function commitmentIdOf(commands: readonly Command[]): string | null {
  const draft = commands.find((command): command is Extract<Command, { type: 'CreateDraft' }> =>
    command.type === 'CreateDraft');
  return draft?.commitment.id ?? null;
}

export interface SeedPromotionResult {
  seed: IntentSeed;
  /** True when this promotion had already happened and is being handed back. */
  replayed: boolean;
}

/**
 * Turns a seed into a commitment or a goal, once (#519).
 *
 * The claim is taken before anything is created, so a second tap arriving
 * while the first is still writing finds the seed already promoted and gets
 * the first promotion's answer rather than creating a twin.
 */
export async function promoteSeed(
  uid: string,
  seedId: string,
  target: unknown,
  at: string,
  options: SeedServiceOptions = {},
): Promise<SeedPromotionResult> {
  if (target !== 'commitment' && target !== 'goal') {
    throw new SeedValidationError('target must be "commitment" or "goal"');
  }
  const store = storeOf(options);
  const existing = await store.get(uid, seedId);
  if (!existing) throw new SeedNotFoundError();
  if (existing.status === 'promoted') {
    // Already done. The user pressed twice, or the network repeated the
    // request; either way the answer is the promotion that happened, not a
    // second one.
    return { seed: existing, replayed: true };
  }
  if (existing.status === 'dismissed') throw new SeedAlreadyResolvedError();

  if (target === 'commitment') {
    /*
     * The commands are built first, because building them is what mints the
     * commitment id — and the claim has to name the real id, not a placeholder
     * this function would then have to go back and correct.
     *
     * Nothing is written by `mapExtractionToCommand`; it is a pure mapping.
     * So the order is: mint, claim, write. A second tap arriving between the
     * claim and the write is refused by the claim, which is the tap that must
     * not produce a second commitment.
     */
    const commands = mapExtractionToCommand(promotedCommitment(existing.summary), at);
    const commitmentId = commitmentIdOf(commands);
    if (!commitmentId) throw new SeedValidationError('a seed with no summary cannot become a commitment');
    const claimed = await store.claimPromotion(uid, seedId, { kind: 'commitment', id: commitmentId }, at);
    if (!claimed) throw new SeedAlreadyResolvedError();
    try {
      await applyParticipantCommands(uid, commands);
      // The same activation the capture confirm performs. A draft nobody
      // confirmed is not a commitment, and the user confirmed this one by
      // pressing the button.
      await applyParticipantCommand(uid, { type: 'ConfirmCommitment', commitmentId, now: at });
    } catch (error) {
      // The claim is released so the user can try again. A seed stuck at
      // `promoted` with nothing behind it is a dead end they cannot clear from
      // the screen, and it is the one state this flow must not leave behind.
      await store.patch(uid, seedId, { status: existing.status }, at).catch(() => null);
      throw error;
    }
    await recordSeedEvent(uid, (analytics) => emitAnalyticsEvent(analytics, 'seed_promoted', {
      seedKind: claimed.kind,
      promotedToKind: 'commitment',
    }));
    return { seed: claimed, replayed: false };
  }

  /*
   * A goal's id is minted by the memory store, so the claim is taken after it
   * is created rather than before. The ordering difference is real and small:
   * a goal created whose claim then fails leaves a confirmed goal the user can
   * see on the memory screen and delete, which is recoverable — a commitment
   * created twice is not.
   */
  const goal = await createManualMemory(
    uid,
    { kind: 'goal', content: existing.summary, language: requireLanguage(undefined) },
    at,
  );
  const settled = await store.claimPromotion(uid, seedId, { kind: 'goal', id: goal.id }, at);
  if (!settled) throw new SeedAlreadyResolvedError();
  await recordSeedEvent(uid, (analytics) => emitAnalyticsEvent(analytics, 'seed_promoted', {
    seedKind: settled.kind,
    promotedToKind: 'goal',
  }));
  return { seed: settled, replayed: false };
}
