import { randomUUID } from 'crypto';
import { dayPartHour, instantFromLocal, localTimeSpecFor, timeAnchorOf } from '../../../src/extraction/timeLexicon';
import { mapExtractionToCommand } from '../../../src/extraction/mapExtractionToCommand';
import { extractWithFallback, type ExtractAndMapOptions } from '../../../src/extraction/extractionService';
import type { ExtractionResult } from '../../../src/extraction/extractionTypes';
import { resolveModuleRuntime, type RuntimeControlSnapshot } from '../../../src/contracts/v1/runtimeControls';
import {
  CAPTURE_EDIT_TITLE_MAX,
  CLARIFICATION_FREE_TEXT_MAX,
  type CaptureProposalContract,
  type ClarificationContract,
} from '../../../src/contracts/v1/captureContracts';
import type { Command } from '../../../src/domain/stateMachine';
import { applyEditToCommands } from './applyEdits';
import { dayForAnswer } from './clarificationBuilder';
import { namesExplicitDate, readWeekdayReference } from '../../../src/extraction/weekdayLexicon';
import type { CaptureProposalStore, StoredCaptureProposal } from './proposalStore';

/**
 * Answering the one question (UC-2.5, #165).
 *
 * ── The answer is applied to the extraction, not to the contract ─
 *
 * A `resolvedTime` patched onto the proposal would leave the *command* behind —
 * and the command is what a confirm persists. Somebody answering "nine in the
 * evening" would see 21:00 on the review screen and get a commitment at 09:00.
 * So the answer edits the stored `ExtractionResult` and the command is rebuilt
 * by `mapExtractionToCommand`, the same function that built it the first time.
 *
 * ── One round, and then the edit sheet ───────────────────────────
 *
 * A product that asks twice has stopped being a capture box and become an
 * interview. A second attempt on the same item is refused; the item comes back
 * with `needsClarification: true` and `clarification: null`, which the app reads
 * as "open UC-2.4 (#164)'s edit sheet instead".
 *
 * ── Free text is re-read, never pasted in ────────────────────────
 *
 * "make it 9" is not a title. It is re-extracted together with the original
 * segment so the extractor resolves it the same way it resolves everything
 * else — including the injection screen, which a raw splice past the extractor
 * would have skipped. It is read by the same engine the capture was: the
 * model when this account's AI consent allows it, the rules when it does not.
 *
 * ── An answer settles the question it answers ───────────────────
 *
 * Only the field that was asked about is taken from the answer: a time answer
 * moves the time and leaves the title the user saw alone. And the user's
 * explicit answer is what settles it — not the extractor's confidence, which
 * it did not change. An item flagged for low confidence and then told "in the
 * evening" used to come back still flagged, with no question left to ask and
 * no command, so nothing could be saved (the dead end found on the first
 * device run). After an accepted answer an item is confirmable, with commands.
 *
 * An answer nothing can be read out of is refused as `answer_not_understood`
 * *before* the round is spent, so the question stays up and the person can
 * pick an option instead.
 */
export type ClarifyFailure =
  | 'proposal_not_found'
  | 'item_not_found'
  | 'question_mismatch'
  | 'already_clarified'
  | 'answer_required'
  | 'free_text_too_long'
  | 'option_not_found'
  /** Free text that answered nothing the question asked. The round is not spent. */
  | 'answer_not_understood';

export interface ClarifyInput {
  proposalId: string;
  itemId: string;
  questionId: string;
  optionId?: string | undefined;
  freeText?: string | undefined;
}

export interface ClarifyOptions {
  now: Date;
  timezone: string;
  scopeId: string;
}

export interface ClarifyDependencies {
  store: CaptureProposalStore;
  extractor?: typeof extractWithFallback;
  /**
   * The model, when this account's AI consent allows one — the same provider
   * the capture was read with. Absent means the rules read the answer, and
   * nothing is sent anywhere: the default is never a model call.
   */
  llmProvider?: ExtractAndMapOptions['llmProvider'];
  llmEngine?: ExtractAndMapOptions['llmEngine'];
  controls?: RuntimeControlSnapshot;
  /**
   * Where the answer is written down.
   *
   * Required, and called without a `?.`, because it was neither: the port was
   * optional and the call was optional-chained, the single production
   * construction site never passed one, and so for the whole life of UC-2.5
   * the event was assembled and dropped with nothing that could go red about
   * it. A missing implementation is now a type error at the construction site
   * rather than silence at runtime — which is the only version of this the
   * suite can defend.
   *
   * `{ type:'clarification_answered', … }`. The free text itself is never in it.
   */
  recordEvent: (event: ClarificationAnsweredEvent) => void | Promise<void>;
}

export interface ClarificationAnsweredEvent {
  type: 'clarification_answered';
  proposalId: string;
  itemId: string;
  field: string;
  answerKind: 'option' | 'free_text';
  at: string;
}

export class ClarifyError extends Error {
  constructor(readonly failure: ClarifyFailure, message?: string) {
    super(message ?? failure);
  }
}

/** The local date and time an answered item should resolve to. */
function appliedLocal(
  result: ExtractionResult,
  value: { localTime?: string; localDate?: string },
): { date: string | null; time: string | null } {
  return {
    date: value.localDate ?? result.localTimeSpec?.date ?? null,
    // An option with neither a time nor a date is the "no specific time"
    // choice: a deliberate answer, and the reason `time` is set to null rather
    // than left as whatever the extractor had guessed.
    time: value.localTime ?? (value.localDate ? result.localTimeSpec?.time ?? null : null),
  };
}

function withResolvedTime(
  result: ExtractionResult,
  local: { date: string | null; time: string | null },
  timezone: string,
): ExtractionResult {
  if (!local.date) return result;
  const instant = local.time ? instantFromLocal(local.date, local.time, timezone) : null;
  return {
    ...result,
    localTimeSpec: { date: local.date, time: local.time },
    // Only the reminder moves. `dueAt` is the deadline the user named, and an
    // answer about *when to be reminded* is not permission to move it.
    remindAt: instant ? instant.toISOString() : null,
    dueAt: instant ? instant.toISOString() : result.dueAt,
    // The user said it, so the evidence is theirs now rather than the
    // extractor's reading.
    timeEvidence: local.time ? 'explicit' : result.timeEvidence,
  } as ExtractionResult;
}

/**
 * Drafts an answer left flagged, made confirmable.
 *
 * The extractor's confidence measured how well *it* read the sentence; once
 * the person has answered the question it was unsure about, a score below the
 * policy's floor is no longer a reason to hold the item back. And what is
 * still missing after the one round (a follow-up's person, a time the
 * question was not about) is the review screen's to show and the edit sheet's
 * to fix. It is not a reason to strand the item: the user sees it and presses
 * Confirm themselves, so `pending_confirmation` is exactly what it is.
 */
function settleDrafts(commands: readonly Command[]): Command[] {
  return commands.map((command) => (
    command.type === 'CreateDraft' && command.draftStatus !== 'pending_confirmation'
      ? { ...command, draftStatus: 'pending_confirmation' as const }
      : command
  ));
}

const TIME_FIELDS: ReadonlySet<ClarificationContract['field']> = new Set<ClarificationContract['field']>(['time', 'time_period', 'which_day']);
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

/** A limit word in the sentence or in the answer keeps a deadline; otherwise a time to be at. */
function answeredTimeAnchor(rawText: string, freeText: string): 'event' | 'deadline' {
  return timeAnchorOf(rawText) === 'deadline' || (freeText !== '' && timeAnchorOf(freeText) === 'deadline')
    ? 'deadline'
    : 'event';
}

/** The time the answer named, applied to the item it answers and nothing else. */
function withTimeFrom(result: ExtractionResult, source: ExtractionResult): ExtractionResult {
  return {
    ...result,
    dueAt: source.dueAt ?? source.remindAt,
    remindAt: source.remindAt ?? source.dueAt,
    localTimeSpec: source.localTimeSpec,
    timeEvidence: source.timeEvidence,
  };
}

/**
 * Reads a typed answer, and applies what it says to the field that was asked.
 *
 * The original text and the answer are re-read together, by the engine the
 * capture was allowed: the model under this account's consent, otherwise the
 * rules. Then only the asked field is taken:
 *
 *   a time question   the time the re-read found; failing that, a bare part of
 *                     the day ("بالمسا", "in the evening") on the day the
 *                     matching option would have used. The title stays.
 *   the action        the re-read's action when it found one; failing that,
 *                     the answer itself — it is the user's reply to "what do
 *                     you want to do?", screened by the same re-read and held
 *                     to the edit sheet's title bounds.
 *
 * Anything else is `answer_not_understood`, with the round intact.
 */
async function readFreeTextAnswer(
  result: ExtractionResult,
  question: ClarificationContract,
  freeText: string,
  options: ClarifyOptions,
  dependencies: ClarifyDependencies,
): Promise<ExtractionResult> {
  const extractor = dependencies.extractor ?? extractWithFallback;
  const rulesOnly = resolveModuleRuntime('capture', dependencies.controls).mode === 'rules_only';
  // The original text plus what they added, read together. Splicing the words
  // straight into a field would skip the injection screen and the time
  // lexicon both.
  const combined = `${result.rawText ?? ''}\n${freeText}`.trim();
  const extracted = await extractor(combined, { now: options.now, timezone: options.timezone }, {
    // Never the extractor's default: with no provider it would try a local
    // model, which is neither the consented engine nor the rules.
    llmProvider: !rulesOnly && dependencies.llmProvider
      ? dependencies.llmProvider
      : async () => { throw new Error('rules-only runtime'); },
    ...(dependencies.llmEngine ? { llmEngine: dependencies.llmEngine } : {}),
  });
  if (extracted.fallbackReason?.startsWith('prompt_injection')) throw new ClarifyError('answer_not_understood');
  const reread = extracted.result;
  const readable = reread.type === 'task' || reread.type === 'follow_up';

  if (TIME_FIELDS.has(question.field)) {
    // Asked for the hour of a day the item already has, and answered with an
    // hour alone: the day stays the item's (CL1 round 2). Re-reading «سجّل
    // موعد دكتور يوم الأحد» + «الساعة 10 الصبح», Gemini put the doctor on the
    // Sunday after — the question was never about the day, and the review
    // card had just shown the 27th. Only the time of day is taken from the
    // re-read; a typed answer that names a day, or a "which day" question,
    // still moves it.
    const itemDate = result.localTimeSpec?.date ?? null;
    const rereadTime = reread.localTimeSpec?.time ?? null;
    if (
      readable && (reread.remindAt || reread.dueAt)
      && question.field !== 'which_day' && itemDate && rereadTime
      && !readWeekdayReference(freeText) && !namesExplicitDate(freeText)
    ) {
      const day = dayForAnswer(rereadTime, itemDate, { now: options.now, timezone: options.timezone });
      if (day) return withResolvedTime(result, { date: day, time: rereadTime }, options.timezone);
    }
    if (readable && (reread.remindAt || reread.dueAt)) return withTimeFrom(result, reread);
    const hour = dayPartHour(freeText);
    if (hour !== null) {
      const time = `${String(hour).padStart(2, '0')}:00`;
      const preferred = result.localTimeSpec?.date
        ?? (result.remindAt || result.dueAt
          ? localTimeSpecFor(new Date(Date.parse((result.remindAt || result.dueAt)!)), options.timezone)?.date ?? null
          : null);
      const day = dayForAnswer(time, preferred, { now: options.now, timezone: options.timezone });
      if (day) return withResolvedTime(result, { date: day, time }, options.timezone);
    }
    throw new ClarifyError('answer_not_understood');
  }

  // The action question.
  const action = reread.action?.trim() ?? '';
  if (readable && action.length >= 3) {
    return {
      ...result,
      action,
      title: (reread.title || action).trim(),
      type: reread.type,
      person: reread.person ?? result.person,
      // A time the re-read found is kept only when the item had none; the
      // question was not about it.
      ...(result.remindAt || result.dueAt ? {} : {
        dueAt: reread.dueAt, remindAt: reread.remindAt, localTimeSpec: reread.localTimeSpec, timeEvidence: reread.timeEvidence,
      }),
      ambiguityFlags: result.ambiguityFlags.filter((flag) => flag !== 'vague_action' && flag !== 'no_action_verb'),
    };
  }
  if (freeText.length >= 3 && freeText.length <= CAPTURE_EDIT_TITLE_MAX && !CONTROL_CHARACTERS.test(freeText)) {
    return {
      ...result,
      type: result.type === 'follow_up' ? 'follow_up' : 'task',
      action: freeText,
      title: freeText,
      ambiguityFlags: result.ambiguityFlags.filter((flag) => flag !== 'vague_action' && flag !== 'no_action_verb'),
    };
  }
  throw new ClarifyError('answer_not_understood');
}

export async function answerClarification(
  input: ClarifyInput,
  options: ClarifyOptions,
  dependencies: ClarifyDependencies,
): Promise<CaptureProposalContract> {
  const stored = await dependencies.store.get(input.proposalId);
  if (!stored || stored.scopeId !== options.scopeId) throw new ClarifyError('proposal_not_found');

  const index = stored.contract.items.findIndex((item) => item.itemId === input.itemId);
  const item = stored.contract.items[index];
  if (!item) throw new ClarifyError('item_not_found');

  if ((stored.clarifiedItemIds ?? []).includes(input.itemId)) {
    throw new ClarifyError('already_clarified');
  }
  const question = item.clarification;
  if (!question || question.questionId !== input.questionId) {
    // A stale question id means the app is answering something this proposal is
    // no longer asking. Applying it would apply an answer to a different
    // question.
    throw new ClarifyError('question_mismatch');
  }

  const result = stored.resultsByItemId?.get(input.itemId);
  if (!result) throw new ClarifyError('item_not_found');

  const freeText = typeof input.freeText === 'string' ? input.freeText.trim() : '';
  if (!input.optionId && !freeText) throw new ClarifyError('answer_required');
  if (freeText.length > CLARIFICATION_FREE_TEXT_MAX) throw new ClarifyError('free_text_too_long');

  let answered: ExtractionResult;
  let answerKind: 'option' | 'free_text';
  // "No specific time" — the option with no value (#474).
  let noTime = false;

  if (input.optionId) {
    const option = question.options.find((candidate) => candidate.optionId === input.optionId);
    if (!option) throw new ClarifyError('option_not_found');
    noTime = !option.value.localTime && !option.value.localDate;
    answered = noTime
      // The user chose no hour, so nothing the extractor guessed about one
      // survives. The same shape a "No time" edit produces (`applyEdits`).
      ? { ...result, remindAt: null, dueAt: null } as ExtractionResult
      : withResolvedTime(result, appliedLocal(result, option.value), options.timezone);
    answerKind = 'option';
  } else {
    answered = await readFreeTextAnswer(result, question, freeText, options, dependencies);
    answerKind = 'free_text';
  }

  // What the answered time is to the person (CL1 review, I1). The answer is a
  // time of day; with no limit word in the sentence or in a typed answer —
  // «قبل», "by", «עד» — it is a time to be *at*, so the doctor answered
  // "morning" or «الساعة 10 الصبح» is a fixed event the planner keeps where
  // it is. Without this every answered time became a `due_by` and the planner
  // floated the appointment ahead as a deadline — D2's defect, through the one
  // path the UAT doctor actually takes.
  if (!noTime && (answered.dueAt || answered.remindAt)) {
    answered = { ...answered, timeAnchor: answeredTimeAnchor(result.rawText, answerKind === 'free_text' ? freeText : '') };
  }

  // A "no specific time" answer settles the item (#474). The builder offers it
  // because a commitment without an hour is a legitimate thing to want, but the
  // disposition policy still reads a missing time as unclear — so without this
  // the item came back flagged, with no command, and could never be confirmed.
  //
  // The command is the extractor's draft with the time cleared through
  // `applyEditToCommands`, the path a "No time" edit at confirm takes, so the
  // two cannot disagree about what a time-less commitment is. It waits as
  // `pending_confirmation`, like any other answered item, so the confirm
  // activates it. A confirm-time edit with a title and no time is still refused:
  // only this explicit answer settles.
  const answeredCommands = noTime
    ? settleDrafts(applyEditToCommands(mapExtractionToCommand(answered, options.now.toISOString()), { resolvedTime: null }))
    : settleDrafts(mapExtractionToCommand(answered, options.now.toISOString()));

  // Never resolved with nothing to persist. An item marked answered with zero
  // commands is a Confirm the server then refuses with `invalid_selection`;
  // refusing the answer instead keeps the question, and the round, for another
  // try.
  if (answeredCommands.length === 0) throw new ClarifyError('answer_not_understood');

  const items = [...stored.contract.items];
  items[index] = {
    ...item,
    title: (answered.title || answered.action || item.title).trim(),
    resolvedTime: answered.remindAt || answered.dueAt || null,
    // Settled: the question it had was the one it needed, and it is answered.
    needsClarification: false,
    priority: answered.priority.level,
    priorityEstimated: answered.priority.source !== 'user_explicit',
    clarification: null,
  };
  items[index] = withDateGuess(items[index]!, answered, result);

  const contract: CaptureProposalContract = {
    ...stored.contract,
    items,
    // Answering the last open question makes the proposal confirmable.
    status: items.length > 0 && items.every((candidate) => candidate.needsClarification)
      ? 'needs_clarification'
      : 'proposed',
  };

  const commands = new Map(stored.commandsByItemId);
  commands.set(input.itemId, answeredCommands);
  const results = new Map(stored.resultsByItemId);
  results.set(input.itemId, answered);

  const next: StoredCaptureProposal = {
    ...stored,
    contract,
    commandsByItemId: commands,
    resultsByItemId: results,
    clarifiedItemIds: [...(stored.clarifiedItemIds ?? []), input.itemId],
  };
  await dependencies.store.put(next);

  // The answer, never the words. A free-text answer is the user's own sentence
  // about their own commitment and has no business in an event log.
  await dependencies.recordEvent({
    type: 'clarification_answered',
    proposalId: input.proposalId,
    itemId: input.itemId,
    field: question.field,
    answerKind,
    at: options.now.toISOString(),
  });

  return contract;
}

/** A question id, for a builder that needs one. Kept here so tests can stub it. */
export const newQuestionId = (): string => randomUUID();

/**
 * The answered item's day, and whether it is still our guess (L4, fix round 1).
 *
 * Recomputed from the answer, like `priorityEstimated`: a free-text answer can
 * name another day, and an option can land on a different date from the one
 * guessed. Kept a guess only while the day is still the one the weekday name
 * produced; dropped when the answer left no day at all.
 */
function withDateGuess(
  item: CaptureProposalContract['items'][number],
  answered: ExtractionResult,
  before: ExtractionResult,
): CaptureProposalContract['items'][number] {
  const { resolvedDate: _date, dateEstimated: _estimated, ...rest } = item;
  const date = answered.localTimeSpec?.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return rest;
  // A free-text answer is re-extracted, so its own flag is the truth. An option
  // answer carries the original flag, which holds only for the original day.
  const reextracted = answered.rawText !== before.rawText;
  const stillGuessed = answered.dateInferred === true && (reextracted || date === before.localTimeSpec?.date);
  return { ...rest, resolvedDate: date, dateEstimated: stillGuessed };
}
