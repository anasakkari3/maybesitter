import { useClarityStage, useReplayEvent } from '../../clarity/ClarityProvider';
import React, { useEffect, useRef } from 'react';
import { useApp } from '../../state/AppContext';
import { CaptureScreen } from '../../screens/CaptureScreen';
import { ReviewScreen } from '../../screens/ReviewScreen';
import { SavedScreen } from '../../screens/SavedScreen';
import { useCaptureFlow } from './CaptureProvider';
import { chatSaves } from './captureMachine';

/**
 * Which capture screen is showing (UC-2.R2, #172).
 *
 * ── The status is the screen ─────────────────────────────────────
 *
 * `AppContext` used to hold a separate `screen: 'capture' | 'review' | 'saved'`
 * alongside a `cap` sub-state, and every transition had to move both. They
 * could disagree — and did, since the mock flow set them from different
 * actions — which is how a screen ends up rendering a proposal that is no
 * longer there.
 *
 * There is one source of truth now: the reducer's status. Root renders this for
 * `screen === 'capture'`, and which of the three appears is derived, not
 * stored. `review` and `saved` are gone from the `Screen` union for the same
 * reason: a state nobody can set wrongly is a state nobody can set wrongly.
 *
 * `needsClarification` shows the review screen deliberately — the items are
 * there and visible, each flagged with its question. UC-2.5 (#165) adds the
 * sheet that answers one; until then a user can still see what was proposed
 * rather than facing a dead end.
 */
export function CaptureFlow() {
  const { s } = useApp();
  const flow = useCaptureFlow();
  const { state } = flow;
  const opened = useRef(false);
  const replayEvent = useReplayEvent();
  useEffect(() => {
    if (state.status === 'saved') replayEvent('capture_saved');
  }, [state.status, replayEvent]);
  // A save in the chat, which stays open (owner request 2026-09-30), is a
  // capture saved all the same.
  const saves = chatSaves(state);
  useEffect(() => {
    if (saves > 0) replayEvent('capture_saved');
  }, [saves, replayEvent]);
  useClarityStage(state.status === 'saved' ? 'capture_saved'
    : ['needsConfirmation', 'needsClarification', 'unresolvedIntent', 'confirming', 'confirmFailed'].includes(state.status)
      ? 'capture_review' : 'capture_input');

  // Once, on entry. `actions` is rebuilt every render, so an effect depending
  // on it and dispatching would re-fire forever; and re-opening on every render
  // would discard whatever the user had typed.
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    // A proposal that was already there when this mounted did not come from
    // this screen: the share pipeline analyses on its own screen and hands the
    // result over with `adoptProposal`, which has already called `open` with
    // `source: 'share'` (UC-3.0, #183). `open` resets the reducer, so doing it
    // again here would discard the proposal between the hand-over and the first
    // paint — and the user would land on an empty composer.
    if (flow.state.proposal) return;
    // Back from a screen opened over the flow is the same capture showing
    // again, not a new one: `open` would wipe the draft — and the
    // conversation — the person left for a moment.
    if (s.taskResumed) return;
    // Back closed capture and kept the conversation (M2b, condition 9): a
    // chat, its saves or an unsent draft are still here when it opens again.
    // Only «ابدأ من جديد» / «إلغاء الكل» or a different account start fresh.
    const { conversationId, turns, earlier, text } = flow.state;
    if (conversationId !== null || turns.length > 0 || text.trim()) return;
    if (earlier.length > 0) {
      // An ended conversation (its saves above) is kept, but a page opens the
      // chat for its own kind (M3b, D1): from another entry page it starts
      // fresh with that entry, and the plain chat drops the last page's hint.
      // Nothing in progress is ever discarded for this.
      if (s.captureEntry !== null && s.captureEntry !== flow.state.entry) flow.open(s.captureSource, s.captureInput, s.captureEntry);
      else if (s.captureEntry === null && flow.state.entry !== null) flow.forgetEntry();
      return;
    }
    flow.open(s.captureSource, s.captureInput, s.captureEntry);
  }, [flow, s.captureSource, s.captureInput, s.captureEntry, s.taskResumed]);

  switch (state.status) {
    case 'needsConfirmation':
    case 'needsClarification':
    // A capture that named only a maybe (#519). Review, because that is where
    // the person is asked what to keep — and it is the same screen, so a
    // capture that named both a commitment and a maybe does not split across
    // two.
    case 'unresolvedIntent':
    case 'confirming':
    case 'confirmFailed':
      return state.source === 'share' || state.source === 'meeting'
        ? <ReviewScreen /> : <CaptureScreen />;
    case 'saved':
      return <SavedScreen />;
    default:
      // idle, editing, analyzing, noCommitment, and the three failures. The
      // composer owns them because each one either takes the user back to the
      // text they wrote or is about that text.
      return <CaptureScreen />;
  }
}
