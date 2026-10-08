import { apiRequest } from '../client';
import type { Locale } from '../../i18n/locale';
import {
  captureChatSchema,
  captureConfirmationSchema,
  captureProposalResponseSchema,
  type CaptureChatAnswer,
  type CaptureConfirmation,
  type CaptureEntry,
  type CaptureProposal,
  type HabitCadence,
  type HabitPreferredWindow,
  captureKindsSchema,
} from '../schemas/capture';

/**
 * Capture is two calls on purpose. The first proposes and persists nothing;
 * the second is the user saying yes. There is no client-side shortcut between
 * them, and no retry wrapped around the confirm.
 */

/**
 * Answers the one clarification on one item (UC-2.5, #165).
 *
 * The response is the whole updated proposal, not an acknowledgement: the
 * item's time, title and `needsClarification` may all have changed, and the
 * review screen has to show what it will actually confirm.
 *
 * Never retried. An answer is a decision about somebody's commitment, and a
 * replay of one the user is no longer looking at is the failure #157 forbids
 * for the confirm for the same reason.
 */
export function clarifyCapture(input: {
  proposalId: string;
  itemId: string;
  questionId: string;
  optionId?: string;
  freeText?: string;
  timezone: string;
  /** The proposal revision on screen (M2b); a 409 `proposal_changed` if it moved on. */
  revision?: number;
}): Promise<CaptureProposal> {
  return apiRequest('POST', '/api/mobile/capture/clarify', {
    body: {
      proposalId: input.proposalId,
      ...(input.revision !== undefined ? { revision: input.revision } : {}),
      itemId: input.itemId,
      questionId: input.questionId,
      timezone: input.timezone,
      referenceTime: new Date().toISOString(),
      ...(input.optionId ? { optionId: input.optionId } : {}),
      ...(input.freeText ? { freeText: input.freeText } : {}),
    },
    schema: captureProposalResponseSchema,
  });
}

export function proposeCapture(input: {
  text: string;
  timezone: string;
  referenceTime?: string;
  /**
   * The app's UI language (owner request 2026-09-30): the server's model
   * titles what it proposes in it, whatever language the text is in.
   */
  locale?: Locale;
  signal?: AbortSignal;
}): Promise<CaptureProposal> {
  return apiRequest('POST', '/api/mobile/capture', {
    body: {
      text: input.text,
      timezone: input.timezone,
      referenceTime: input.referenceTime ?? new Date().toISOString(),
      ...(input.locale ? { locale: input.locale } : {}),
    },
    schema: captureProposalResponseSchema,
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

/**
 * One message to the capture chat «احكيها» (owner decision 2026-09-30).
 *
 * No `conversationId` starts a conversation; the answer names the one to send
 * next. Nothing is saved by this call — the proposal in the answer is saved
 * only by `confirmCapture`, when the person presses confirm.
 *
 * Not retried here, and never by the query layer (`retry: false` on every
 * mutation): a message is somebody's words, and sending it twice would put
 * the same sentence in the conversation twice. The one recovery the flow
 * makes — a `ConversationNotFoundError` restarts with the same message, once —
 * is the caller's, in `captureFlowActions.chatTurn`, where it can be read.
 */
/** A structured change to one point of the conversation's current proposal (M2b, CONTRACT v4). */
export interface CaptureProposalEdit {
  proposalId: string;
  revision: number;
  /** The point, by its family id (M3b: four families). */
  target: { itemId: string } | { seedItemId: string } | { habitItemId: string } | { goalItemId: string };
  change: {
    kind?: 'commitment' | 'possible_goal' | 'consideration' | 'idea' | 'waiting_for' | 'habit' | 'goal';
    text?: string;
    /** A habit's rhythm, length and time of day (M3b); only on a habit. */
    cadence?: HabitCadence;
    durationMinutes?: number;
    preferredWindow?: HabitPreferredWindow | null;
    time?: { at: string | null; timeZone: string };
    rejectCorrectionIds?: string[];
    /** Bring back a point a later message took off the list (contract v5); alone, never with another field. */
    restore?: true;
  };
}

/**
 * What the chat is sent: a new message, or a structured edit — never both
 * (M2b). One shape with optional parts, so callers and tests read `message`
 * without narrowing; `edit` decides which request goes.
 */
export type CaptureChatInput = {
  conversationId: string | null;
  message?: string;
  spoken?: boolean;
  edit?: CaptureProposalEdit;
  /**
   * Where the chat was opened from (M3b): sent with a message, and only when
   * the capability probe said the server takes it. The server keeps the first
   * turn's entry for the whole conversation.
   */
  entry?: CaptureEntry;
};

export function chatCapture(input: CaptureChatInput & {
  timezone: string;
  referenceTime?: string;
  /** The app's UI language: the reply and the titles are in it (owner request 2026-09-30). */
  locale?: Locale;
}): Promise<CaptureChatAnswer> {
  return apiRequest('POST', '/api/mobile/capture/chat', {
    body: {
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      // Only the words the person could see go: never an alternative they did
      // not pick (M2b). `spoken` says they came from dictation.
      ...(input.edit ? { edit: input.edit } : {
        message: input.message ?? '', ...(input.spoken ? { spoken: true } : {}), ...(input.entry ? { entry: input.entry } : {}),
      }),
      timezone: input.timezone,
      referenceTime: input.referenceTime ?? new Date().toISOString(),
      ...(input.locale ? { locale: input.locale } : {}),
    },
    schema: captureChatSchema,
  });
}

/**
 * Confirms the items the user selected.
 *
 * Two things this deliberately does **not** do:
 *
 *  - it does not retry. A confirm that may or may not have landed must not be
 *    replayed without the user present (#157), and the server's idempotency
 *    key is keyed to the proposal, not to a client attempt counter;
 *  - it does not treat a 200 as success on its own. Before #252 a confirm that
 *    persisted nothing still answered 200, and no client could tell. The
 *    server now answers 404 or 400 for that case — which this client surfaces
 *    — and `success` in the body is checked as well, so a regression on either
 *    side is caught rather than swallowed.
 */
export async function confirmCapture(input: {
  proposalId: string;
  itemIds: string[];
  /**
   * Changes the user made in review, applied in the same write (UC-2.4, #164).
   *
   * Not a PATCH afterwards: that leaves them holding a commitment with a title
   * they already changed for as long as the second request takes, and
   * permanently if it fails.
   */
  edits?: { itemId: string; title?: string; resolvedTime?: string | null; priority?: 'high' | 'normal' | 'low' }[];
  /**
   * The selected items the person chose to keep as a weekly fixed block
   * («كل أسبوع»). Only these become a block; every other selected item — one
   * with the offer included — confirms as the one-off it also is. Sent only
   * when non-empty, so a confirm with no weekly choice is byte-for-byte the
   * one an older app sends.
   */
  weeklyBlockItemIds?: string[];
  /**
   * The selected items whose suggested goal link («مرتبط بهدف …») the person
   * kept. Sent only when non-empty; an older server ignores it.
   */
  goalLinkItemIds?: string[];
  idempotencyKey?: string;
  /** The proposal revision the person confirmed (M2b): what was seen is what is saved. */
  revision?: number;
  /**
   * The other families saved by the same confirm (M3b): habits, goals, and —
   * only from the thought entry — thoughts, each by its family id. Sent when
   * given (`confirmPayload` gives them only for a v8 proposal), so a confirm
   * of an older proposal is the one an older app sends.
   */
  selectedHabitItemIds?: string[];
  selectedGoalItemIds?: string[];
  selectedSeedItemIds?: string[];
}): Promise<CaptureConfirmation> {
  const result = await apiRequest('POST', '/api/mobile/capture/confirm', {
    body: {
      proposalId: input.proposalId,
      itemIds: input.itemIds,
      ...(input.edits?.length ? { edits: input.edits } : {}),
      ...(input.weeklyBlockItemIds?.length ? { weeklyBlockItemIds: input.weeklyBlockItemIds } : {}),
      ...(input.goalLinkItemIds?.length ? { goalLinkItemIds: input.goalLinkItemIds } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.revision !== undefined ? { revision: input.revision } : {}),
      ...(input.selectedHabitItemIds ? { selectedHabitItemIds: input.selectedHabitItemIds } : {}),
      ...(input.selectedGoalItemIds ? { selectedGoalItemIds: input.selectedGoalItemIds } : {}),
      ...(input.selectedSeedItemIds ? { selectedSeedItemIds: input.selectedSeedItemIds } : {}),
    },
    schema: captureConfirmationSchema,
  });
  return result;
}

/**
 * Which entries the server offers (M3b, R004): `GET /api/mobile/capture/kinds`.
 * 200 lists them (goal only when goals can be written); a switched-off feature
 * answers 404 `feature_unavailable`, which the client turns into a
 * `FeatureUnavailableError`, and the pages keep their old paths.
 */
export async function getCaptureKinds(): Promise<CaptureEntry[]> {
  const result = await apiRequest('GET', '/api/mobile/capture/kinds', { schema: captureKindsSchema });
  return result.entries;
}
