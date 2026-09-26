/**
 * What MaybeSitter knows about you, as the phone reads and edits it
 * (UC-2.7a, #167).
 *
 * ── The scope check is the whole security boundary ───────────────
 *
 * `RuntimeMemoryStore.get`, `.supersede`, `.revoke` and `.deleteById` address a
 * record **by id alone** — a collection-group query, because that API predates
 * there being a user tree to put records in. That is fine for a server-side
 * caller that already knows whose record it holds. It is not fine for a route,
 * where the id arrives in the URL from whoever asked: without a check, knowing
 * a `mem_…` id would be enough to read, rewrite or delete a stranger's memory.
 *
 * So every function here resolves the record first and refuses unless
 * `record.scopeId === uid`, and it refuses with the *same* answer it gives for
 * an id that does not exist. A 403 would confirm the record is real and belongs
 * to somebody, which is itself the leak.
 *
 * ── Delete means the whole chain ─────────────────────────────────
 *
 * Superseding keeps history: editing "sleep 22:30" to "sleep 00:30" leaves the
 * first record behind, superseded, so the store can show how a fact changed.
 * Deleting has to take that history with it. If it removed only the record the
 * user tapped, the sentence they asked to erase would still be sitting in the
 * chain behind its replacement — technically not "active", and entirely still
 * there. `deleteChain` walks `supersedesId` back to the first record and
 * `supersededById` forward to the last, and removes all of them.
 *
 * ── "Delete everything" has to mean the derived profile too ──────
 *
 * `deleteAllMemory` used to call `deleteScope` on the memory store and stop
 * (UC-2.7a, #167). The behaviour profile is not derived from memory — it is
 * derived from the feedback event log — so a user who asked MaybeSitter to
 * forget everything emptied the screen and kept a profile of themselves that
 * nothing in the app would ever show them again. That is not an incomplete
 * feature; it is the button's own label being false (UC-3.16, #202).
 *
 * The cascade is `deletePersonalizationScope`, the same function the frozen web
 * control centre and the release route call, rather than a second deletion path
 * that could drift from it. It deletes every derived store first — the feedback
 * log, the legacy behaviour counters the shipped classifier reads, and any
 * pending self-description proposal — and the user's memory rows last, which is
 * the order that fails safe: if a later step throws, the user has had *more*
 * erased than they asked for, never less, and this function still refuses to
 * report success.
 *
 * Which stores are in that set, and which are deliberately out of it, is argued
 * in `lib/personalization/deletion.ts`'s header and enumerated against
 * `USER_SCOPED_COLLECTIONS` by `tests/personalization/deletionScopeCoverage.test.ts`.
 *
 * Success is not the deleter's own opinion of itself. The receipt's remainders
 * are re-listed from the stores after the deletes, and the audit line and the
 * 200 are both withheld unless every remainder is zero — because the failure
 * that matters here is precisely a delete that returns a count and leaves rows
 * behind, and a user cannot check.
 */
import {
  USER_STATED_MEMORY_TTL_MS,
  type CreateMemoryInput,
  type MemoryLanguage,
  type MemoryProvenance,
  type RuntimeMemoryKind,
  type RuntimeMemoryRecord,
  type RuntimeMemoryStore,
} from '../../../src/contracts/v1/memoryContracts';
import type { MemoryOrigin } from '../../../src/contracts/v1/memoryContracts';
import type { FeedbackEventStore } from '../../../src/contracts/v1/feedbackContracts';
import { createStorageFeedbackEventStore } from '../../feedback/feedbackEventStore';
import { clearAiContextImportReceipt } from './aiContextImportService';
import { deletePersonalizationScope } from '../../personalization/deletion';
import { createPilotAuditEvent } from '../../pilot/closedPilotControls';
import { appendAudit } from '../../pilot/pilotTrustStore';
import { createStorageRuntimeMemoryStore } from '../../runtimeMemory/runtimeMemoryStore';
import {
  getAdaptiveBehavior,
  type AdaptivePressureLevel,
  type AdaptiveSuggestionStyle,
  type AdaptiveUserType,
} from '../adaptiveService';
import {
  StorageBehaviorFeedbackStore,
  getBehaviorFeedbackSignals,
  type BehaviorFeedbackStore,
} from '../behaviorFeedbackService';
import { getStorage, requireUserId, type StorageAdapter } from '../../storage';
import { recordDismissal } from '../../memoryGrowth/dismissals';
import {
  R1_FOCUS_WINDOW,
  R2_DEFER_DEFAULT,
  R3_PLAN_TIME,
  parseDeferDefaultFingerprint,
  parseFocusWindowFingerprint,
  parsePlanTimeFingerprint,
  type LocalWindow,
} from '../../memoryGrowth/rules';

/** The kinds a person may file something under by hand. */
export const MANUAL_MEMORY_KINDS: readonly RuntimeMemoryKind[] = ['fact', 'preference', 'goal'];

const MEMORY_LANGUAGES: readonly MemoryLanguage[] = ['ar', 'he', 'en', 'mixed'];

/**
 * A manual fact is a sentence, not an essay. 200 characters is the issue's
 * bound; it is enforced in code points rather than UTF-16 units so an Arabic
 * or Hebrew sentence gets the same allowance an English one does.
 */
export const MAX_MEMORY_CONTENT_LENGTH = 200;

export class MemoryNotFoundError extends Error {
  constructor() {
    super('memory not found');
    this.name = 'MemoryNotFoundError';
  }
}

export class MemoryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryValidationError';
  }
}

/**
 * A deletion that did not finish. Carries the remainders rather than a message,
 * so the route can say "not deleted" without inventing a number.
 */
export class MemoryDeletionIncompleteError extends Error {
  readonly remainingMemoryRecords: number;
  /**
   * Everything derived that survived, added together: feedback events, the
   * pre-event-log baseline, the legacy behaviour counters, any pending
   * self-description proposal, and which clubs the user follows (football
   * fixtures MVP, Task 7). One number because the user is owed one answer —
   * it did not finish — and the message names the parts.
   */
  readonly remainingPersonalizationRows: number;

  constructor(remainingMemoryRecords: number, remainingPersonalizationRows: number) {
    super(
      'memory deletion did not finish: '
      + `${remainingMemoryRecords} memory record(s) and ${remainingPersonalizationRows} personalization row(s) remain`,
    );
    this.name = 'MemoryDeletionIncompleteError';
    this.remainingMemoryRecords = remainingMemoryRecords;
    this.remainingPersonalizationRows = remainingPersonalizationRows;
  }
}

export interface MemoryServiceOptions {
  storage?: StorageAdapter;
  memory?: RuntimeMemoryStore;
  /** The behaviour log the profile is derived from; only delete-all reads it. */
  feedback?: FeedbackEventStore;
  /** The legacy counters the adaptive classifier reads; only the adaptive view reads it. */
  behaviorFeedback?: BehaviorFeedbackStore;
}

function storeOf(options: MemoryServiceOptions): RuntimeMemoryStore {
  return options.memory ?? createStorageRuntimeMemoryStore(undefined, options.storage);
}

function feedbackOf(options: MemoryServiceOptions): FeedbackEventStore {
  return options.feedback ?? createStorageFeedbackEventStore(options.storage);
}

function behaviorFeedbackOf(options: MemoryServiceOptions): BehaviorFeedbackStore {
  // The adapter this call was handed, not the process default — the same
  // discipline delete-all argues for below.
  return options.behaviorFeedback ?? new StorageBehaviorFeedbackStore(options.storage);
}

/**
 * Which sentence the screen puts under a fact (UC-3.16, #202).
 *
 * One token, derived from `source` and `provenance` together, because the
 * question a user is actually asking — "why is this here, and who decided it?"
 * — is answered by both fields at once and by neither alone. Deriving it here
 * rather than on the phone keeps the grammar in one place: a build that words
 * an onboarding answer as "you told us" and a later build that words it as
 * "from the questions you answered" would otherwise disagree with each other
 * about the same stored record.
 *
 * It is a projection of the record, never a stored field. There is nothing for
 * it to contradict, which is the distinction `MemoryProvenance`'s own header
 * draws when it refuses to repeat `source` on the record itself.
 */
export type MemorySourceLabel =
  /** The user typed it, or corrected something into their own words. */
  | 'you_told_us'
  /** The user answered it in the routine survey. */
  | 'you_answered_onboarding'
  /** A deterministic rule read it off behaviour the user had confirmed. */
  | 'noticed_from_confirmed'
  /** A model proposed it and the user agreed. */
  | 'model_suggested_you_confirmed'
  /** A model proposed it and nobody has agreed yet. */
  | 'model_suggested'
  /** The user brought it from another AI assistant and kept it. */
  | 'you_brought_from_ai';

export function sourceLabelOf(record: Pick<RuntimeMemoryRecord, 'source' | 'provenance'>): MemorySourceLabel {
  // First, and before the source is consulted at all: an import row is
  // confirmed by construction, so the edited and unedited versions of the same
  // imported line must not read differently on the screen.
  if (record.provenance?.origin === 'ai_context_import') return 'you_brought_from_ai';
  if (record.source === 'model_inferred') {
    return record.provenance?.confirmedByUserAt ? 'model_suggested_you_confirmed' : 'model_suggested';
  }
  if (record.source === 'deterministic_rule') return 'noticed_from_confirmed';
  return record.provenance?.origin === 'routine_survey' ? 'you_answered_onboarding' : 'you_told_us';
}

/**
 * What backs a fact, as the "Why?" line can actually answer it.
 *
 * ── Why the evidence ids are not here ────────────────────────────
 *
 * The record carries `evidenceIds`, and they are deliberately withheld. They
 * name rows in stores the phone cannot read, so the screen could only print
 * them as opaque strings — and an id a user cannot resolve is not evidence,
 * it is a receipt for evidence. `observationCount` is the part of them that
 * is honest to show: how many observations stand behind the sentence. It is
 * zero for everything written today, and saying zero is the point — nothing
 * currently reaches the store by observing the user, and the screen should be
 * able to say so rather than imply a pile of data that does not exist.
 *
 * ── Why `edited` and not the prior sentence ──────────────────────
 *
 * An edit supersedes (see `patchMemory`), so the record a user is reading may
 * have a replaced version behind it. `edited` says that happened. The prior
 * *content* stays out: the user replaced that sentence on purpose, and a
 * screen that reprinted it would be arguing with them about their own words.
 * The id stays out too — `listMemory` shows active records only, so it would
 * be a pointer nothing on this contract can follow.
 */
export interface MemoryEvidenceDto {
  /** Which path it arrived by. `null` on records written before #167. */
  origin: MemoryOrigin | null;
  /** When the thing it describes was true, which may precede `recordedAt`. */
  observedAt: string;
  /** When the record was written. */
  recordedAt: string;
  /** When the user explicitly confirmed it, or `null` if they never did. */
  confirmedAt: string | null;
  /** Whether this record replaced an earlier version of the same fact. */
  edited: boolean;
  /** How many observations back it. See the header on the withheld ids. */
  observationCount: number;
  /**
   * The pattern a rule read off the user's behaviour, when this record is one
   * they kept unedited (UC-3.16, #202; R2 in #532, R3 in #533). Null for everything else —
   * including a kept suggestion the user has since rewritten, because their
   * sentence is no longer the rule's claim.
   *
   * Sent as a structure rather than left in `provenance.originRef`, so the
   * phone can say "between 09:00 and 12:00" and the planner can read a kept
   * window without parsing a server-side key format.
   */
  pattern: MemoryPatternDto | null;
}

export type MemoryPatternDto =
  | { ruleId: typeof R1_FOCUS_WINDOW; window: LocalWindow }
  | { ruleId: typeof R2_DEFER_DEFAULT; deferMinutes: number }
  | { ruleId: typeof R3_PLAN_TIME; planTime: string };

function patternOf(record: RuntimeMemoryRecord): MemoryPatternDto | null {
  if (record.source !== 'deterministic_rule' || record.provenance?.origin !== 'behaviour_rule') return null;
  const window = parseFocusWindowFingerprint(record.provenance.originRef);
  if (window) return { ruleId: R1_FOCUS_WINDOW, window };
  const deferMinutes = parseDeferDefaultFingerprint(record.provenance.originRef);
  if (deferMinutes) return { ruleId: R2_DEFER_DEFAULT, deferMinutes };
  const planTime = parsePlanTimeFingerprint(record.provenance.originRef);
  return planTime ? { ruleId: R3_PLAN_TIME, planTime } : null;
}

/** What the phone receives. Deliberately not the stored record. */
export interface MemoryDto {
  id: string;
  kind: RuntimeMemoryKind;
  content: string;
  language: MemoryLanguage;
  source: RuntimeMemoryRecord['source'];
  sourceLabel: MemorySourceLabel;
  confidence: number;
  createdAt: string;
  observedAt: string;
  /**
   * When this stops being believed. Sent since UC-3.16 (#202) — see below.
   */
  staleAfter: string;
  provenance: MemoryProvenance | null;
  evidence: MemoryEvidenceDto;
}

/**
 * `scopeId`, `exportPolicy`, `status`, the supersession links and the raw
 * evidence ids are left out on purpose: the first is the caller's own uid, and
 * the rest are storage mechanics the screen has no decision to make about.
 * Sending them would make them contract, and something would start depending
 * on them. `exportPolicy` additionally never varies — every record here is
 * `personal_never_export` (`lib/runtimeMemory/exportPolicy.ts`) — so a field
 * carrying it would be a constant the client could only ever misread as a
 * choice.
 *
 * `staleAfter` used to be in that list and no longer is. It was withheld as a
 * storage mechanic, and for a user-stated fact it effectively is one: those
 * carry a ten-year TTL that means "until you change it". But an inference is
 * different in kind — it is a guess that has to be re-earned, and the date it
 * expires is a thing about the user's own data that they are owed, on the one
 * screen built to show them what is held and for how long. #202 asks for
 * staleness and this is it; the client words it, and words it differently for
 * a fact than for a guess.
 */
export function memoryToDto(record: RuntimeMemoryRecord): MemoryDto {
  return {
    id: record.id,
    kind: record.kind,
    content: record.content,
    language: record.language,
    source: record.source,
    sourceLabel: sourceLabelOf(record),
    confidence: record.confidence,
    createdAt: record.createdAt,
    observedAt: record.observedAt,
    staleAfter: record.staleAfter,
    provenance: record.provenance ? wireProvenance(record.provenance) : null,
    evidence: {
      origin: record.provenance?.origin ?? null,
      observedAt: record.observedAt,
      recordedAt: record.createdAt,
      confirmedAt: record.provenance?.confirmedByUserAt ?? null,
      edited: record.supersedesId !== undefined,
      observationCount: record.evidenceIds.length,
      pattern: patternOf(record),
    },
  };
}

/**
 * The provenance the phone is allowed to see.
 *
 * `model` and `promptVersion` are dropped. They name a model build and a prompt
 * revision — engineering identifiers the screen has no decision to make about,
 * and the sort of thing that becomes contract the moment it is sent. What the
 * user is owed about a model-proposed fact is that a model proposed it and
 * whether they agreed, which `sourceLabel` and `evidence.confirmedAt` already
 * say in words. Nothing writes a model-inferred record today; the wire is
 * narrowed before one exists rather than after.
 */
function wireProvenance(provenance: MemoryProvenance): MemoryProvenance {
  const { model: _model, promptVersion: _promptVersion, ...visible } = provenance;
  return visible;
}

/**
 * Everything currently believed about this account, newest first.
 *
 * Uses `retrieve`, not `listAll`, so the screen shows exactly what the rest of
 * the product can actually see: active, in scope, and not stale. A screen that
 * listed a stale record would be telling the user MaybeSitter remembers
 * something no consumer of the store can any longer read.
 */
export async function listMemory(
  uid: string,
  now: string,
  options: MemoryServiceOptions = {},
): Promise<MemoryDto[]> {
  requireUserId(uid);
  const records = await storeOf(options).retrieve({ scopeId: uid, now });
  // Re-sorted, because the store's order is not stable enough here.
  //
  // `retrieve` breaks ties on the record id, which is a random uuid. The
  // routine facts a survey writes all share one `observedAt` and one
  // `createdAt` — they were one save — so their order came out different on
  // every read. On the screen whose whole job is "here is what we know about
  // you", rows reshuffling on each pull-to-refresh reads as the app being
  // unsure of itself.
  //
  // Content is the last meaningful tiebreak: stable, visible to the user, and
  // it groups a routine answer next to its siblings. Code points, never
  // `localeCompare`, so the order cannot shift with the server's locale.
  return records.map(memoryToDto).sort((a, b) => (
    Date.parse(b.observedAt) - Date.parse(a.observedAt)
    || Date.parse(b.createdAt) - Date.parse(a.createdAt)
    || compareByCodePoint(a.content, b.content)
    || compareByCodePoint(a.id, b.id)
  ));
}

function compareByCodePoint(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * How reminders adapt to this account, as the phone renders it (UC-3.16, #202
 * step 1's `adaptive` field).
 *
 * ── Tokens, not sentences ────────────────────────────────────────
 *
 * Same split as `sourceLabel`: the server owns the *classification*, which
 * takes the behaviour counters to compute, and the phone owns the words, which
 * exist in three languages. A server that shipped English prose here would be
 * deciding what an Arabic screen says. So the classification crosses as the
 * enum the classifier produces and the post-UC-3.13 (#199) effect — a cap the
 * pressure path takes a minimum against, never a level it reaches for — as the
 * two values it consists of; the "it never makes reminders stronger" sentence
 * is copy, and copy lives in the app's locales.
 *
 * ── Where the classification comes from ──────────────────────────
 *
 * The same place the shipped classifier reads: the per-user behaviour counters
 * (`users/{uid}/behaviorFeedback`, UC-1.0c (#142)) through
 * `getBehaviorFeedbackSignals` and `getAdaptiveBehavior`, the exact functions
 * the pressure path uses. The web control centre's inventory
 * (`lib/personalizationControls/inventory.ts`) has no per-user signal source —
 * its route wires `readAdaptiveSignals: () => ({})` — so its adaptive view is
 * the unclassified default for everyone. This route has the real one and uses
 * it, rather than building a parallel classifier.
 *
 * ── Unset is an answer, not an error ─────────────────────────────
 *
 * An account with no recorded behaviour classifies as `disciplined` on the
 * normalized defaults — a label about a person derived from nothing. A counter
 * document that has never been written reports `updatedAt: null`, and that is
 * the honest answer the screen gets instead: no group yet, worded as such.
 * `effect` is null with it, because the guarantee is about what a *group* may
 * change and there is no group. Shown regardless of personalization consent,
 * on the inventory's own reasoning: consent governs derivation in the
 * personalization module, and turning it off does not unwrite a classifier
 * that shipped before the consent existed — hiding the label would make the
 * screen lie in the case the user is most likely to be looking.
 *
 * Reads, never writes: this is part of the GET, and the no-writes-on-read
 * property the route's tests pin covers it.
 */
export interface MemoryAdaptiveDto {
  /** The group the shipped classifier reads from this account's behaviour, or null before any exists. */
  classification: AdaptiveUserType | null;
  /** What the group is allowed to change. Null with `classification`. */
  effect: {
    /** The most pressure this group permits — it can lower, never raise. */
    maxPressureLevel: AdaptivePressureLevel;
    suggestionStyle: AdaptiveSuggestionStyle;
  } | null;
}

export const MEMORY_ADAPTIVE_UNSET: MemoryAdaptiveDto = Object.freeze({
  classification: null,
  effect: null,
});

export async function readMemoryAdaptive(
  uid: string,
  options: MemoryServiceOptions = {},
): Promise<MemoryAdaptiveDto> {
  requireUserId(uid);
  const store = behaviorFeedbackOf(options);
  const record = await store.get(uid);
  if (record.updatedAt === null) return MEMORY_ADAPTIVE_UNSET;
  const behavior = getAdaptiveBehavior(await getBehaviorFeedbackSignals({ userId: uid, feedbackStore: store }));
  return {
    classification: behavior.userType,
    effect: {
      maxPressureLevel: behavior.maxPressureLevel,
      suggestionStyle: behavior.suggestionStyle,
    },
  };
}

export interface CreateManualMemoryInput {
  kind: unknown;
  content: unknown;
  language: unknown;
}

export async function createManualMemory(
  uid: string,
  input: CreateManualMemoryInput,
  at: string,
  options: MemoryServiceOptions = {},
): Promise<MemoryDto> {
  requireUserId(uid);
  const create: CreateMemoryInput = {
    scopeId: uid,
    kind: requireManualKind(input.kind),
    content: requireContent(input.content),
    language: requireLanguage(input.language),
    source: 'user_stated',
    confidence: 1,
    observedAt: at,
    ttlMs: USER_STATED_MEMORY_TTL_MS,
    provenance: { origin: 'manual' },
  };
  return memoryToDto(await storeOf(options).put(create, at));
}

/**
 * An edit is a supersession, never a rewrite.
 *
 * The replacement is `user_stated` whatever the original was, and that is the
 * point of the rule: once somebody has corrected a sentence the AI proposed,
 * the sentence is theirs. It also stops an edited model guess from keeping the
 * lower confidence that would let a later guess outrank it.
 */
/**
 * One record, or a refusal shaped like "no such record".
 *
 * The single definition of "is this memory yours", exported so that a reader
 * outside this file — #526's goal execution graph, which is rooted in a goal
 * memory id somebody passed in a URL — checks ownership with the same two
 * lines the edit and delete paths use rather than with its own. An ownership
 * check that exists twice is an ownership check that will eventually exist in
 * one weaker version, and the weaker one will be on the newer route.
 */
export async function readOwnedMemory(
  uid: string,
  id: string,
  options: MemoryServiceOptions = {},
): Promise<RuntimeMemoryRecord> {
  requireUserId(uid);
  return requireOwnedRecord(storeOf(options), uid, id);
}

export async function patchMemory(
  uid: string,
  id: string,
  content: unknown,
  at: string,
  options: MemoryServiceOptions = {},
): Promise<MemoryDto> {
  requireUserId(uid);
  const store = storeOf(options);
  const prior = await requireOwnedRecord(store, uid, id);
  const replacement: CreateMemoryInput = {
    scopeId: uid,
    kind: prior.kind,
    content: requireContent(content),
    language: prior.language,
    source: 'user_stated',
    confidence: 1,
    observedAt: at,
    ttlMs: USER_STATED_MEMORY_TTL_MS,
    provenance: {
      ...(prior.provenance ?? { origin: 'manual' as const }),
      // The path it originally arrived by is kept — an edited onboarding answer
      // is still an onboarding answer — but the model fields go, because the
      // sentence that is now stored is not the one any model produced. Both of
      // them: a `promptVersion` left behind would attribute the user's own
      // words to the prompt revision that produced the sentence they replaced.
      confirmedByUserAt: at,
      model: undefined,
      promptVersion: undefined,
    } as MemoryProvenance,
  };
  const cleaned: CreateMemoryInput = {
    ...replacement,
    provenance: stripUndefined(replacement.provenance!),
  };
  return memoryToDto(await store.supersede(prior.id, cleaned, at));
}

/** Removes one fact and the whole supersession chain it belongs to. */
export async function deleteMemory(
  uid: string,
  id: string,
  at: string,
  options: MemoryServiceOptions = {},
): Promise<number> {
  requireUserId(uid);
  const store = storeOf(options);
  const record = await requireOwnedRecord(store, uid, id, { allowSuperseded: true });
  const { removed, ruleFingerprints } = await deleteChain(store, uid, record);
  // A pattern the user deleted is a pattern they turned down. Without this, the
  // next read would offer the same sentence straight back as a suggestion —
  // answering "forget that" with "did you mean to keep it?" (UC-3.16, #202).
  // After the delete, not before: the erasure is what was asked for.
  for (let index = 0; index < ruleFingerprints.length; index += 1) {
    await recordDismissal(options.storage ?? getStorage(), uid, ruleFingerprints[index]!, at);
  }
  await appendMemoryDeletion(uid, at, removed, 'memory_deleted_one');
  return removed;
}

/**
 * Removes every record this account holds, whatever its status, **and** the
 * behaviour log the personalization profile is derived from.
 *
 * Returns the number of memory records removed — the number the button's copy
 * is about. The feedback rows are not counted into it: they are a different
 * kind of thing, and one total covering both would tell the user they had more
 * "memories" than the screen ever listed.
 *
 * Throws `MemoryDeletionIncompleteError` rather than returning a count when
 * anything survives. See this file's header for why success is never the
 * deleter's own opinion of itself.
 */
export async function deleteAllMemory(
  uid: string,
  at: string,
  options: MemoryServiceOptions = {},
): Promise<number> {
  requireUserId(uid);
  const memory = storeOf(options);
  const feedbackEvents = feedbackOf(options);

  // Counted before the delete, from the store, because `deleteScope`'s own
  // return value is the thing under suspicion here.
  const held = (await memory.listAll(uid)).length;

  // Before the purge, and outside it: `deletePersonalizationScope` empties
  // collections and cannot see the user document's profile map, so the "last
  // brought over" date would survive a delete-everything and go on naming a
  // day this account imported memories that no longer exist.
  await clearAiContextImportReceipt(uid, { ...(options.storage ? { storage: options.storage } : {}) });

  const receipt = await deletePersonalizationScope({
    scopeId: uid,
    now: at,
    feedbackEvents,
    runtimeMemory: memory,
    // The adapter this call was handed, not the process default: otherwise a
    // caller that injects storage has its derived collections purged from a
    // different store than the one its memory lives in.
    ...(options.storage ? { storage: options.storage } : {}),
  });

  // The baseline is not an event, so it is not in the receipt's event count;
  // it is pre-event-log history of the same person and has to go with them.
  const baseline = await feedbackEvents.readBaseline(uid);
  // Every derived remainder the receipt carries, not only the event count. The
  // behaviour counters are the one that matters most here: they are the direct
  // input to the shipped classifier, and a deletion that left them reported a
  // number while the label it derives came back byte-identical (#202).
  // `remainingFootballFollowsCount` (football fixtures MVP, Task 7) joins them
  // for the same reason: this guard exists to catch the day the sweep does
  // not run, and a guard that cannot see one of the collections deletion.ts
  // now clears is blind exactly where that collection was just added.
  const remainingRows = receipt.remainingFeedbackEventCount
    + receipt.remainingBehaviorFeedbackCount
    + receipt.remainingProfileProposalCount
    + receipt.remainingMemoryDismissalCount
    + receipt.remainingFootballFollowsCount
    + receipt.remainingGoalStepProposalCount
    + (baseline === null ? 0 : 1);
  if (receipt.remainingRuntimeMemoryRecordCount > 0 || remainingRows > 0) {
    throw new MemoryDeletionIncompleteError(receipt.remainingRuntimeMemoryRecordCount, remainingRows);
  }

  // A row written between the remainder read above and this line survives with
  // a 200. The window is a few milliseconds of one request and closing it would
  // need a tombstone that refuses writes for the scope — machinery with its own
  // failure modes, for a race only the user themselves can lose, and only by
  // acting in two places at once. Named rather than fixed, so the next person
  // to consider a tombstone knows this was weighed.
  await appendMemoryDeletion(uid, at, held, 'memory_deleted_all');
  return held;
}

/**
 * The audit line carries a count and nothing else — never the id, and never a
 * word of what the record said. #167 asks for "the id only"; a count is
 * strictly less, and the id is of no use once the record it names is gone.
 */
async function appendMemoryDeletion(uid: string, at: string, removed: number, reasonCode: string): Promise<void> {
  await appendAudit(createPilotAuditEvent({
    version: 'v1',
    eventType: 'memory_deleted',
    participantId: uid,
    occurredAt: at,
    outcome: 'recorded',
    reasonCode: `${reasonCode}_${removed}`,
  }));
}

async function deleteChain(
  store: RuntimeMemoryStore,
  uid: string,
  record: RuntimeMemoryRecord,
): Promise<{ removed: number; ruleFingerprints: string[] }> {
  const seen = new Set<string>();
  const queue: RuntimeMemoryRecord[] = [record];
  const chain: RuntimeMemoryRecord[] = [];

  while (queue.length > 0) {
    const current = queue.pop()!;
    if (seen.has(current.id)) continue;
    seen.add(current.id);
    // A link that somehow points out of the scope is followed no further. It
    // cannot happen through `supersede`, which refuses to cross scopes, and if
    // it ever did this must not become a way to delete somebody else's record.
    if (current.scopeId !== uid) continue;
    chain.push(current);
    for (const neighbour of [current.supersedesId, current.supersededById]) {
      if (!neighbour || seen.has(neighbour)) continue;
      const next = await store.get(neighbour);
      if (next) queue.push(next);
    }
  }

  let removed = 0;
  const ruleFingerprints: string[] = [];
  for (const entry of chain) {
    if (await store.deleteById(entry.id)) removed += 1;
    const ref = entry.provenance?.origin === 'behaviour_rule' ? entry.provenance.originRef : undefined;
    if (ref && !ruleFingerprints.includes(ref)) ruleFingerprints.push(ref);
  }
  return { removed, ruleFingerprints };
}

/**
 * The record, if it is this account's. Otherwise the same `MemoryNotFoundError`
 * an unknown id gets — see the header on why the two answers are identical.
 */
async function requireOwnedRecord(
  store: RuntimeMemoryStore,
  uid: string,
  id: string,
  options: { allowSuperseded?: boolean } = {},
): Promise<RuntimeMemoryRecord> {
  const record = typeof id === 'string' ? await store.get(id) : null;
  if (!record || record.scopeId !== uid) throw new MemoryNotFoundError();
  // Editing a record that has already been replaced would fork the chain, and
  // the store refuses it anyway; refusing here makes it a 404 rather than a 500.
  if (!options.allowSuperseded && record.status !== 'active') throw new MemoryNotFoundError();
  return record;
}

function requireManualKind(value: unknown): RuntimeMemoryKind {
  if (typeof value !== 'string' || !MANUAL_MEMORY_KINDS.includes(value as RuntimeMemoryKind)) {
    throw new MemoryValidationError(`kind must be one of ${MANUAL_MEMORY_KINDS.join(', ')}`);
  }
  return value as RuntimeMemoryKind;
}

function requireLanguage(value: unknown): MemoryLanguage {
  if (typeof value !== 'string' || !MEMORY_LANGUAGES.includes(value as MemoryLanguage)) {
    throw new MemoryValidationError(`language must be one of ${MEMORY_LANGUAGES.join(', ')}`);
  }
  return value as MemoryLanguage;
}

function requireContent(value: unknown): string {
  if (typeof value !== 'string') throw new MemoryValidationError('content must be a string');
  const trimmed = value.trim();
  if (trimmed === '') throw new MemoryValidationError('content must not be empty');
  // Code points, not UTF-16 units, so an emoji or a rare glyph does not eat two
  // of the user's 200 characters. `Array.from` rather than spread: the
  // repository's TS target does not down-level string iteration.
  if (Array.from(trimmed).length > MAX_MEMORY_CONTENT_LENGTH) {
    throw new MemoryValidationError(`content must be at most ${MAX_MEMORY_CONTENT_LENGTH} characters`);
  }
  return trimmed;
}

function stripUndefined(provenance: MemoryProvenance): MemoryProvenance {
  const entries = Object.entries(provenance).filter(([, value]) => value !== undefined);
  return Object.fromEntries(entries) as unknown as MemoryProvenance;
}
