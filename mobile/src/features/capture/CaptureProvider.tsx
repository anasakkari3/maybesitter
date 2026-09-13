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
import { useCapture, useConfirmCapture, useAiConsentGranted } from '../../api/queries';
import { deleteCommitment } from '../../api/endpoints/commitments';
import { isRetryable, ValidationError } from '../../api/errors';
import {
  captureReducer,
  confirmPayload,
  initialCaptureState,
  UNDO_WINDOW_MS,
  type CaptureInputMode,
  type CaptureItemEdit,
  type CaptureSource,
  type CaptureState,
} from './captureMachine';
import {
  analyzeCapture,
  confirmCapture as runConfirm,
  undoCapture,
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
  toggleItem(itemId: string): void;
  editItem(itemId: string, edit: CaptureItemEdit): void;
  confirm(): Promise<void>;
  undo(): Promise<UndoOutcome>;
  backToComposer(): void;
  close(): void;
}

const CaptureContext = createContext<CaptureContextValue | null>(null);

/**
 * Which failure the user is looking at.
 *
 * A 400 is the server refusing the input and will refuse it again, so it is a
 * validation state with no Retry. Anything retryable is the network. Everything
 * else is the extractor having answered but not been able to read the message —
 * three different messages and three different recoveries.
 */
function failureKind(error: unknown): 'network' | 'validation' | 'extraction' {
  if (error instanceof ValidationError) return 'validation';
  return isRetryable(error) ? 'network' : 'extraction';
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
  const { granted: aiGranted, asked: aiAsked } = useAiConsentGranted();
  const client = useQueryClient();
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
      failureKind,
    );
    dispatch(outcome.ok
      ? { type: 'analyzeSucceeded', proposal: outcome.proposal }
      : { type: 'analyzeFailed', kind: outcome.kind });
  }, [capture, state.text]);

  const toggleItem = useCallback((itemId: string) => dispatch({ type: 'toggleItem', itemId }), []);
  const editItem = useCallback((itemId: string, edit: CaptureItemEdit) => dispatch({ type: 'editItem', itemId, edit }), []);

  const confirm = useCallback(async () => {
    if (confirmPayload(state).itemIds.length === 0) return;
    dispatch({ type: 'confirmStarted' });
    const outcome = await runConfirm(
      // The edits are held but not yet sent: the atomic confirm that carries
      // them is UC-2.4 (#164). Nothing here applies them after the fact.
      { confirm: ({ proposalId, itemIds }) => confirmCapture.mutateAsync({ proposalId, itemIds }) },
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
  }, [client, confirmCapture, state]);

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
    // Whatever happened, the lists are now wrong until they refetch.
    await invalidateCommitmentViews(client);
    return outcome;
  }, [client, state.persisted]);

  const backToComposer = useCallback(() => dispatch({ type: 'backToComposer' }), []);
  const close = useCallback(() => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    dispatch({ type: 'reset' });
  }, []);

  const value = useMemo<CaptureContextValue>(() => ({
    state, aiGranted, aiAsked, open, setText, analyze, toggleItem, editItem, confirm, undo, backToComposer, close,
  }), [state, aiGranted, aiAsked, open, setText, analyze, toggleItem, editItem, confirm, undo, backToComposer, close]);

  return <CaptureContext.Provider value={value}>{children}</CaptureContext.Provider>;
}

export function useCaptureFlow(): CaptureContextValue {
  const value = useContext(CaptureContext);
  if (!value) throw new Error('useCaptureFlow must be used inside a CaptureProvider');
  return value;
}
