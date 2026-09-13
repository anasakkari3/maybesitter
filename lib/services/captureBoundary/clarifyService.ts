import { randomUUID } from 'crypto';
import { instantFromLocal } from '../../../src/extraction/timeLexicon';
import { mapExtractionToCommand } from '../../../src/extraction/mapExtractionToCommand';
import { decideExtractionDisposition } from '../../../src/extraction/extractionPolicy';
import { extractWithFallback } from '../../../src/extraction/extractionService';
import type { ExtractionResult } from '../../../src/extraction/extractionTypes';
import {
  CLARIFICATION_FREE_TEXT_MAX,
  type CaptureProposalContract,
} from '../../../src/contracts/v1/captureContracts';
import { buildClarification } from './clarificationBuilder';
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
 * would have skipped.
 */
export type ClarifyFailure =
  | 'proposal_not_found'
  | 'item_not_found'
  | 'question_mismatch'
  | 'already_clarified'
  | 'answer_required'
  | 'free_text_too_long'
  | 'option_not_found';

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

  if (input.optionId) {
    const option = question.options.find((candidate) => candidate.optionId === input.optionId);
    if (!option) throw new ClarifyError('option_not_found');
    answered = withResolvedTime(result, appliedLocal(result, option.value), options.timezone);
    answerKind = 'option';
  } else {
    const extractor = dependencies.extractor ?? extractWithFallback;
    // The original text plus what they added, read together. Splicing the words
    // straight into a field would skip the injection screen and the time
    // lexicon both.
    const combined = `${result.rawText ?? ''}\n${freeText}`.trim();
    const extracted = await extractor(combined, { now: options.now, timezone: options.timezone });
    answered = extracted.result;
    answerKind = 'free_text';
  }

  // One round. Whether it worked or not, this item does not get asked again.
  const stillUnclear = decideExtractionDisposition(answered) === 'needs_clarification';
  const items = [...stored.contract.items];
  items[index] = {
    ...item,
    title: (answered.title || answered.action || item.title).trim(),
    resolvedTime: stillUnclear ? null : answered.remindAt || answered.dueAt,
    needsClarification: stillUnclear,
    priority: answered.priority.level,
    priorityEstimated: answered.priority.source !== 'user_explicit',
    // Null rather than a second question: the app falls back to #164's edit
    // sheet, which can express anything a question cannot.
    clarification: null,
  };

  const contract: CaptureProposalContract = {
    ...stored.contract,
    items,
    // Answering the last open question makes the proposal confirmable.
    status: items.length > 0 && items.every((candidate) => candidate.needsClarification)
      ? 'needs_clarification'
      : 'proposed',
  };

  const commands = new Map(stored.commandsByItemId);
  commands.set(input.itemId, stillUnclear ? [] : mapExtractionToCommand(answered, options.now.toISOString()));
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
