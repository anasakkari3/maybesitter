import { createHash, randomUUID } from 'crypto';
import { extractWithFallback, recurrenceHintOf, type ExtractAndMapOptions, type ExtractWithFallbackResult } from '../../../src/extraction/extractionService';
import { buildBatchPrompt } from '../../../src/extraction/ollamaExtractor';
import { CAPTURE_BATCH_TIMEOUT_MS, CAPTURE_MIN_CALL_TIMEOUT_MS, LLMUnavailableError, RETRY_BACKOFF_MAX_MS } from '../../../src/extraction/llm/llmProvider';
import { decideExtractionDisposition } from '../../../src/extraction/extractionPolicy';
import { mapExtractionToCommand } from '../../../src/extraction/mapExtractionToCommand';
import { countTimeExpressions } from '../../../src/extraction/ruleBasedExtractor';
import { classifyMessageKind } from '../../../src/extraction/messageKind';
import { hasActionEvidence, hasRequestEvidence, splitCaptureClauseDetails, type CaptureClause } from '../../../src/extraction/clauseSplitter';
import { CLOCK_PATTERN_SOURCES, instantFromLocal, isBareEarlyHourAnswer, localTimeSpecFor, namesDay, normalizeClockText, readClockRange, statedClockHours } from '../../../src/extraction/timeLexicon';
import { namesExplicitDate, readWeekdayReference } from '../../../src/extraction/weekdayLexicon';
import type { ExtractionContext, ExtractionResult } from '../../../src/extraction/extractionTypes';
import { resolveModuleRuntime, type AuditEventEnvelope, createAuditEvent, type RuntimeControlSnapshot } from '../../../src/contracts/v1/runtimeControls';
import {
  CAPTURE_CONTRACT_VERSION,
  CAPTURE_INPUT_MAX_CHARACTERS,
  CAPTURE_PROPOSAL_TTL_MS,
  type CaptureConfirmationResultContract,
  type CaptureItemEditContract,
  type CaptureProposalContract,
  type NoCommitmentReason,
} from '../../../src/contracts/v1/captureContracts';
import { detectUnresolvedIntent } from '../../../src/extraction/unresolvedIntent';
import type { CaptureSeedProposalContract } from '../../../src/contracts/v1/intentContracts';
import { applyEditToCommands, InvalidEditError, keepEventOnItsDay, validateEdit } from './applyEdits';
import { buildClarification } from './clarificationBuilder';
import { dateIsGuess, hourIsPartOfDayGuess } from './timeGuess';
import { isPastReading } from '../commitments/timeRules';
import { NegatedRequestError, PastCommitmentTimeError } from '../mobile/safety';
import { readCategoryPreferences } from '../categories/categoryPreferences';
import type { Command } from '../../../src/domain/stateMachine';
import type { CapturePersistenceAdapter } from './persistenceAdapter';
import type { CaptureProposalStore, StoredCaptureProposal } from './proposalStore';
import { storageFailureCause } from '../../storage/storageAdapter';
import { withWeeklyBlockOffers } from '../../weeklyBlocks/offer';
import {
  alignToPrevious,
  chatEvidenceFrom,
  chatItemEvidence,
  withInstantFromWallClock,
  withoutUnsaidTime,
  withPreviousTitles,
  type ChatPreviousItem,
} from './chatEvidence';
import { WEEKLY_BLOCK_TITLE_MAX, type WeeklyBlockOfferContract } from '../../../src/contracts/v1/weeklyBlockContracts';

/**
 * Persists a confirmation's commands and records its result on the proposal in
 * one transaction (UC-1.4, #148).
 *
 * Without it, confirming is read-then-write across two calls: two confirms of
 * the same proposal arriving together both see "not confirmed", both persist,
 * and one tap becomes two sets of commitments. The committer closes that by
 * making the claim part of the same write.
 *
 * Optional only for callers with no participant-scoped storage — the in-process
 * development path. Every authenticated request supplies one.
 */
export type CaptureConfirmationCommitter = (input: {
  scopeId: string;
  proposalId: string;
  idempotencyKey: string;
  commands: readonly Command[];
  /**
   * The commands this confirm committed, per item — what the proposal must
   * hold afterwards so the commitment can still be found (#480). Written in
   * the same transaction as the result, because a confirm that recorded one
   * without the other is the split this exists to prevent.
   */
  commandsByItemId: ReadonlyMap<string, readonly Command[]>;
  result: CaptureConfirmationResultContract;
  /**
   * The items confirmed as weekly blocks («ثابت أسبوعي»), each with the offer
   * as confirmed (a title edit applied). Written in the same transaction as
   * the claim, so a replayed or racing confirm creates no second block.
   */
  weeklyBlocks: ReadonlyArray<{ itemId: string; offer: WeeklyBlockOfferContract }>;
}) => Promise<{ replayed: boolean; result: CaptureConfirmationResultContract }>;

export interface CaptureBoundaryDependencies {
  store: CaptureProposalStore;
  persistence: CapturePersistenceAdapter;
  commitConfirmation?: CaptureConfirmationCommitter;
  audit?: (event: AuditEventEnvelope) => void;
  controls?: RuntimeControlSnapshot;
  llmProvider?: ExtractAndMapOptions['llmProvider'];
  /** Which engine `llmProvider` is, so provenance names it (UC-2.0, #160). */
  llmEngine?: ExtractAndMapOptions['llmEngine'];
  extractor?: typeof extractWithFallback;
  /**
   * The server clock the capture's model budget is measured on, in ms
   * (CL1 round 4, N3). Injected only so a test can run the budget without
   * waiting; production reads `Date.now`.
   */
  clock?: () => number;
}

export interface ProposeCaptureOptions {
  now: Date;
  timezone: string;
  scopeId: string;
  requestedEngine?: 'model' | 'rules';
  /**
   * When the request this capture answers began, on `dependencies.clock`
   * (CL1 round 6, M-b). The 12 s budget runs from here, so the auth check
   * and the consent read that came before `proposeCapture` count against
   * it; absent, the budget starts when this function does.
   */
  requestStartedAt?: number;
  /**
   * The capture chat's turn (owner decision 2026-09-30). Present, the model has
   * already answered — once, for the whole conversation — and `items` are its
   * extraction objects: each is read through the same extractor, validator and
   * guards a capture's clause is, against the person's turns together
   * (`chatEvidenceFrom`) rather than against one clause. `rawInput` is then
   * the newest message: the length cap and the multi-time valve read it.
   */
  chat?: {
    userTurns: readonly string[];
    items: readonly unknown[];
    /** The list the person saw before this message, on their clock, in order (chat UAT round 2). */
    previous?: readonly ChatPreviousItem[];
  };
}

/**
 * The most items one chat turn may propose: the most clauses one capture may
 * send to the model (`MAX_MODEL_SEGMENTS`). Past it, the rest are dropped.
 */
export const MAX_CHAT_ITEMS = 8;

/** Why one chat item carries nothing: the model's object failed validation. */
class ChatItemInvalidError extends LLMUnavailableError {
  constructor() {
    super('chat_item_invalid');
    this.name = 'ChatItemInvalidError';
  }
}

/**
 * A provider that answers with one of the model's chat items, once. The
 * extractor's repair call — the object failed validation — is refused, so an
 * invalid item is dropped rather than asked again or re-read by the rules.
 */
function chatItemProvider(item: unknown): ProviderFunction {
  let served = false;
  return async () => {
    if (served) throw new ChatItemInvalidError();
    served = true;
    return JSON.stringify(item ?? null);
  };
}

const INJECTION = /(?:ignore|disregard|override).{0,40}(?:instruction|system|policy)|(?:system|developer)\s*:/i;

/**
 * How many segments of one capture may reach the model.
 *
 * Eight. Beyond that the marginal segment is almost always a list item the rule
 * based extractor reads just as well, and the cost is per call — still under
 * the per-user daily call cap (`usageGuard.ts`), which is what bounds spend.
 *
 * It was five, and the first phone run's capture named six commitments once
 * its sentences were split (CL1): the sixth went to the rules, which titled it
 * «أخلص تقرير الشغل قبل», and relabelled the whole proposal `rule-based` with
 * `fallbackUsed` — a spoken day's list is routinely six.
 */
const MAX_MODEL_SEGMENTS = 8;

/** Refuses at once, so the extraction service answers with the rules. */
const RULES_ONLY_PROVIDER = async (): Promise<string> => { throw new Error('rules-only runtime'); };

/** What reading one clause came to, before the proposal is assembled. */
type ClauseOutcome =
  | { kind: 'seed' }
  | { kind: 'extracted'; extracted: ExtractWithFallbackResult }
  | { kind: 'error'; error: unknown };

/**
 * Calls one capture may make to the model: its batches, and the repairs and
 * re-asks after them (CL1 review, I4; round 4, N2).
 *
 * Five. An ordinary capture makes one call per three clauses — two for six,
 * three for eight. The rest is for a batch that came back misaligned, whose
 * clauses are re-asked one by one (a chunk of three on top of two batches is
 * five). The per-user minute cap is eight, which still leaves room for a
 * typed clarification and a second capture in the same minute.
 */
export const MAX_MODEL_CALLS_PER_CAPTURE = 5;

/**
 * Server time one capture may spend waiting on the model (CL1 round 4, N3).
 *
 * The phone gives up at 15 s (`mobile/src/api/client.ts`); twelve leaves
 * three for the network, storage and the rules. No call is started unless it
 * can end inside the budget at its worst — its deadline twice (the provider
 * retries a timeout once) plus the back-off between the two.
 */
export const CAPTURE_SERVER_BUDGET_MS = 12_000;
export { RETRY_BACKOFF_MAX_MS };

/** The shortest deadline worth giving a call: `CAPTURE_MIN_CALL_TIMEOUT_MS`. */
const MIN_CALL_TIMEOUT_MS = CAPTURE_MIN_CALL_TIMEOUT_MS;

/**
 * Clauses per model call; the calls of one capture run at the same time.
 *
 * Three, measured live against gemini-2.5-flash in europe-west1 on the UAT's
 * six-clause capture (CL1 round 2): one call of six took 4.7–6.3 s, two calls
 * of three 3.3–4.6 s. With `MAX_MODEL_SEGMENTS` at eight, a capture makes at
 * most three batch calls. `MAYBESITTER_CAPTURE_CLAUSES_PER_CALL` overrides it
 * for measurement.
 */
export const MAX_CLAUSES_PER_CALL = Number.parseInt(process.env.MAYBESITTER_CAPTURE_CLAUSES_PER_CALL ?? '', 10) || 3;

type ProviderFunction = NonNullable<ExtractAndMapOptions['llmProvider']>;

/**
 * `total` clauses in calls of at most `max`, as even as they go: seven are
 * 3, 2 and 2 — never 3, 3 and a lone 1 (CL1 round 4, N3).
 */
export function chunkSizes(total: number, max: number): number[] {
  if (total <= 0) return [];
  const count = Math.ceil(total / Math.max(1, max));
  const base = Math.floor(total / count);
  return Array.from({ length: count }, (_, index) => base + (index < total % count ? 1 : 0));
}

/**
 * A batch answer's objects, but only when each one says it reads the clause
 * at its own position (CL1 round 4, N2): exactly `size` objects, and object
 * *i* carrying `clauseIndex: i`. Anything else — a clause answered twice, one
 * skipped, the answers reordered, an index missing — is null, and none of the
 * chunk's objects is used: paired by position alone, a model that split one
 * clause in two silently dropped the last commitment and gave its neighbours
 * each other's day, anchor and priority.
 *
 * The echo is checked against the clause's content too (round 6, M-a; round
 * 7, I-2). A model that numbers its objects by their place rather than by the
 * clause they read satisfies the index check by construction. What gives a
 * displaced object away is the swap signature (`swapped`): its hour is one
 * a sibling clause states and its own does not, or it has no hour where its
 * clause states one and a sibling object carries that hour. A correct answer
 * that reads a range, «إلا ربع», a reminder lead or an early arrival differs
 * from its clause's stated hour without matching a sibling's, and is kept.
 */
function alignedItems(text: string, clauses: readonly string[], timezone: string): Record<string, unknown>[] | null {
  const size = clauses.length;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const items = (parsed as { items?: unknown } | null)?.items;
  if (!Array.isArray(items) || items.length !== size) return null;
  const aligned: Record<string, unknown>[] = [];
  for (let position = 0; position < size; position += 1) {
    const item = items[position] as unknown;
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const { clauseIndex, ...extraction } = item as Record<string, unknown>;
    if (clauseIndex !== position) return null;
    aligned.push(extraction);
  }
  if (swapped(aligned, clauses, timezone)) return null;
  return aligned;
}

/**
 * Whether some object of a chunk reads a sibling's clause (CL1 round 7,
 * I-2). Hours compare modulo twelve, since «الساعة 5» is 17:00 as often as
 * 05:00. A clause that states no clock time constrains nothing of its own.
 */
function swapped(objects: readonly Record<string, unknown>[], clauses: readonly string[], timezone: string): boolean {
  const stated = clauses.map((clause) => statedClockHours(clause));
  const hours = objects.map((object) => objectHour(object, timezone));
  return hours.some((hour, index) => {
    const own = stated[index]!;
    if (hour !== null) {
      // An hour that is a sibling's and not its own.
      return !own.has(hour) && stated.some((other, at) => at !== index && other.has(hour));
    }
    // No hour, where the clause states one and a sibling object carries it.
    return own.size > 0 && hours.some((other, at) => at !== index && other !== null && own.has(other));
  });
}

/** The object's local clock hour modulo twelve, or null when it has none. */
function objectHour(extraction: Record<string, unknown>, timezone: string): number | null {
  const spec = extraction['localTimeSpec'] as { time?: unknown } | null | undefined;
  let time = typeof spec?.time === 'string' ? spec.time : null;
  if (!time) {
    const iso = [extraction['remindAt'], extraction['dueAt']].find((value): value is string => typeof value === 'string');
    if (!iso) return null;
    const instant = new Date(iso);
    if (Number.isNaN(instant.getTime())) return null;
    time = localTimeSpecFor(instant, timezone)?.time ?? null;
  }
  const hour = time ? Number.parseInt(time.slice(0, 2), 10) : NaN;
  return Number.isFinite(hour) ? hour % 12 : null;
}

/**
 * One model call for every three clauses of a capture (CL1 review, I4).
 *
 * Each clause runs the ordinary extractor with its own provider from
 * `providerFor`. The first time a clause's extractor asks the model, it is
 * held until every clause expected to reach the model has either asked too or
 * finished without asking (the injection screen, the negation guard) — then
 * the clauses that asked go to the model together, in calls of at most
 * `MAX_CLAUSES_PER_CALL` sent at the same time, and each gets back its own
 * object, which its extractor validates against its own text exactly as a
 * single answer is.
 *
 * A batch answer is used only when every object echoes the clause it reads
 * (`alignedItems`). When it does not, that chunk's clauses are asked again one
 * by one; a clause the budget has no room for falls back to the rules like any
 * other model failure, and the boundary then keeps it only on evidence that it
 * asks for something (round 4, N2 and N4).
 *
 * Every call — first round, re-ask, the extractor's repair — goes out with the
 * deadline the time budget can still afford (`callTimeout`), and none goes out
 * past `MAX_MODEL_CALLS_PER_CAPTURE` (round 4, N3).
 */
function createClauseBatch(
  inner: ProviderFunction,
  clauses: readonly string[],
  expected: readonly number[],
  context: ExtractionContext,
  budget: { startedAt: number; clock: () => number },
) {
  type Waiter = { prompt: string; resolve: (text: string) => void; reject: (error: unknown) => void };
  const waiting = new Map<number, Waiter>();
  const finished = new Set<number>();
  const asked = new Set<number>();
  let fired = false;
  let calls = 0;

  /** The deadline a call started now may have, or null when none fits. */
  function callTimeout(): number | null {
    const remaining = CAPTURE_SERVER_BUDGET_MS - (budget.clock() - budget.startedAt);
    const timeout = Math.min(CAPTURE_BATCH_TIMEOUT_MS, Math.floor((remaining - RETRY_BACKOFF_MAX_MS) / 2));
    return timeout >= MIN_CALL_TIMEOUT_MS ? timeout : null;
  }

  /** One call, if the capture's call and time budgets both still allow it. */
  function send(prompt: string, shape: 'single' | 'batch'): Promise<string> {
    if (calls >= MAX_MODEL_CALLS_PER_CAPTURE) return Promise.reject(new LLMUnavailableError('capture_call_budget'));
    const timeoutMs = callTimeout();
    if (timeoutMs === null) return Promise.reject(new LLMUnavailableError('capture_time_budget'));
    calls += 1;
    return inner(prompt, shape === 'batch' ? { shape, timeoutMs } : { timeoutMs });
  }

  function fire(): void {
    if (fired) return;
    if (!expected.every((index) => waiting.has(index) || finished.has(index))) return;
    fired = true;
    const entries = Array.from(waiting.entries()).sort(([a], [b]) => a - b);
    let start = 0;
    for (const size of chunkSizes(entries.length, MAX_CLAUSES_PER_CALL)) {
      const chunk = entries.slice(start, start + size);
      start += size;
      if (chunk.length === 1) {
        const [, only] = chunk[0]!;
        send(only.prompt, 'single').then(only.resolve, only.reject);
        continue;
      }
      send(buildBatchPrompt(chunk.map(([index]) => clauses[index]!), context), 'batch').then(
        (text) => {
          const items = alignedItems(text, chunk.map(([index]) => clauses[index] ?? ''), context.timezone ?? 'UTC');
          if (items) {
            chunk.forEach(([, waiter], position) => waiter.resolve(JSON.stringify(items[position])));
            return;
          }
          // Misaligned: re-asked clause by clause, each with its own prompt.
          for (const [, waiter] of chunk) send(waiter.prompt, 'single').then(waiter.resolve, waiter.reject);
        },
        (error) => chunk.forEach(([, waiter]) => waiter.reject(error)),
      );
    }
  }

  return {
    providerFor(index: number): ProviderFunction {
      return (prompt: string) => {
        // A second ask from the same clause is the extractor's repair.
        if (asked.has(index) || fired) return send(prompt, 'single');
        asked.add(index);
        return new Promise<string>((resolve, reject) => {
          waiting.set(index, { prompt, resolve, reject });
          fire();
        });
      };
    },
    /** This clause's extractor is done, whether or not it asked. */
    settle(index: number): void {
      finished.add(index);
      fire();
    },
  };
}

/**
 * The capture is longer than the server will read (#508).
 *
 * Refused, never truncated. Truncating would drop the end of somebody's
 * sentence and then answer as though it had read the whole thing — and the end
 * of a capture is where the time usually is.
 *
 * `maxCharacters` is on the error because the route puts it in the 413 body,
 * which is the shape `mobile/src/api/client.ts` already parses into
 * `InputTooLargeError`.
 */
export class CaptureInputTooLargeError extends Error {
  constructor(readonly maxCharacters: number = CAPTURE_INPUT_MAX_CHARACTERS) {
    super(`a capture may be at most ${maxCharacters} characters`);
    this.name = 'CaptureInputTooLargeError';
  }
}

/** The clauses of one capture, with how each was cut: `src/extraction/clauseSplitter.ts`. */
const splitInput = splitCaptureClauseDetails;

/**
 * The second of «…الأول يوم الجمعة عال ٤ والثاني الحنعة عال٦» (FIX-R8-
 * CAPTURE): a day this conjunct does not state itself is not its day. The
 * rules put its clock on today, a model may take the first conjunct's Friday
 * or read the mistyped word as one; either is a day nobody said. The hour is
 * kept (`undatedTime`) and the day is asked. The word that stood where the
 * first conjunct had its day leaves the title: the question asks for it.
 */
function withConjunctOwnDay(result: ExtractionResult, clause: CaptureClause, timezone: string): ExtractionResult {
  if (!clause.elliptical) return result;
  let next = result;
  if (clause.unreadDayWord && next.title) {
    const word = clause.unreadDayWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const title = next.title.replace(new RegExp(`(^|\\s)${word}(?=\\s|$)`, 'u'), ' ').replace(/\s+/g, ' ').trim();
    if (title.length >= 3) next = { ...next, title, ...(next.action === next.title ? { action: title } : {}) };
  }
  if (namesDay(clause.text) || readWeekdayReference(clause.text) || namesExplicitDate(clause.text)) return next;
  const instant = next.remindAt ?? next.dueAt;
  const time = next.allDay
    ? null
    : next.localTimeSpec?.time ?? (instant ? localTimeSpecFor(new Date(Date.parse(instant)), timezone)?.time ?? null : null) ?? next.undatedTime ?? null;
  if (!next.localTimeSpec && !instant) return next;
  return {
    ...next,
    dueAt: null,
    remindAt: null,
    localTimeSpec: null,
    dateInferred: false,
    allDay: false,
    ...(time ? { undatedTime: time } : {}),
    missingFields: next.missingFields.includes('time') ? next.missingFields : [...next.missingFields, 'time'],
  };
}

/**
 * Why this segment produced nothing, or why it is being refused (UC-2.6, #166).
 *
 * `no_commitment` is not a failure. It means the message asked for nothing, and
 * the right answer is to say so and create nothing — which is a different thing
 * from `rejected`, and used to be flattened into it.
 *
 * `store_note` is included here because a capture the policy would only file as
 * a note is, from the user's side, a capture that created no commitment. Leaving
 * it out was Gap A: a low-confidence greeting became a proposed item with the
 * greeting as its title.
 *
 * An injection and a past time stay `rejected`. Those are unsafe rather than
 * empty, and telling somebody "nothing to save here" about a prompt injection
 * would be the wrong answer to the wrong question.
 */
function semanticFailure(result: ExtractionResult, now: Date): string | null {
  if (result.type === 'unknown' || result.type === 'informational_context') return 'no_commitment';
  // Gap A: the disposition policy would only file this as a note, so there is no
  // commitment in it however confident the extractor was about the sentence.
  if (decideExtractionDisposition(result) === 'store_note') return 'no_commitment';
  // Before the title (CL1 review, I2): a multi-clause capture skips a clause
  // with no usable title, and an injection whose model answer had a short or
  // null title was skipped with it instead of rejecting the capture.
  if (INJECTION.test(result.rawText)) return 'prompt_injection';
  const title = (result.title || result.action || '').trim();
  if (title.length < 3) return 'missing_title';
  // Same rule as the capture edits and the mobile PATCH, asked in one place
  // (#352); only the answer differs, because a refusal here is a reason code
  // on a proposal rather than an error. An all-day deadline is judged by its
  // day (FX3): due today is not past.
  if (isPastReading(result, now)) return 'past_time';
  return null;
}

/**
 * The same reading with the hour that has already gone taken off (CL1, round
 * 1). The day is kept when it is today or later — «اليوم» is still what the
 * user said — so the clarification asks "what time today?".
 *
 * A bare early hour keeps its clock (round 7, I-3): «الساعة 5» at 10:00 read
 * as 05:00 has passed only in the morning reading, and the question to ask
 * is صبح or مسا — `buildClarification` offers the halves still ahead, so
 * only the afternoon is left. Consistent with rounds 1 and 3: a passed hour
 * is asked about, never swapped for a later reading picked for the user.
 */
function withoutPastTime(result: ExtractionResult, now: Date, timezone: string): ExtractionResult {
  const today = localTimeSpecFor(now, timezone)?.date ?? null;
  const date = result.localTimeSpec?.date ?? null;
  const keptClock = isBareEarlyHour(result) && date && today && date >= today ? result.localTimeSpec!.time : null;
  return {
    ...result,
    dueAt: null,
    remindAt: null,
    localTimeSpec: date && today && date >= today ? { date, time: keptClock, timezone } : null,
    // Kept: the hour is gone, not what it was. An «الساعة 9» re-asked is
    // still a time to be at once a new hour is picked (CL1 review, I1).
    missingFields: result.missingFields.includes('time') ? result.missingFields : [...result.missingFields, 'time'],
  };
}

/**
 * The reason code a no-commitment proposal carries.
 *
 * Taken from `classifyMessageKind` on the same text the extractor read, rather
 * than re-derived from the ambiguity flags. The flags cannot carry this: a
 * question and a greeting both arrive with `no_action_verb`, so deriving from
 * them told somebody who asked «شو الطقس بكرا؟» that their question was small
 * talk.
 *
 * The flags are still the fallback, for the cases the classifier calls a request
 * and the extractor then declined for its own reasons — a real ask it could not
 * read well enough to propose anything for. `low_confidence` is the honest answer
 * there.
 */
function noCommitmentReasonFrom(
  segment: string,
  result: ExtractionResult,
  fallbackReason: string | null,
): NoCommitmentReason {
  const kind = classifyMessageKind(segment);
  if (kind !== 'request') return kind;
  if (result.ambiguityFlags.includes('negated_request')) return 'negated_request';
  if (fallbackReason?.startsWith('semantic_safety:past_no_action')) return 'past_event';
  if (result.ambiguityFlags.includes('informational_without_action')) return 'informational';
  return 'low_confidence';
}

/**
 * A clock time the rules read with no meridiem, in the hours where the
 * morning reading is the unlikely one (CL1 round 6): «الساعة 5», "at 5",
 * «ב-5» — one to six, and the sentence named no part of the day.
 */
function isBareEarlyHour(result: ExtractionResult): boolean {
  if (result.timeEvidence !== 'clock_marker') return false;
  const time = result.localTimeSpec?.time;
  if (!time) return false;
  const hour = Number.parseInt(time.slice(0, 2), 10);
  return hour >= 1 && hour <= 6;
}

/**
 * The one bare early clock the clause states — «الساعة 5» is `05:00`, "at
 * 4:30" is `04:30`, «ב-5» is `05:00` — or null (UAT round 6, D1). One to six,
 * no part of the day, no meridiem, and a single hour: the words the rules
 * read as the morning and ask صبح or مسا about.
 */
function statedBareEarlyClock(text: string): string | null {
  if (!isBareEarlyHourAnswer(text)) return null;
  const normalized = normalizeClockText(text);
  const clocks = new Set<string>();
  for (const source of CLOCK_PATTERN_SOURCES) {
    for (const match of Array.from(normalized.matchAll(new RegExp(source, 'gi')))) {
      const digits = /(\d{1,2})(?::(\d{2}))?/.exec(match[0]);
      if (digits) clocks.add(`${digits[1]!.padStart(2, '0')}:${digits[2] ?? '00'}`);
    }
  }
  // A range is one clock, its start (FIX-R8-CAPTURE): «من 2 لـ 4» is a bare 2
  // whose end follows it, whatever the patterns above found inside it.
  const range = readClockRange(text);
  if (range) return `${String(range.start.hour).padStart(2, '0')}:${String(range.start.minute).padStart(2, '0')}`;
  // Two hours («الساعة 5 أو 6») are not one to put a question on.
  return clocks.size === 1 ? Array.from(clocks)[0]! : null;
}

/**
 * A model reading of a bare early hour, put on the number the person said
 * (UAT round 6, D1). «بكرا الساعة 5 لازم أروح عالبنك» came back from Gemini
 * as 17:00 — or 05:00, or no hour — and one run in four was proposed,
 * settled, at a half of the day nobody said. The rules read the same words
 * as the morning and ask صبح or مسا (CL1 round 6); this gives the model's
 * reading the same clock, so the same question follows. The day is the
 * reading's own, never filled or moved: with no day there is nothing to put
 * the hour on, and the reading is left as it is.
 */
function withStatedBareEarlyClock(result: ExtractionResult, clock: string, timezone: string): ExtractionResult {
  const date = result.localTimeSpec?.date;
  const stated = date ? instantFromLocal(date, clock, timezone)?.toISOString() : undefined;
  if (!date || !stated) return result;
  return {
    ...result,
    dueAt: result.dueAt || !result.remindAt ? stated : null,
    remindAt: result.remindAt ? stated : null,
    localTimeSpec: { date, time: clock, timezone },
    missingFields: result.missingFields.filter((field) => field !== 'time'),
  };
}

function auditEvent(outcome: 'succeeded' | 'rejected' | 'failed' | 'fell_back', raw: string, now: Date, reasonCode?: string, itemCount?: number): AuditEventEnvelope {
  return createAuditEvent({
    eventId: randomUUID(),
    eventType: 'module_execution',
    occurredAt: now.toISOString(),
    correlationId: randomUUID(),
    module: 'capture',
    fields: {
      outcome,
      reasonCode,
      itemCount,
      inputHash: createHash('sha256').update(raw).digest('hex'),
      inputLength: raw.length,
    },
  });
}

export async function proposeCapture(rawInput: unknown, options: ProposeCaptureOptions, dependencies: CaptureBoundaryDependencies): Promise<CaptureProposalContract> {
  const raw = typeof rawInput === 'string' ? rawInput.trim() : '';
  /*
   * The server's length boundary, and the only one (#508).
   *
   * Here rather than in a route because this is the lowest point every way in
   * shares: the typed capture reaches it through `proposeMobileCapture`, and so
   * does a share (lib/services/share/shareIntakeService.ts:398). A route-level
   * check would be one more thing the next route has to remember.
   *
   * First statement in the function, before `readCategoryPreferences` reads
   * storage, before `splitInput` runs its regexes, and before a single segment
   * is offered to the extractor or to a model.
   */
  if (raw.length > CAPTURE_INPUT_MAX_CHARACTERS) throw new CaptureInputTooLargeError();
  const clock = dependencies.clock ?? Date.now;
  // The budget runs from the request, not from here (CL1 round 6, M-b): the
  // route's auth check and the consent read before this call are server time
  // the phone is already waiting on.
  const startedAt = options.requestStartedAt ?? clock();
  const requestedEngine = options.requestedEngine ?? 'model';
  const runtime = resolveModuleRuntime('capture', dependencies.controls);
  const forceRules = requestedEngine === 'rules' || runtime.mode === 'rules_only';
  const extractor = dependencies.extractor ?? extractWithFallback;
  // The scope *is* the authenticated uid, so the categories this account uses
  // are readable here. Read once for the whole capture rather than per segment:
  // a paste that splits into five segments must not file its five commitments
  // against five different reads of the same preference (#415).
  const categoryPreferences = await readCategoryPreferences(options.scopeId);
  // The same list reaches the prompt and the gate. Two lists would let the
  // model be asked for a category the gate then silently discards.
  const context: ExtractionContext = {
    now: options.now,
    timezone: options.timezone,
    categories: categoryPreferences.enabled,
  };
  const proposalId = randomUUID();
  const commandsByItemId = new Map<string, readonly ReturnType<typeof mapExtractionToCommand>[number][]>();
  // Kept so one clarification can be answered against the extraction the item
  // came from, rather than by patching its contract (#165).
  const resultsByItemId = new Map<string, ExtractionResult>();
  const items: CaptureProposalContract['items'] = [];
  /**
   * What the user may merely be considering or waiting on (#519).
   *
   * Nothing here is persisted by this call, and nothing here holds a command:
   * a seed proposal is a segment and a kind, and it becomes a stored Seed only
   * when the user picks it in Review and the app posts it to
   * `/api/mobile/seeds`.
   */
  const seeds: CaptureSeedProposalContract[] = [];
  let executedEngine: CaptureProposalContract['provenance']['executedEngine'] = 'rule-based';
  let fallbackUsed = forceRules;
  let rejected = !raw;
  // The reason the first empty segment gave, so a no-commitment proposal can say
  // which kind of message this was (#166). First rather than last: the opening of
  // a message is what it is about.
  let noCommitmentReason: NoCommitmentReason | null = null;
  // Clock times said in clauses that produced nothing (FY1 N1); see the valve.
  let timesReadAsNothing = 0;

  /*
   * The capture chat (owner decision 2026-09-30): one clause per model item,
   * each read against the person's words about it (`chatItemEvidence`): its
   * own clauses, and those naming no item in particular. The evidence is bounded
   * like a capture: the caller keeps the turns within the cap, and this
   * refuses anything longer, so no parser here reads more than a capture's.
   */
  const chat = options.chat;
  const chatEvidence = chat ? chatEvidenceFrom(chat.userTurns) : '';
  if (chat && chatEvidence.length > CAPTURE_INPUT_MAX_CHARACTERS) throw new CaptureInputTooLargeError();
  const chatPrevious = chat?.previous ?? [];
  // A title that is only the words of the edit keeps the one the item had; a
  // wall clock with no instant gets its instant (`chatEvidence`).
  const chatItems = chat && chatEvidence
    ? withPreviousTitles(chat.items.slice(0, MAX_CHAT_ITEMS), chatPrevious, raw).map((item) => withInstantFromWallClock(item, options.timezone))
    : [];
  // Each item against its own clauses and those naming no item
  // (`chatItemEvidence`): another item's day or hour is never its evidence.
  const chatItemEvidences = chat ? chatItemEvidence(chat.userTurns, chatItems, chatPrevious, options.timezone) : [];
  const chatAligned = alignToPrevious(chatItems, chatPrevious);
  const clauses: CaptureClause[] = chat
    ? chatItemEvidences.map((evidence) => evidence.clause)
    : raw ? splitInput(raw) : [];
  const segments = clauses.map((clause) => clause.text);
  const several = segments.length > 1;
  /*
   * Unresolved intent is read before the extractor, not after it (#519).
   *
   * After would be the tidier place — "whatever produced no commitment, look
   * at again" — and it is where three of the issue's six example sentences
   * would in fact land. The other three do not. «אולי אני אגיש מועמדות» and
   * "I'm waiting for the doctor to reply" are read by the rule-based
   * extractor as tasks whose time is missing, so they arrive as items
   * *needing clarification*: the product would answer somebody's "maybe" by
   * asking them what time their maybe is. That is the failure this issue
   * exists to remove, and it happens upstream of any no-commitment branch.
   *
   * The narrowing that makes this safe is in `detectUnresolvedIntent`: an
   * explicit scheduling verb anywhere in the segment means it is a request
   * and the detector declines, so «ممكن تذكرني بكرة الساعة ٩؟» stays the
   * reminder it obviously is.
   */
  // A chat item is the model's answer to the whole conversation, not a
  // clause: what the person may merely be considering is the capture's
  // question, asked of what they typed there.
  const intents = segments.map((segment) => (chat ? null : detectUnresolvedIntent(segment)));
  /*
   * An injection in any clause rejects the capture before a single clause is
   * read (CL1 round 4, N5). Checked only on the model's answer, a `system:`
   * clause the model filed as context was dropped quietly — and, batched, it
   * had already shared a prompt with up to two of the user's real clauses and
   * could steer their titles, times and priority. The same pattern, the same
   * `rejected` answer, now asked of the clause itself.
   */
  // A chat item reads only part of the conversation; the whole of it is screened.
  const injected = (several || Boolean(chat)) && (
    segments.some((segment) => INJECTION.test(segment)) || (chatItems.length > 0 && INJECTION.test(chatEvidence))
  );
  if (injected) rejected = true;

  /*
   * Phase one: every clause is read at once, and the clauses that reach the
   * model share one call (CL1 review, I4) — see `createClauseBatch`. One call
   * per clause, one after another, spent the per-user minute budget on a
   * single spoken list and ran a six-clause capture towards the phone's 15 s
   * timeout. Each clause still goes through the whole extractor on its own:
   * the injection screen, the negation guard and the past-time guard all run
   * per clause, and a clause they stop never reaches the model.
   *
   * Past `MAX_MODEL_SEGMENTS` the remaining clauses go through the rules
   * rather than being dropped: the user still gets their commitments, they
   * are just read without the model.
   */
  const modelIndices = segments
    .map((_, index) => index)
    .filter((index) => !intents[index] && !forceRules && index < MAX_MODEL_SEGMENTS);
  // A capture of one clause is read exactly as it always was: one prompt, the
  // provider's own deadline. Batching, and its budget, start at two.
  const batch = dependencies.llmProvider && !forceRules && several && !chat
    ? createClauseBatch(dependencies.llmProvider, segments, modelIndices, context, { startedAt, clock })
    : null;
  const outcomes = injected ? [] : await Promise.all(segments.map(async (segment, index): Promise<ClauseOutcome> => {
    if (intents[index]) return { kind: 'seed' };
    const rulesOnly = forceRules || index >= MAX_MODEL_SEGMENTS;
    try {
      const extracted = await extractor(segment, context, {
        // A rules-only runtime (the capture kill switch) never takes a model
        // item: each falls to the rules and is dropped below.
        llmProvider: chat
          ? forceRules ? RULES_ONLY_PROVIDER : chatItemProvider(chatItems[index])
          : rulesOnly ? RULES_ONLY_PROVIDER : batch ? batch.providerFor(index) : dependencies.llmProvider,
        llmEngine: dependencies.llmEngine,
      });
      return { kind: 'extracted', extracted };
    } catch (error) {
      return { kind: 'error', error };
    } finally {
      batch?.settle(index);
    }
  }));

  /*
   * Whether the model answered any clause of this capture (CL1 round 6,
   * NEW-1). When it answered none — the kill switch, a spent daily, global or
   * minute cap, the usage guard down, no provider configured, every chunk
   * timed out — the capture is read exactly as it is for a user without AI
   * consent: the rules, ungated. The evidence gate below is for a partial
   * failure only, where the model read some clauses and one chunk of the
   * same capture did not come back; gating a capture-wide refusal dropped
   * "rent due Friday", «فاتورة الكهربا قبل آخر الشهر» and «חשבון חשמל עד סוף
   * החודש» for consented users while the kill switch was on, with no sign.
   */
  const modelAnswered = outcomes.some((outcome, index) => {
    if (!modelIndices.includes(index)) return false;
    if (outcome.kind === 'extracted') return outcome.extracted.engine !== 'rule-based';
    return outcome.kind === 'error' && outcome.error instanceof PastCommitmentTimeError && outcome.error.extracted?.engine !== undefined && outcome.error.extracted.engine !== 'rule-based';
  });

  // Phase two: the answers, in the order the user said them.
  for (let index = 0; index < outcomes.length; index += 1) {
    const segment = segments[index]!;
    const outcome = outcomes[index]!;
    const intent = intents[index];
    if (intent || outcome.kind === 'seed') {
      if (intent) seeds.push({ seedItemId: randomUUID(), kind: intent.kind, summary: segment });
      continue;
    }
    try {
      let extracted: ExtractWithFallbackResult;
      // A rules reading standing in for one clause — a passed hour re-read, or
      // a clause recovered from a model "nothing" — does not relabel the
      // proposal: the model still read the capture (CL1 review, C2).
      let standIn = false;
      let passedHour = false;
      // A rules reading the evidence gate did not clear (round 6, NEW-1): kept
      // as a question, never dropped.
      let gated = false;
      if (outcome.kind === 'error') {
        // The guarded extractor refuses a time that has gone by with the
        // reading it refused (CL1 round 3, M5): past its negation check,
        // named by the engine that read it. That reading is offered without
        // its hour, below, and the user is asked for one — never a later
        // reading picked for them.
        //
        // Alone too (closure UAT round 2, FY1 N1). «اليوم الساعة 3 العصر لازم
        // أبعت الإيميل للمدير» at 18:08 was refused whole, and the phone said
        // «ما زبطت» about a commitment it had read perfectly well. The email
        // is still to be sent; which hour is the one thing to ask.
        const refused = outcome.error instanceof PastCommitmentTimeError ? outcome.error.extracted : undefined;
        if (!refused) throw outcome.error;
        extracted = refused;
        passedHour = true;
      } else {
        extracted = outcome.extracted;
      }
      // A model reading of a bare early hour takes the number the person said
      // (UAT round 6, D1), so it is asked as the rules reading is below.
      // In the chat, asked of the whole conversation, as it always was: one
      // bare early hour said anywhere is asked صبح or مسا; «الاول … عال ٤
      // والثاني … عال٦» — two hours, one per item — is not one to ask about.
      const statedEarlyClock = extracted.engine !== 'rule-based' ? statedBareEarlyClock(chat ? chatEvidence : segment) : null;
      if (statedEarlyClock) {
        extracted = { ...extracted, result: withStatedBareEarlyClock(extracted.result, statedEarlyClock, options.timezone) };
      }
      extracted = { ...extracted, result: withConjunctOwnDay(extracted.result, clauses[index]!, options.timezone) };
      /*
       * The capture chat. An item whose object failed validation fell back to
       * the rules on the whole conversation — a reading of every turn at
       * once, not of this item — so it is dropped. And whatever survives is
       * checked against what the person said: an hour, a minute or a day
       * nobody said is taken off and asked about (`withoutUnsaidTime`).
       */
      let unsaid = false;
      // A chat item whose question the person has not answered yet (below).
      let stillAsked = false;
      if (chat) {
        if (extracted.engine === 'rule-based' && !/^(?:prompt_injection|semantic_safety)/.test(extracted.fallbackReason ?? '')) continue;
        const evidence = chatItemEvidences[index]!;
        /*
         * An item the newest message is not about keeps the day and hour it
         * had (chat UAT round 2, real Gemini: «لا خلّي التانية الساعة 7» came
         * back with the FIRST engagement moved to 09:00, which the guard then
         * took off and asked about). Only a settled one, and only when the
         * model moved it: nothing the person said this turn is overridden.
         */
        const before = chatAligned[index] === null ? undefined : chatPrevious[chatAligned[index]!];
        if (!evidence.touchedNow && before?.date && before.time && !extracted.result.allDay) {
          const kept = instantFromLocal(before.date, before.time, options.timezone)?.toISOString();
          const spec = extracted.result.localTimeSpec;
          if (kept && (spec?.date !== before.date || spec?.time !== before.time)) {
            const { undatedTime: _undated, ...rest } = extracted.result;
            extracted = { ...extracted, result: {
              ...rest,
              dueAt: extracted.result.dueAt || !extracted.result.remindAt ? kept : null,
              remindAt: extracted.result.remindAt ? kept : null,
              localTimeSpec: { date: before.date, time: before.time, timezone: options.timezone },
              missingFields: extracted.result.missingFields.filter((field) => field !== 'time'),
            } };
          }
        }
        /*
         * The model gave no hour where the item's own words state one («من 10
         * لـ 4», "from 10 to 4", «الساعة 10 الصبح»): the rules read those words
         * as a capture does, and their hour — the person's — is put on the
         * item (chat UAT round 2: the owner's «عندي تدريب كل سبت من 10 لـ 4»
         * came back asking «أي ساعة؟»). Never a day the model did not give or
         * the rules did not read from the same words; the guard below still
         * checks what results.
         */
        /*
         * An item that was still being asked about keeps its question until a
         * message of the person's is about it (chat UAT round 3, staging: the
         * first message fell to the rules, which asked «الصبح ولا المسا؟» for
         * both engagements; «لا خلّي التانية الساعة 7» then went to the
         * model, which put the FIRST at 04:00 — the morning, picked for the
         * person). Its day and hour are read again from its own words by the
         * rules, as the question was built, and the question is asked again.
         */
        if (!evidence.touchedNow && before?.needsDayOrTime) {
          stillAsked = true;
          let read: ExtractWithFallbackResult | null = null;
          try {
            read = await extractor(segment, context, { llmProvider: RULES_ONLY_PROVIDER, llmEngine: dependencies.llmEngine });
          } catch (error) {
            read = error instanceof PastCommitmentTimeError && error.extracted ? error.extracted : null;
          }
          const rules = read?.result;
          const date = rules?.localTimeSpec?.date ?? extracted.result.localTimeSpec?.date ?? null;
          const { undatedTime: _undated, rangeMinutes: _range, ...rest } = extracted.result;
          extracted = { ...extracted, result: {
            ...rest,
            dueAt: rules?.dueAt ?? null,
            remindAt: rules?.remindAt ?? null,
            allDay: false,
            localTimeSpec: rules?.localTimeSpec ?? (date ? { date, time: null, timezone: options.timezone } : null),
            timeEvidence: rules?.timeEvidence ?? extracted.result.timeEvidence,
            ...(rules?.undatedTime ? { undatedTime: rules.undatedTime } : {}),
            ...(rules?.rangeMinutes ? { rangeMinutes: rules.rangeMinutes } : {}),
          } };
        }
        if (!stillAsked && !extracted.result.allDay && !extracted.result.localTimeSpec?.time && !extracted.result.dueAt && !extracted.result.remindAt) {
          let read: ExtractWithFallbackResult | null = null;
          try {
            read = await extractor(segment, context, { llmProvider: RULES_ONLY_PROVIDER, llmEngine: dependencies.llmEngine });
          } catch {
            read = null;
          }
          const rules = read?.result;
          const modelDate = extracted.result.localTimeSpec?.date ?? null;
          if (rules && !rules.allDay && rules.localTimeSpec?.time && rules.localTimeSpec.date
            && (rules.dueAt || rules.remindAt) && (modelDate === null || modelDate === rules.localTimeSpec.date)) {
            const { undatedTime: _undated, ...rest } = extracted.result;
            extracted = { ...extracted, result: {
              ...rest,
              dueAt: rules.dueAt,
              remindAt: rules.remindAt,
              localTimeSpec: rules.localTimeSpec,
              timeEvidence: rules.timeEvidence,
              ...(rules.rangeMinutes ? { rangeMinutes: rules.rangeMinutes } : {}),
              missingFields: extracted.result.missingFields.filter((field) => field !== 'time'),
              ambiguityFlags: extracted.result.ambiguityFlags.filter((flag) => flag !== 'vague_time'),
              confidence: { ...extracted.result.confidence, time: Math.max(extracted.result.confidence.time, rules.confidence.time) },
            } };
          }
        }
        const guarded = withoutUnsaidTime(extracted.result, evidence.turns, options.now, options.timezone);
        extracted = { ...extracted, result: guarded.result };
        unsaid = guarded.fired;
      }
      /*
       * The model read the capture but not this clause — its chunk timed out,
       * the budget ran out before its re-ask, or its answer could not be used
       * — so the rules read the clause instead (CL1 round 4, N2 and N4). In a
       * capture of several clauses that rules reading stands on its own only
       * on evidence that the clause asks for something: one timed-out call
       * used to turn "she is sick" into a confirmed item beside the two real
       * ones in its chunk. Without that evidence the reading is offered as a
       * question, never dropped (round 6, NEW-1): the user decides what it
       * was. When the model answered nothing at all, there is no partial
       * reading to protect and the rules stand as they do without consent
       * (`modelAnswered`). A capture of one clause is unchanged: what the
       * user typed alone is the request.
       */
      if (
        several
        && batch
        && modelAnswered
        && modelIndices.includes(index)
        && extracted.engine === 'rule-based'
        && extracted.fallbackReason
        && !/^(?:prompt_injection|semantic_safety)/.test(extracted.fallbackReason)
        && !hasActionEvidence(segment)
      ) {
        gated = true;
      }
      let failure = semanticFailure(extracted.result, options.now);
      /*
       * The model found nothing in a clause that plainly asks for something,
       * beside clauses that did produce items (CL1, D1). The rules read the
       * same clause instead; if they also find nothing, nothing is invented.
       *
       * Only on positive evidence of a request (CL1 review, C2): an explicit
       * request or obligation marker, or a commitment noun with a time. The
       * message classifier answers `request` for anything it does not
       * recognise, so gating on it turned the model's correct "nothing here"
       * for «بالمكتب» or "She is sick" into an item — against #166's
       * create-nothing contract. Without that evidence, the model wins.
       */
      if (
        failure === 'no_commitment'
        && several
        && !chat
        && extracted.engine !== 'rule-based'
        && hasRequestEvidence(segment)
      ) {
        /*
         * The stand-in reading is the guarded extractor's too, so it can
         * refuse. Uncaught, that refusal rejected the whole capture (closure
         * UAT round 2, FY1 N1): the model rightly read «اليوم الساعة 3 العصر
         * كان عندي اجتماع…» as nothing, the rules re-read it as a meeting at
         * 15:00, the guard threw at 18:08, and the room and the bank were lost
         * with it. A passed hour here is the same question as anywhere else;
         * any other refusal leaves the model's "nothing" standing.
         */
        let recovered: ExtractWithFallbackResult | null = null;
        let recoveredPassedHour = false;
        try {
          recovered = await extractor(segment, context, { llmProvider: RULES_ONLY_PROVIDER, llmEngine: dependencies.llmEngine });
        } catch (error) {
          if (error instanceof PastCommitmentTimeError && error.extracted) {
            recovered = error.extracted;
            recoveredPassedHour = true;
          }
        }
        const recoveredFailure = recovered ? semanticFailure(recovered.result, options.now) : 'no_commitment';
        if (recovered && (recoveredFailure === null || recoveredFailure === 'past_time')) {
          extracted = recovered;
          failure = recoveredFailure;
          passedHour ||= recoveredPassedHour;
          standIn = true;
        }
      }
      /*
       * One clause must not sink the others (CL1, round 1). «بدي أشتري خبز
       * بكرا، وذكرني أتصل بأمي اليوم الساعة 9 الصبح» sent at 10:00 was
       * `rejected` whole — the route answered 400 and the bread went with the
       * call.
       *
       *   past_time      the clause is kept without the hour that has gone,
       *                  as an item needing clarification, so the user picks
       *                  a new time rather than losing the commitment. In a
       *                  capture of one clause as well (FY1 N1): a
       *                  commitment whose hour has passed today is asked
       *                  about, never refused;
       *   missing_title  there is nothing to name, so in a capture of several
       *                  clauses only that clause is skipped.
       *
       * A prompt injection still rejects the whole capture — `semanticFailure`
       * reports it before a short title.
       */
      let clearedPastTime = false;
      // The rules' morning reading of a bare early hour (round 7, I-3): asked
      // as صبح or مسا, whether or not that morning has already gone.
      const bareEarlyHour = (extracted.engine === 'rule-based' || statedEarlyClock !== null) && isBareEarlyHour(extracted.result);
      if (failure === 'past_time' || passedHour) {
        extracted = { ...extracted, result: withoutPastTime(extracted.result, options.now, options.timezone) };
        failure = semanticFailure(extracted.result, options.now);
        clearedPastTime = failure === null;
      }
      if ((several || chat) && failure === 'missing_title') continue;
      if (!standIn) {
        // Whatever actually answered, named — and a model answer is never
        // relabelled by a later clause the rules had to read.
        if (extracted.engine !== 'rule-based' || executedEngine === 'rule-based') executedEngine = extracted.engine;
        fallbackUsed ||= Boolean(extracted.fallbackReason);
      }
      if (failure === 'no_commitment') {
        noCommitmentReason ??= noCommitmentReasonFrom(segment, extracted.result, extracted.fallbackReason);
        // Its clock times were read and found to be nothing to keep — «كان
        // عندي اجتماع الساعة 3» (FY1 N1) — so the valve below does not count
        // them as times a proposed item lost.
        // A chat item's segment is read from every turn; the valve reads the
        // newest message only, so nothing is subtracted for it.
        if (!chat) timesReadAsNothing += countTimeExpressions(segment);
        continue;
      }
      if (failure) {
        rejected = true;
        continue;
      }
      const disposition = decideExtractionDisposition(extracted.result);
      /*
       * A bare early hour is asked about, not guessed (CL1 round 6, D2
       * family). The rules read «الساعة 5» as 05:00 — a number the user said
       * and a half of the day they did not — and proposed it as a time to be
       * at. For one to six with no period word the morning reading is the
       * unlikely one, so the clarification asks صبح or مسا (`ask_am_pm`,
       * the question the review screen already renders); «الساعة 5 المسا»
       * and «الساعة 10» resolve as before.
       */
      const needsClarification = clearedPastTime || gated || unsaid || stillAsked || bareEarlyHour || disposition === 'needs_clarification';
      const itemId = randomUUID();
      // An all-day deadline has a day and no hour (FX3): `resolvedDate` below
      // says which day, and no instant is shown as if somebody chose it.
      const resolvedTime = needsClarification || extracted.result.allDay ? null : extracted.result.remindAt || extracted.result.dueAt;
      items.push({
        itemId,
        title: (extracted.result.title || extracted.result.action || '').trim(),
        resolvedTime,
        needsClarification,
        // The hour shown is ours when the clause gave only a part of the day
        // (UAT round 6, D2): «اليوم المسا» is 18:00 on both engines, and the
        // card says we guessed it. The words decide, not the engine.
        timeEstimated: resolvedTime !== null && hourIsPartOfDayGuess(segment),
        // Sent so the review screen can show Must/Should/Nice without a second
        // call — and so the user can see which of the two it is (#164).
        priority: extracted.result.priority.level,
        // `user_explicit` means the person said so; anything else is ours. A
        // guess presented as a fact is how a product loses the right to guess.
        priorityEstimated: extracted.result.priority.source !== 'user_explicit',
        // The day, even while the hour is still being asked for, and whether we
        // picked it — the same "said vs guessed" split as the priority (L4).
        ...(/^\d{4}-\d{2}-\d{2}$/.test(extracted.result.localTimeSpec?.date ?? '')
          ? { resolvedDate: extracted.result.localTimeSpec!.date, dateEstimated: dateIsGuess(extracted.result, segment) }
          : {}),
        // The one question worth asking, chosen deterministically (#165). Null
        // when there is nothing worth asking, or when every sensible option has
        // fallen into the past — in which case the app falls back to #164's edit
        // sheet rather than asking something unanswerable.
        ...(needsClarification
          ? { clarification: buildClarification(extracted.result, { now: options.now, timezone: options.timezone }) }
          : {}),
        // «كل سبت» (FIX-R8-CAPTURE): the item is a one-off on the next
        // Saturday until weekly blocks exist; this is what that lane reads.
        ...(extracted.result.recurrenceHint
          ? { recurrenceHint: recurrenceHintOf(extracted.result, options.timezone, resolvedTime !== null) }
          : {}),
      });
      commandsByItemId.set(itemId, needsClarification ? [] : mapExtractionToCommand(extracted.result, options.now.toISOString(), categoryPreferences));
      resultsByItemId.set(itemId, extracted.result);
    } catch (error) {
      // Gap B: a negated request is understood, not malformed. It produces no
      // commitment and says so, rather than an error the user has to interpret.
      if (error instanceof NegatedRequestError) {
        noCommitmentReason ??= 'negated_request';
        continue;
      }
      rejected = true;
    }
  }

  // A sentence naming more clock times than the proposal accounts for lost
  // one. The extractor reads a time with a non-global `String.match`, so a
  // segment carrying two times yields one commitment that looks complete, and
  // the confidence policy — which only sees that one result — reports nothing
  // to clarify. Asking is the safe direction: the alternative is silently
  // dropping an appointment while telling the user everything was understood.
  //
  // This only ever moves an item to needing clarification, never away from it,
  // and input naming no clock time cannot trigger it. A time said in a clause
  // that was read as no commitment is not one an item lost (FY1 N1): the past
  // meeting's «الساعة 3» used to send the bank's 17:00 back to be asked.
  const timesInInput = Math.max(0, countTimeExpressions(raw) - timesReadAsNothing);
  if (timesInInput > 0 && items.length > 0) {
    const timesAccountedFor = new Set(
      items.map((item) => item.resolvedTime).filter(Boolean),
    ).size;
    if (timesAccountedFor < timesInInput) {
      for (let i = 0; i < items.length; i++) {
        if (items[i].needsClarification) continue;
        items[i] = { ...items[i], resolvedTime: null, needsClarification: true, timeEstimated: false };
        commandsByItemId.set(items[i].itemId, []);
      }
    }
  }

  // «كل سبت من 10 لـ 4»: a complete weekly range is also offered as a weekly
  // block. After the guard above, so an item it sent back to be asked is not
  // offered on hours the proposal no longer vouches for.
  items.splice(0, items.length, ...withWeeklyBlockOffers(items, options.timezone));

  const status: CaptureProposalContract['status'] = rejected
    ? 'rejected'
    : items.length === 0
      // A capture that named only things the user is turning over is not
      // "nothing" — there is something to offer, and only they can say whether
      // it is worth keeping (#519). With no seeds either, it is the ordinary
      // no-commitment answer and the reason code goes with it.
      ? (seeds.length > 0 ? 'unresolved_intent' : 'no_commitment')
      : items.every((item) => item.needsClarification)
        ? 'needs_clarification'
        : 'proposed';
  const contract: CaptureProposalContract = {
    version: CAPTURE_CONTRACT_VERSION,
    proposalId,
    status,
    // Only on a no-commitment proposal. A `rejected` one is refusing something
    // unsafe, and a reason code there would invite the client to explain it.
    ...(status === 'no_commitment' ? { noCommitmentReason: noCommitmentReason ?? 'low_confidence' } : {}),
    items,
    seeds,
    provenance: { requestedEngine, executedEngine, fallbackUsed },
  };
  await dependencies.store.put({
    contract,
    scopeId: options.scopeId,
    commandsByItemId,
    resultsByItemId,
    /*
     * When it was made, by the server's clock — not `options.now`.
     *
     * `options.now` is the *client's* `referenceTime`, the instant "tomorrow at
     * 9" is resolved against. Using it here conflated two different things and
     * handed the TTL to the caller: a `referenceTime` in the future would keep
     * a proposal confirmable indefinitely, and one in the past would kill it on
     * arrival. The staleness guard exists to catch a proposal resolved against
     * a stale clock, so it has to be measured by a clock the client does not
     * choose (#164 step 7).
     */
    proposedAt: new Date().toISOString(),
  });
  dependencies.audit?.(auditEvent(fallbackUsed ? 'fell_back' : status === 'rejected' ? 'rejected' : 'succeeded', raw, options.now, status, items.length));
  return contract;
}


/**
 * An extraction result standing for what a user typed by hand (UC-2.4, #164).
 *
 * Used only when an item needed clarification and the person answered it in the
 * review screen by supplying a title and a time themselves. Confidence is 1 and
 * the priority is `user_explicit` because none of it is inferred — they said it.
 *
 * It goes through `mapExtractionToCommand` rather than building a command here,
 * so a manually completed item is constructed by exactly the same code as every
 * other commitment and cannot drift from it.
 */
function manuallyCompleted(
  title: string,
  resolvedTime: string,
  priority: 'low' | 'normal' | 'high',
): ExtractionResult {
  return {
    type: 'task',
    action: title,
    title,
    person: null,
    dueAt: resolvedTime,
    remindAt: resolvedTime,
    localTimeSpec: null,
    timeEvidence: 'hhmm',
    priority: { level: priority, source: 'user_explicit', pressureAllowed: false, pressureImplied: false },
    flexibility: 'movable',
    // This path runs only when the extraction produced no command at all, so
    // the user built the item themselves from a title and a time. Nothing was
    // read about which part of life it belongs to and the review screen does
    // not ask, so it starts uncategorised — which is the ordinary case anyway
    // (#415).
    category: null,
    categoryConfidence: 0,
    confidence: { overall: 1, type: 1, action: 1, time: 1, priority: 1 },
    missingFields: [],
    ambiguityFlags: [],
    explicitReminderRequest: true,
    explicitPressureRequest: false,
    rawText: title,
    parserVersion: 'user-edit-v1',
  };
}

export async function confirmCapture(
  input: {
    proposalId: string;
    scopeId: string;
    selectedItemIds: string[];
    idempotencyKey: string;
    /** Applied atomically with the confirm, never afterwards (#164). */
    edits?: CaptureItemEditContract[];
    /** Selected items the person confirmed as weekly blocks, not one-offs. */
    weeklyBlockItemIds?: string[];
    /** For the TTL check. Injected so the rule is testable without waiting. */
    now?: Date;
  },
  dependencies: CaptureBoundaryDependencies,
): Promise<CaptureConfirmationResultContract> {
  const stored = await dependencies.store.get(input.proposalId);
  const failure = (
    failureCode: CaptureConfirmationResultContract['failureCode'],
    cause?: unknown,
  ): CaptureConfirmationResultContract => ({
    version: CAPTURE_CONTRACT_VERSION,
    success: false,
    replayed: false,
    persistedItemIds: [],
    failureCode,
    ...(cause === undefined ? {} : { failureCause: storageFailureCause(cause) }),
  });
  if (!stored || stored.scopeId !== input.scopeId) return failure('proposal_not_found');
  if (stored.confirmedResult) {
    if (stored.idempotencyKey !== input.idempotencyKey) return failure('invalid_selection');
    return { ...(stored.confirmedResult as CaptureConfirmationResultContract), replayed: true };
  }
  // `needs_clarification` is confirmable, `rejected` and `no_commitment` are not
  // (UC-2.4, #164 step 3).
  //
  // An item awaiting a question has no commands, so confirming it without
  // answering the question still fails below on `commands.length === 0`. What
  // this allows is the case the issue asks for: a user who supplied the missing
  // title and time themselves in review has answered it by hand, and refusing
  // the whole proposal because the *extractor* had a question would make that
  // impossible.
  if (stored.contract.status !== 'proposed' && stored.contract.status !== 'needs_clarification') {
    return failure('proposal_rejected');
  }

  // A proposal older than the TTL resolved "tomorrow at 9" against a `now` that
  // is no longer close enough to now, and the user cannot see that from the
  // screen. `proposal_not_found` rather than a new code: from the client's side
  // an expired proposal and a swept one are the same thing, and the app offers
  // to analyze the text again for both (#164 step 7).
  const now = input.now ?? new Date();
  if (stored.proposedAt) {
    /*
     * Both ends of this are the server's clock, deliberately.
     *
     * `proposedAt` is when the server made the proposal and `Date.now()` is
     * when it is being confirmed. `input.now` is the caller's `referenceTime` —
     * the instant relative phrases were resolved against — and measuring the
     * age against that would let a caller send a `referenceTime` of its own
     * choosing to keep a stale proposal alive, which is the one thing this
     * guard exists to prevent.
     */
    const age = Date.now() - Date.parse(stored.proposedAt);
    if (Number.isFinite(age) && age > CAPTURE_PROPOSAL_TTL_MS) return failure('proposal_not_found');
  }

  const selected = new Set(input.selectedItemIds);
  if (selected.size === 0) return failure('invalid_selection');

  // Every edit is validated before any of them is applied, and a single
  // violation fails the whole confirm. Applying the valid ones and dropping the
  // rest would leave some commitments as the user wanted them and others as the
  // extractor guessed, with nothing on screen to say which.
  const knownItemIds = new Set(stored.contract.items.map((item) => item.itemId));
  const editsByItem = new Map<string, ReturnType<typeof validateEdit>>();
  try {
    for (const edit of input.edits ?? []) {
      const normalised = validateEdit(edit, knownItemIds, now);
      // An edit for something the user chose not to save is dropped rather than
      // applied: it would ask the server to validate a change to a commitment
      // that is not being written.
      if (selected.has(edit.itemId)) editsByItem.set(edit.itemId, normalised);
    }
  } catch (error) {
    if (error instanceof InvalidEditError) return failure('invalid_edit');
    throw error;
  }

  // An item that needed clarification has no commands. A user who supplied both
  // a title and a time for it in review has answered the question by hand, so it
  // becomes confirmable — that is what "manual completion" means (#164 step 3).
  const commandsFor = (itemId: string): readonly Command[] => {
    const stored_ = stored.commandsByItemId.get(itemId) ?? [];
    const edit = editsByItem.get(itemId);
    if (stored_.length > 0) {
      if (!edit) return stored_;
      const edited = applyEditToCommands(stored_, edit);
      // Cleared in the edit sheet, an event keeps its day (FY1 review, M1).
      return edit.resolvedTime === null ? keepEventOnItsDay(edited, stored.resultsByItemId?.get(itemId)) : edited;
    }
    if (!edit?.title || !edit?.resolvedTime) return [];
    const item = stored.contract.items.find((candidate) => candidate.itemId === itemId);
    const completed = mapExtractionToCommand(
      manuallyCompleted(edit.title, edit.resolvedTime, edit.priority ?? item?.priority ?? 'normal'),
      now.toISOString(),
    );
    // A place reminder chosen for it in review travels with it (closure CL4).
    return edit.locationTrigger ? applyEditToCommands(completed, { locationTrigger: edit.locationTrigger }) : completed;
  };

  if (Array.from(selected).some((id) => !knownItemIds.has(id))) return failure('invalid_selection');

  // Weekly blocks («ثابت أسبوعي»): only an item the person named, that was
  // selected and that carries the offer. Anything else fails the whole
  // confirm — a block half-created from a guess is a standing claim on their
  // week that they never saw offered.
  const weeklyItemIds = new Set(input.weeklyBlockItemIds ?? []);
  const weeklyBlocks: Array<{ itemId: string; offer: WeeklyBlockOfferContract }> = [];
  for (const itemId of Array.from(weeklyItemIds)) {
    const item = stored.contract.items.find((candidate) => candidate.itemId === itemId);
    if (!selected.has(itemId) || !item?.weeklyBlock) return failure('invalid_selection');
    const edit = editsByItem.get(itemId);
    // The block's days and hours are the offer's; they change on the block.
    if (edit && (edit.resolvedTime !== undefined || edit.locationTrigger !== undefined)) return failure('invalid_edit');
    if (edit?.title && edit.title.length > WEEKLY_BLOCK_TITLE_MAX) return failure('invalid_edit');
    weeklyBlocks.push({ itemId, offer: edit?.title ? { ...item.weeklyBlock, title: edit.title } : item.weeklyBlock });
  }
  if (weeklyBlocks.length > 0 && !dependencies.commitConfirmation) {
    // The in-process development path has no account tree to hold a block.
    return failure('invalid_selection');
  }
  /**
   * What this confirm is about to commit, kept per item and recorded with it.
   *
   * A clarification item is stored with no commands and gets them here, at
   * confirm time. Everything downstream — `persisted`, the collision warning,
   * Undo, the activation — looks the commitment up through the commands the
   * proposal holds for the item, so without this write-back the confirm
   * reports success and leaves behind a commitment nothing can name (#480).
   * Edited commands are recorded as edited, for the same reason: the proposal
   * should say what was written, not what was proposed.
   */
  const committedByItemId = new Map(stored.commandsByItemId);
  for (const item of stored.contract.items) {
    if (!selected.has(item.itemId)) continue;
    // A weekly block is not also a one-off: it commits no commands.
    committedByItemId.set(item.itemId, weeklyItemIds.has(item.itemId) ? [] : commandsFor(item.itemId));
  }
  const commands = stored.contract.items
    .filter((item) => selected.has(item.itemId))
    .flatMap((item) => committedByItemId.get(item.itemId) ?? []);
  if (commands.length === 0 && weeklyBlocks.length === 0) return failure('invalid_selection');
  const result: CaptureConfirmationResultContract = {
    version: CAPTURE_CONTRACT_VERSION,
    success: true,
    replayed: false,
    persistedItemIds: stored.contract.items.filter((item) => selected.has(item.itemId)).map((item) => item.itemId),
  };

  if (dependencies.commitConfirmation) {
    // The commitments and the claim commit together, so a confirm that races
    // another one for the same proposal replays it rather than persisting a
    // second set (#148).
    try {
      const committed = await dependencies.commitConfirmation({
        scopeId: input.scopeId,
        proposalId: input.proposalId,
        idempotencyKey: input.idempotencyKey,
        commands,
        commandsByItemId: committedByItemId,
        result,
        weeklyBlocks,
      });
      return committed.replayed ? { ...committed.result, replayed: true } : committed.result;
    } catch (error) {
      // The message goes to the operator log, where paths and uids are already
      // permitted; only the cause's name travels on the contract (#419).
      console.error('[capture/confirm] the confirmation transaction failed', error);
      return failure('persistence_failed', error);
    }
  }

  // No participant-scoped storage: the in-process development path. It persists
  // and then records, which is exactly the window the committer above closes —
  // acceptable only because this path serves one process and no real account.
  try {
    await dependencies.persistence.persistAtomically(commands);
  } catch (error) {
    console.error('[capture/confirm] the in-process persist failed', error);
    return failure('persistence_failed', error);
  }
  // The Map-backed store persisted this by mutation. A durable store does
  // not, and without the write-back a replayed confirm would find no recorded
  // result and persist the commitments a second time.
  await dependencies.store.put({
    ...stored,
    commandsByItemId: committedByItemId,
    confirmedResult: result,
    idempotencyKey: input.idempotencyKey,
  });
  return result;
}
