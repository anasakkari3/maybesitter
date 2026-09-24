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
  useCapture,
  useClarifyCapture,
  useConfirmCapture,
  useAiConsentGranted,
  useRecordAnalytics,
} from '../../api/queries';
import { useTimeZone } from '../../i18n/timezone';
import { deleteCommitment } from '../../api/endpoints/commitments';
import { InputTooLargeError, isRetryable, QuotaExceededError, ValidationError } from '../../api/errors';
import { userFacingMessageKey } from '../../api/ui/userFacingMessage';
import type { CaptureProposal } from '../../api/schemas/capture';
import {
  captureReducer,
  confirmPayload,
  initialCaptureState,
  UNDO_WINDOW_MS,
  type CaptureFailureKind,
  type CaptureInputMode,
  type CaptureItemEdit,
  type CaptureSource,
  type CaptureState,
} from './captureMachine';
import { toServerEdits } from './editPayload';
import {
  analyzeCapture,
  confirmCapture as runConfirm,
  reportCaptureUndone,
  undoCapture,
  type AnalyzeFailure,
  type UndoOutcome,
} from './captureFlowActions';

export type { UndoOutcome };

interface CaptureContextValue {
  state: CaptureState;
  /** True when the account has agreed to AI processing. Display only. */
  aiGranted: boolean;
  /** True when the question has never been put to them. */
  aiAsked: boolean;
  open(source?: CaptureSource, inputMode?: CaptureInputMode): void;
  setText(text: string): void;
  analyze(): Promise<void>;
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
  adoptProposal(proposal: CaptureProposal, source?: CaptureSource): void;
  toggleItem(itemId: string): void;
  selectAll(): void;
  deselectAll(): void;
  editItem(itemId: string, edit: CaptureItemEdit): void;
  /**
   * Answers the one question on one item (UC-2.5, #165).
   *
   * The server returns the whole updated proposal and it replaces the one held
   * here, so the review screen shows what it will actually confirm. A failure
   * leaves the proposal as it was and reports it, rather than clearing the
   * question and pretending the answer landed.
   */
  clarify(itemId: string, answer: { optionId?: string; freeText?: string }): Promise<boolean>;
  confirm(): Promise<void>;
  undo(): Promise<UndoOutcome>;
  backToComposer(): void;
  close(): void;
}

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
  const capture = useCapture();
  const confirmCapture = useConfirmCapture();
  const clarifyCapture = useClarifyCapture();
  const { granted: aiGranted, asked: aiAsked } = useAiConsentGranted();
  const analyticsConsent = useAnalyticsConsent();
  const recordAnalytics = useRecordAnalytics();
  const client = useQueryClient();
  const timezone = useTimeZone();
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The timer is cleared on unmount, so leaving the flow cannot leave Undo
  // armed against a screen that is gone.
  useEffect(() => () => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
  }, []);

  const open = useCallback((source?: CaptureSource, inputMode?: CaptureInputMode) => {
    dispatch({ type: 'open', ...(source ? { source } : {}), ...(inputMode ? { inputMode } : {}) });
  }, []);

  const setText = useCallback((text: string) => dispatch({ type: 'textChanged', text }), []);

  const analyze = useCallback(async () => {
    dispatch({ type: 'analyzeStarted' });
    // The zone and the reference time come from the hook (#162 step 4): the
    // server resolves every relative phrase against them.
    const outcome = await analyzeCapture(
      { propose: (text) => capture.mutateAsync(text) },
      state.text,
      classifyFailure,
    );
    dispatch(outcome.ok
      ? { type: 'analyzeSucceeded', proposal: outcome.proposal }
      : { type: 'analyzeFailed', kind: outcome.kind, messageKey: outcome.messageKey });
  }, [capture, state.text]);

  const adoptProposal = useCallback((proposal: CaptureProposal, source: CaptureSource = 'share') => {
    // `open` first, so nothing of a previous capture — a draft, a selection, an
    // armed undo — is still in the state the shared proposal lands in.
    dispatch({ type: 'open', source });
    dispatch({ type: 'analyzeSucceeded', proposal });
  }, []);

  const toggleItem = useCallback((itemId: string) => dispatch({ type: 'toggleItem', itemId }), []);
  const selectAll = useCallback(() => dispatch({ type: 'selectAll' }), []);
  const deselectAll = useCallback(() => dispatch({ type: 'deselectAll' }), []);

  const clarify = useCallback(async (itemId: string, answer: { optionId?: string; freeText?: string }) => {
    const proposal = state.proposal;
    const question = proposal?.items.find((item) => item.itemId === itemId)?.clarification;
    if (!proposal || !question) return false;
    try {
      const updated = await clarifyCapture.mutateAsync({
        proposalId: proposal.proposalId,
        itemId,
        questionId: question.questionId,
        ...(answer.optionId ? { optionId: answer.optionId } : {}),
        ...(answer.freeText ? { freeText: answer.freeText } : {}),
      });
      // The whole proposal, so `needsClarification`, the title and the time all
      // move together. Patching one field here is how the three drift apart.
      // `clarified`, not `analyzeSucceeded`: the other items keep their
      // selection and edits (#474).
      dispatch({ type: 'clarified', proposal: updated });
      return true;
    } catch {
      // The proposal is untouched. The screen keeps the question rather than
      // clearing it, because an unanswered question is the honest state.
      return false;
    }
  }, [clarifyCapture, state.proposal]);
  const editItem = useCallback((itemId: string, edit: CaptureItemEdit) => dispatch({ type: 'editItem', itemId, edit }), []);

  const confirm = useCallback(async () => {
    if (confirmPayload(state).itemIds.length === 0) return;
    dispatch({ type: 'confirmStarted' });
    const outcome = await runConfirm(
      // The edits travel with the confirm (UC-2.4, #164), never as a PATCH
      // afterwards: what the user saw when they pressed confirm is what gets
      // written, or nothing is.
      {
        confirm: ({ proposalId, itemIds, edits }) => confirmCapture.mutateAsync({
          proposalId,
          itemIds,
          edits: toServerEdits(edits, timezone),
        }),
      },
      state,
    );
    if (!outcome) return;
    if (!outcome.ok) {
      dispatch({ type: 'confirmFailed', reason: outcome.reason });
      return;
    }
    dispatch({ type: 'confirmSucceeded', confirmation: outcome.confirmation });
    // The lists have a new row in them now.
    await invalidateCommitmentViews(client);
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

  const backToComposer = useCallback(() => dispatch({ type: 'backToComposer' }), []);
  const close = useCallback(() => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    dispatch({ type: 'reset' });
  }, []);

  const value = useMemo<CaptureContextValue>(() => ({
    state, aiGranted, aiAsked, open, setText, analyze, adoptProposal, toggleItem, selectAll, deselectAll, editItem, clarify, confirm, undo, backToComposer, close,
  }), [state, aiGranted, aiAsked, open, setText, analyze, adoptProposal, toggleItem, selectAll, deselectAll, editItem, clarify, confirm, undo, backToComposer, close]);

  return <CaptureContext.Provider value={value}>{children}</CaptureContext.Provider>;
}

export function useCaptureFlow(): CaptureContextValue {
  const value = useContext(CaptureContext);
  if (!value) throw new Error('useCaptureFlow must be used inside a CaptureProvider');
  return value;
}
