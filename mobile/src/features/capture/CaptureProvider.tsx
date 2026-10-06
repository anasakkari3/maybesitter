/**
 * The capture flow's state, scoped to the flow (UC-2.R2, #172).
 *
 * The reducer in `captureMachine.ts` holds the transitions; this holds the one
 * live copy of them and the calls that drive them. Two things it deliberately
 * is not:
 *
 *   - **not in `AppContext`.** The draft is the most sensitive text the product
 *     handles — whatever somebody was about to commit to, before deciding
 *     whether to — and putting it in the app-wide store would make its lifetime
 *     the app's rather than the flow's. Closing capture must forget it.
 *   - **not persisted.** No storage import, here or in the reducer.
 *     `capture.noDisk.test.tsx` asserts the module graph, because a mock only
 *     proves nothing wrote today.
 *
 * The undo window is a timer here rather than in a screen so that navigating
 * away cannot leave it armed, and so the "5 seconds" in the acceptance criteria
 * is one number in one place.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useAnalyticsConsent,
  useCaptureChat,
  useClarifyCapture,
  useConfirmCapture,
  useRecordAnalytics,
} from '../../api/queries';
import { useTimeZone } from '../../i18n/timezone';
import { useOptionalAuth } from '../../auth/AuthProvider';
import { deleteCommitment } from '../../api/endpoints/commitments';
import { ConversationNotFoundError, InputTooLargeError, isRetryable, ProposalChangedError, QuotaExceededError, ValidationError } from '../../api/errors';
import type { CaptureProposalEdit } from '../../api/endpoints/capture';
import { instantForLocalDateTime } from './localInstant';
import { userFacingMessageKey, type UserFacingKey } from '../../api/ui/userFacingMessage';
import type { CaptureProposal } from '../../api/schemas/capture';
import {
  captureReducer,
  confirmPayload,
  initialCaptureState,
  MAX_CAPTURE_LENGTH,
  UNDO_WINDOW_MS,
  type CaptureFailureKind,
  type CaptureInputMode,
  type CaptureItemEdit,
  type CaptureSource,
  type MeetingReviewContext,
  type CaptureState,
} from './captureMachine';
import { toServerEdits } from './editPayload';
import {
  chatTurn,
  confirmCapture as runConfirm,
  reportCaptureUndone,
  undoCapture,
  type AnalyzeFailure,
  type UndoOutcome,
} from './captureFlowActions';

export type { UndoOutcome };

interface CaptureContextValue {
  state: CaptureState;
  open(source?: CaptureSource, inputMode?: CaptureInputMode): void;
  setText(text: string): void;
  /**
   * Sends the draft (or `textOverride`) to the capture chat «احكيها», in the
   * current conversation — the first send starts one. The answer's proposal
   * replaces the one on screen; nothing is saved until `confirm`.
   */
  analyze(textOverride?: string): Promise<void>;
  /** Back from a failed send to the conversation, the message still in the field. */
  dismissFailure(): void;
  /** «ابدأ من جديد»: the conversation, its proposal and the draft go; a new one starts. */
  startOver(): void;
  /**
   * Enters review with a proposal this flow did not ask for (UC-3.0, #183).
   *
   * The share pipeline analyses on its own screen and then hands the result
   * here, so review, clarify, edit, confirm and undo are the same code for a
   * shared chat as for a typed sentence — which is the whole point of #183
   * producing an ordinary capture proposal rather than a shape of its own.
   *
   * `text` stays empty deliberately. Putting the shared content in the
   * composer would offer a Back that returns to an editable copy of somebody's
   * chat export, and would make `hasUnsavedText` true for content the user
   * never typed.
   */
  adoptProposal(proposal: CaptureProposal, source?: CaptureSource, meeting?: MeetingReviewContext): void;
  toggleItem(itemId: string): void;
  selectAll(): void;
  deselectAll(): void;
  editItem(itemId: string, edit: CaptureItemEdit): void;
  /** «كل أسبوع» or «مرة وحدة بس» on an item the server offered a weekly block for. */
  setWeekly(itemId: string, weekly: boolean): void;
  /** Keep or remove an item's suggested goal link («مرتبط بهدف …»). */
  setGoalLink(itemId: string, linked: boolean): void;
  /**
   * Answers the one question on one item (UC-2.5, #165).
   *
   * The server returns the whole updated proposal and it replaces the one held
   * here, so the review screen shows what it will actually confirm. A failure
   * leaves the proposal as it was and reports it, rather than clearing the
   * question and pretending the answer landed.
   */
  clarify(itemId: string, answer: { optionId?: string; freeText?: string }): Promise<ClarifyOutcome>;
  confirm(): Promise<void>;
  undo(): Promise<UndoOutcome>;
  backToComposer(): void;
  /** «هيك صح» on the chat's summary: the proposal's cards. */
  acceptUnderstood(): void;
  /** Back from those cards to the summary. */
  reopenUnderstood(): void;
  close(): void;
  /** Dictation in progress (`final` false) or finished, with its whole-draft alternatives (M2b). */
  dictate(text: string, final: boolean, alternatives?: readonly string[]): void;
  /** A «أو قصدك» chip: that reading replaces the draft; nothing is sent. */
  chooseAlternative(text: string): void;
  /**
   * One structured change to one point of the summary (M2b): an atomic patch
   * through the chat, proposal-only. A staged card title/time of that item is
   * folded into the same patch (its time only when the result is a
   * commitment). Never retried; a 409 adopts the current answer.
   */
  editPoint(target: CaptureProposalEdit['target'], change: CaptureProposalEdit['change']): Promise<EditOutcome>;
  /** The current proposal a 409 brought back from somewhere else (seed keep). */
  adoptCurrent(proposal: CaptureProposal): void;
}

/** How a structured edit went: applied, or why not — the summary shows a note. */
export type EditOutcome = { ok: true } | { ok: false; reason: 'changed' | 'ended' | 'failed' | 'unavailable' };

/**
 * How an answer went. A failure carries the line to show under the question,
 * which stays up: an unanswered question is the honest state, and a silent
 * reset looked like the answer had landed.
 */
export type ClarifyOutcome = { ok: true } | { ok: false; messageKey: UserFacingKey };

const CaptureContext = createContext<CaptureContextValue | null>(null);

/**
 * Which recovery the user is offered.
 *
 * A 400 is the server refusing the input and will refuse it again, so it is a
 * validation state with no Retry. A 429 or a 413 is the server declining to do
 * the work at all — the quota is spent, or the text is too long for a model
 * call — and neither is cured by pressing a button, so `refused` has no Retry
 * either. Anything retryable is the network. Everything else is the extractor
 * having answered but not been able to read the message.
 *
 * This decides the *buttons* only. The words come from `classifyFailure`.
 */
function failureKind(error: unknown): CaptureFailureKind {
  if (error instanceof ValidationError) return 'validation';
  if (error instanceof QuotaExceededError || error instanceof InputTooLargeError) return 'refused';
  return isRetryable(error) ? 'network' : 'extraction';
}

/**
 * The failure as the screen needs it: a recovery and a locale key.
 *
 * The key comes from `userFacingMessageKey` — the same table `QueryBoundary`
 * reads — rather than from a branch in the composer. The composer used to
 * choose between three strings of its own, and every failure that was not a
 * 400 or a network drop came out as "something went wrong"; the four AI
 * refusal lines existed in all three locales and no code path could reach
 * them (#181).
 */
export function classifyFailure(error: unknown): AnalyzeFailure {
  return { kind: failureKind(error), messageKey: userFacingMessageKey(error) };
}

/**
 * Refetches the lists a new or removed commitment changes.
 *
 * By predicate rather than by key: Today and Upcoming are keyed per timezone and
 * the recommendation per locale, so a fully-specified key would miss every other
 * one the cache happens to hold — including the one the user is looking at.
 */
async function invalidateCommitmentViews(client: ReturnType<typeof useQueryClient>): Promise<void> {
  await client.invalidateQueries({
    predicate: (query) => query.queryKey.some(
      (segment) => segment === 'commitments' || segment === 'commitment' || segment === 'nextStep',
    ),
  });
}

export function CaptureProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(captureReducer, initialCaptureState());
  const chat = useCaptureChat();
  const confirmCapture = useConfirmCapture();
  const clarifyCapture = useClarifyCapture();
  const analyticsConsent = useAnalyticsConsent();
  const recordAnalytics = useRecordAnalytics();
  const client = useQueryClient();
  const timezone = useTimeZone();
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const analysisGeneration = useRef(0);
  const analysisPending = useRef(false);

  const abandonAnalysis = useCallback(() => {
    analysisGeneration.current += 1;
    analysisPending.current = false;
  }, []);

  // Another account (M2b, account isolation): this capture is forgotten, and
  // anything still on its way for the previous account — a reply, an edit, a
  // clarification, a confirm — lands nowhere (each checks the generation).
  const uid = useOptionalAuth()?.user?.uid ?? null;
  const previousUid = useRef(uid);
  useEffect(() => {
    if (previousUid.current === uid) return;
    const before = previousUid.current;
    previousUid.current = uid;
    // The account first becoming known is not a change of account: nothing
    // of another person's can be here yet (and an adopted share must stay).
    if (before === null) return;
    if (undoTimer.current) clearTimeout(undoTimer.current);
    abandonAnalysis();
    dispatch({ type: 'reset' });
  }, [uid, abandonAnalysis]);

  // The timer is cleared on unmount, so leaving the flow cannot leave Undo
  // armed against a screen that is gone.
  useEffect(() => () => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    abandonAnalysis();
  }, [abandonAnalysis]);

  const open = useCallback((source?: CaptureSource, inputMode?: CaptureInputMode) => {
    abandonAnalysis();
    dispatch({ type: 'open', ...(source ? { source } : {}), ...(inputMode ? { inputMode } : {}) });
  }, [abandonAnalysis]);

  const setText = useCallback((text: string) => dispatch({ type: 'textChanged', text }), []);

  const analyze = useCallback(async (textOverride?: string) => {
    const text = textOverride ?? state.text;
    // Refuse invalid replacement drafts without losing the current proposal.
    // In particular, never show the reducer's truncated text while sending a
    // longer string. The caller disables Send at this same boundary.
    if (!text.trim() || text.length > MAX_CAPTURE_LENGTH || analysisPending.current || state.status === 'confirming') return;
    analysisPending.current = true;
    const generation = ++analysisGeneration.current;
    // The exact approved draft goes to both state and the request. Calling
    // setText then analyze in one press would send the old render's text.
    if (textOverride !== undefined) dispatch({ type: 'textChanged', text });
    dispatch({ type: 'chatStarted' });
    try {
      const outcome = await chatTurn(
        { chat: (input) => chat.mutateAsync(input) },
        state.conversationId,
        text,
        classifyFailure,
        // The field's own words came from dictation (M2b); a replacement text does not.
        textOverride === undefined && state.spoken,
      );
      if (generation !== analysisGeneration.current) return;
      dispatch(outcome.ok
        ? { type: 'chatAnswered', answer: outcome.answer }
        : { type: 'analyzeFailed', kind: outcome.kind, messageKey: outcome.messageKey });
    } finally {
      if (generation === analysisGeneration.current) analysisPending.current = false;
    }
  }, [chat, state.text, state.status, state.conversationId, state.spoken]);

  const dismissFailure = useCallback(() => dispatch({ type: 'dismissFailure' }), []);
  const startOver = useCallback(() => {
    abandonAnalysis();
    dispatch({ type: 'reset' });
  }, [abandonAnalysis]);

  const adoptProposal = useCallback((proposal: CaptureProposal, source: CaptureSource = 'share', meeting?: MeetingReviewContext) => {
    // `open` first, so nothing of a previous capture — a draft, a selection, an
    // armed undo — is still in the state the shared proposal lands in.
    abandonAnalysis();
    dispatch({ type: 'open', source, ...(meeting ? { meeting } : {}) });
    dispatch({ type: 'analyzeSucceeded', proposal });
  }, [abandonAnalysis]);

  const toggleItem = useCallback((itemId: string) => dispatch({ type: 'toggleItem', itemId }), []);
  const selectAll = useCallback(() => dispatch({ type: 'selectAll' }), []);
  const deselectAll = useCallback(() => dispatch({ type: 'deselectAll' }), []);

  const clarify = useCallback(async (itemId: string, answer: { optionId?: string; freeText?: string }) => {
    const proposal = state.proposal;
    const question = proposal?.items.find((item) => item.itemId === itemId)?.clarification;
    if (!proposal || !question) return { ok: false, messageKey: 'errorsGeneric' } as const;
    const generation = analysisGeneration.current;
    const proposalId = proposal.proposalId;
    try {
      const updated = await clarifyCapture.mutateAsync({
        proposalId,
        itemId,
        questionId: question.questionId,
        ...(proposal.revision !== undefined ? { revision: proposal.revision } : {}),
        ...(answer.optionId ? { optionId: answer.optionId } : {}),
        ...(answer.freeText ? { freeText: answer.freeText } : {}),
      });
      // Closing/reopening or starting another capture makes this answer belong
      // to a former review, even if that same proposal is adopted again.
      if (generation !== analysisGeneration.current || updated.proposalId !== proposalId) {
        return { ok: false, messageKey: 'errorsGeneric' } as const;
      }
      // The whole proposal, so `needsClarification`, the title and the time all
      // move together. Patching one field here is how the three drift apart.
      // `clarified`, not `analyzeSucceeded`: the other items keep their
      // selection and edits (#474).
      dispatch({ type: 'clarified', proposal: updated });
      return { ok: true } as const;
    } catch (error) {
      // It moved on elsewhere (M2b): show it as it is now, and say so.
      if (error instanceof ProposalChangedError && error.current.kind === 'proposal' && generation === analysisGeneration.current) {
        dispatch({ type: 'proposalReplaced', proposal: error.current.proposal });
        return { ok: false, messageKey: 'captureProposalChanged' } as const;
      }
      // The proposal is untouched. The screen keeps the question rather than
      // clearing it, because an unanswered question is the honest state — and
      // says why, because a question that silently comes back looks broken.
      return { ok: false, messageKey: userFacingMessageKey(error) } as const;
    }
  }, [clarifyCapture, state.proposal]);
  const editItem = useCallback((itemId: string, edit: CaptureItemEdit) => dispatch({ type: 'editItem', itemId, edit }), []);
  const setWeekly = useCallback((itemId: string, weekly: boolean) => dispatch({ type: 'setWeekly', itemId, weekly }), []);
  const setGoalLink = useCallback((itemId: string, linked: boolean) => dispatch({ type: 'setGoalLink', itemId, linked }), []);

  const confirm = useCallback(async () => {
    if (confirmPayload(state).itemIds.length === 0) return;
    const generation = analysisGeneration.current;
    dispatch({ type: 'confirmStarted' });
    let changed: ProposalChangedError | null = null;
    const outcome = await runConfirm(
      // The edits travel with the confirm (UC-2.4, #164), never as a PATCH
      // afterwards: what the user saw when they pressed confirm is what gets
      // written, or nothing is.
      {
        confirm: ({ proposalId, itemIds, edits, weeklyBlockItemIds, goalLinkItemIds, revision }) => confirmCapture.mutateAsync({
          proposalId,
          itemIds,
          // Only when there are any: an edit-free confirm is the request it always was.
          ...(Object.keys(edits).length > 0 ? { edits: toServerEdits(edits, timezone) } : {}),
          // «كل أسبوع» — only these become a block; the rest confirm once.
          weeklyBlockItemIds,
          // «مرتبط بهدف …» — only the links left on the cards are made.
          ...(goalLinkItemIds?.length ? { goalLinkItemIds } : {}),
          // What was seen is what is saved (M2b).
          ...(revision !== undefined ? { revision } : {}),
        }).catch((error: unknown) => {
          if (error instanceof ProposalChangedError) changed = error;
          throw error;
        }),
      },
      state,
    );
    if (!outcome) return;
    if (!outcome.ok) {
      if (generation === analysisGeneration.current) {
        const current = (changed as ProposalChangedError | null)?.current;
        if (current?.kind === 'proposal') {
          // Nothing was saved: the version that is current now goes up for review.
          dispatch({ type: 'proposalReplaced', proposal: current.proposal });
          dispatch({ type: 'confirmFailed', reason: 'proposal_changed', messageKey: 'captureProposalChanged' });
        } else {
          dispatch({ type: 'confirmFailed', reason: outcome.reason, messageKey: outcome.messageKey });
        }
      }
      return;
    }
    if (generation === analysisGeneration.current) {
      dispatch({ type: 'confirmSucceeded', confirmation: outcome.confirmation });
    }
    // The explicit confirmation may have committed even after the user left.
    // Refresh the lists, but never replace a newer draft or arm its Undo timer.
    await invalidateCommitmentViews(client);
    if (generation !== analysisGeneration.current) return;
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => dispatch({ type: 'undoWindowClosed' }), UNDO_WINDOW_MS);
  }, [client, confirmCapture, state, timezone]);

  /**
   * Soft-deletes what was saved, one at a time, and reports honestly.
   *
   * Sequential rather than parallel: each delete is a separate mutation on a
   * separate document, and a burst of them racing is how one gets lost. If some
   * fail, the ones that are still saved are named — never "undone" when a
   * commitment is still there.
   */
  const undo = useCallback(async (): Promise<UndoOutcome> => {
    const outcome = await undoCapture({ remove: (id) => deleteCommitment(id) }, state.persisted);
    if (undoTimer.current) clearTimeout(undoTimer.current);
    dispatch({ type: 'undoWindowClosed' });
    // In the chat, the saved line says it was taken back (and what was not).
    dispatch({ type: 'undoRecorded', stillSaved: outcome.stillSaved });
    // Not awaited, on purpose. `capture_undone` (UC-2.R2, #172) reads the
    // consent record and then posts a count; putting either on the path
    // between pressing Undo and being told what happened would make a metrics
    // request part of how fast the product feels.
    void reportCaptureUndone(outcome, {
      analyticsConsent,
      report: (counts) => recordAnalytics.mutate({ eventName: 'capture_undone', properties: { ...counts } }),
    });
    // Whatever happened, the lists are now wrong until they refetch.
    await invalidateCommitmentViews(client);
    return outcome;
  }, [analyticsConsent, client, recordAnalytics, state.persisted]);

  const backToComposer = useCallback(() => {
    abandonAnalysis();
    dispatch({ type: 'backToComposer' });
  }, [abandonAnalysis]);
  const close = useCallback(() => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    abandonAnalysis();
    dispatch({ type: 'reset' });
  }, [abandonAnalysis]);

  const dictate = useCallback((text: string, final: boolean, alternatives: readonly string[] = []) => {
    dispatch(final ? { type: 'dictationFinished', text, alternatives } : { type: 'dictationChanged', text });
  }, []);
  const chooseAlternative = useCallback((text: string) => dispatch({ type: 'alternativeChosen', text }), []);
  const adoptCurrent = useCallback((proposal: CaptureProposal) => dispatch({ type: 'proposalReplaced', proposal }), []);

  const editPoint = useCallback(async (target: CaptureProposalEdit['target'], change: CaptureProposalEdit['change']): Promise<EditOutcome> => {
    const proposal = state.proposal;
    const conversationId = state.conversationId;
    if (!proposal || proposal.revision === undefined || !conversationId) return { ok: false, reason: 'unavailable' };
    // Fold this item's staged card title and time into the same patch, so
    // nothing the person did on the card is lost behind the summary edit.
    const itemId = 'itemId' in target ? target.itemId : undefined;
    const staged = itemId ? state.edits[itemId] : undefined;
    const finalKind = change.kind ?? ('itemId' in target ? 'commitment' : undefined);
    const patch: CaptureProposalEdit['change'] = { ...change };
    if (staged?.title !== undefined && patch.text === undefined && patch.rejectCorrectionIds === undefined) patch.text = staged.title;
    if (staged?.localDateTime !== undefined && patch.time === undefined && finalKind === 'commitment' && patch.rejectCorrectionIds === undefined) {
      const at = staged.localDateTime ? instantForLocalDateTime(staged.localDateTime, timezone) : null;
      patch.time = { at: at ? at.toISOString() : null, timeZone: timezone };
    }
    const generation = analysisGeneration.current;
    try {
      const answer = await chat.mutateAsync({
        conversationId,
        edit: { proposalId: proposal.proposalId, revision: proposal.revision, target, change: patch },
      });
      if (generation !== analysisGeneration.current) return { ok: false, reason: 'failed' };
      dispatch({ type: 'editAnswered', answer, ...(itemId && staged ? { folded: itemId } : {}) });
      return { ok: true };
    } catch (error) {
      if (generation !== analysisGeneration.current) return { ok: false, reason: 'failed' };
      if (error instanceof ProposalChangedError && error.current.kind === 'chat') {
        dispatch({ type: 'editAnswered', answer: error.current.answer });
        return { ok: false, reason: 'changed' };
      }
      // The conversation is gone: an edit is never sent again into a new one.
      if (error instanceof ConversationNotFoundError) return { ok: false, reason: 'ended' };
      return { ok: false, reason: 'failed' };
    }
  }, [chat, state.proposal, state.conversationId, state.edits, timezone]);

  const acceptUnderstood = useCallback(() => dispatch({ type: 'understoodAccepted' }), []);
  const reopenUnderstood = useCallback(() => dispatch({ type: 'understoodReopened' }), []);
  const value = useMemo<CaptureContextValue>(() => ({
    state, open, setText, analyze, dismissFailure, startOver, adoptProposal, toggleItem, selectAll, deselectAll, editItem, setWeekly, setGoalLink, clarify, confirm, undo, backToComposer, acceptUnderstood, reopenUnderstood, close,
    dictate, chooseAlternative, editPoint, adoptCurrent,
  }), [state, open, setText, analyze, dismissFailure, startOver, adoptProposal, toggleItem, selectAll, deselectAll, editItem, setWeekly, setGoalLink, clarify, confirm, undo, backToComposer, acceptUnderstood, reopenUnderstood, close,
    dictate, chooseAlternative, editPoint, adoptCurrent]);

  return <CaptureContext.Provider value={value}>{children}</CaptureContext.Provider>;
}

export function useCaptureFlow(): CaptureContextValue {
  const value = useContext(CaptureContext);
  if (!value) throw new Error('useCaptureFlow must be used inside a CaptureProvider');
  return value;
}
