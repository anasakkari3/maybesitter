/**
 * The capture flow, as a pure reducer (UC-2.R2, #172).
 *
 * Every transition the flow can make lives here, with no React, no navigation
 * and no network. That is what makes the invariants testable as arithmetic
 * rather than as a screen: "nothing is committed before confirm" is a statement
 * about which actions can produce `persisted`, and this file is where it can be
 * read off.
 *
 * ── Why a reducer and not component state ────────────────────────
 *
 * The flow has fourteen states and several of them look alike from the outside
 * — `analyzing` and `confirming` are both spinners, `networkError` and
 * `extractionFailed` are both "try again". Spread across three screens as
 * booleans, the combinations that cannot happen become combinations nobody
 * checked. Here they cannot be constructed.
 *
 * ── The draft never touches disk ─────────────────────────────────
 *
 * There is no serialization in this file and no storage import. A half-written
 * capture is the most sensitive text the product ever holds — it is whatever
 * the user was about to commit to, before they decided whether to — and it
 * lives in memory for exactly as long as the flow does. #172's acceptance
 * criteria require this, and `captureMachine.test.ts` asserts the module graph
 * pulls in no storage.
 */
import type { CaptureChatAnswer, CaptureChatTurn, CaptureProposal, CaptureConfirmation } from '../../api/schemas/capture';
import type { UserFacingKey } from '../../api/ui/userFacingMessage';
import type { LocationTrigger } from '../../api/schemas/common';

/**
 * Where the flow is.
 *
 * Ported from the archived Flutter controller's status list, which had been
 * through real use — the distinctions in it are ones the UI genuinely needs,
 * and collapsing them would lose the difference between "the model could not
 * read this" and "the network is down", which are different messages and
 * different recoveries.
 */
export type CaptureStatus =
  /** Nothing typed yet. */
  | 'idle'
  /** The user is typing or has a transcript in the field. */
  | 'editing'
  /** A message to the chat (`POST /api/mobile/capture/chat`) in flight. */
  | 'analyzing'
  /** A proposal came back with at least one item to confirm. */
  | 'needsConfirmation'
  /** Every item needs a question answered before it can be confirmed (#165). */
  | 'needsClarification'
  /** The message named no commitment. Nothing was created (#166). */
  | 'noCommitment'
  /**
   * The message named something the person is considering or waiting on, and
   * no commitment (#519).
   *
   * Its own status rather than `noCommitment`, because the two owe the person
   * different things. `noCommitment` shows one neutral line and is finished;
   * this one has something to offer, and Review has to offer it — with nothing
   * saved unless they tap Keep.
   */
  | 'unresolvedIntent'
  /** The request is one the product does not do. */
  | 'unsupportedRequest'
  /** The server refused the input itself. */
  | 'validationError'
  /** Offline, or the request never arrived. */
  | 'networkError'
  /** The server answered, but could not read the message. */
  | 'extractionFailed'
  /**
   * The server declined to do the work at all: the AI quota is spent, or the
   * text is longer than a model call may carry (UC-4.5, #181).
   *
   * Its own status rather than one of the three above, because none of them is
   * true: the network is fine, the input is not malformed, and the extractor
   * never ran. It carries no Retry — pressing one against a spent quota is the
   * loop the quota exists to stop — and the text survives in `text`, so Back
   * returns the person to the composer with what they wrote still in it.
   */
  | 'refused'
  /** `POST /api/mobile/capture/confirm` in flight. */
  | 'confirming'
  /** Confirmed. `persisted` is what the server actually saved. */
  | 'saved'
  /** The confirm failed. The proposal is still there to retry. */
  | 'confirmFailed';

/**
 * How the flow was entered. `widget` and `share` arrive by deep link; only
 * `tab` and `notification` come from inside the app.
 */
/** `meeting`: a proposal «حضّرني» made (CL5a), handed to review like a share's. */
export type CaptureSource = 'tab' | 'widget' | 'share' | 'notification' | 'meeting';

/** How an analyze failed, before it becomes a status. */
export type CaptureFailureKind = 'network' | 'validation' | 'extraction' | 'refused';

/**
 * What «حضّرني» said about the proposal it handed to review (CL5a).
 *
 * Only what the review shows: whether the prep step's reminder was moved (out
 * of quiet hours, or because the meeting is close), and to when, or why none
 * will ring; and whether the thing prepared for is an appointment rather than
 * a meeting. Never the notes.
 */
export interface MeetingReviewContext {
  /** When the phone first rings for the prep step, after any move; null when nothing rings. */
  readonly remindAt: string | null;
  /** Why nothing rings, when nothing does. */
  readonly silentBecause: 'reminders_off' | 'silent_choice' | 'quiet_hours' | 'too_close' | null;
  readonly adjustment: 'none' | 'short_notice' | 'quiet_hours' | 'quiet_hours_unavoidable';
  readonly appointment: boolean;
  /** The prep step's item and the meeting's start, so Review can answer again after an edit (FX1). */
  readonly itemId?: string;
  readonly startAt?: string;
}

/** Which input the user was offered first. */
export type CaptureInputMode = 'text' | 'voice';

/**
 * An edit the user made in review, before anything was saved.
 *
 * Held here and applied at confirm — never afterwards. #172's original plan was
 * a `PATCH /commitments/:id {title}` after the confirm landed, which meant the
 * user briefly had a commitment with a title they had already changed, and a
 * failed PATCH left it that way permanently. UC-2.4 (#164) replaces that with
 * an atomic confirm that carries the edits, and this is the shape it consumes.
 *
 * Empty until #164 lands: this file keeps the slot so that the reducer, the
 * selection logic and the confirm payload do not have to be rewritten when it
 * does, and so nothing in the meantime invents a temporary mechanism that would
 * have to be removed again.
 */
export interface CaptureItemEdit {
  title?: string;
  /**
   * Local wall clock, `YYYY-MM-DDTHH:mm`, resolved in the device zone.
   *
   * The empty string is the "No time" switch — a change the user made, not an
   * absent value, and the two have to be distinguishable.
   */
  localDateTime?: string;
  priority?: 'high' | 'normal' | 'low';
  /**
   * The place reminder chosen for this card (closure CL4), or `null` once it
   * was removed — edits merge, so a removal has to be a value. No coordinates:
   * see `LocationTrigger`.
   */
  locationTrigger?: LocationTrigger | null;
}

export interface CaptureState {
  status: CaptureStatus;
  source: CaptureSource;
  inputMode: CaptureInputMode;
  /** Set only when «حضّرني» opened this review (`source: 'meeting'`). */
  meeting?: MeetingReviewContext;
  /** What the user typed or dictated. The only copy, and it is in memory. */
  text: string;
  /** The server's proposal. Null until one comes back. */
  proposal: CaptureProposal | null;
  /**
   * The original proposal, kept beside any edits.
   *
   * #164 needs to show what changed and to send the edits against the shape
   * they were made on. Keeping one mutable copy would make "what did the user
   * actually see when they confirmed" unanswerable.
   */
  original: CaptureProposal | null;
  /** Item ids the user has selected. Everything confirmable starts selected. */
  selected: string[];
  /** Edits by item id, applied atomically at confirm (#164). */
  edits: Record<string, CaptureItemEdit>;
  /** What the server reported saved. Only ever set from its response. */
  persisted: CaptureConfirmation['persisted'];
  /** What the server refused, with its reason. Never presented as saved. */
  failed: CaptureConfirmation['failed'];
  /**
   * What the saved items land on top of, as the server computed it (football
   * fixtures, final review C2). The server warns and still saves; this is how
   * the warning reaches the person who just saved.
   */
  collisions: NonNullable<CaptureConfirmation['collisions']>;
  /** A machine-readable reason for an error status, for the copy to map. */
  errorReason: string | null;
  /**
   * Which line the failed analyze should show, as a locale key (#181).
   *
   * A key and not a message: the words are looked up at render time, so
   * switching language while an error is on screen re-renders it in the new
   * one. It comes from `userFacingMessageKey`, which is the product's only
   * copy table for a failure — the composer used to keep its own three-branch
   * copy beside it, and a quota refusal fell through it as "something went
   * wrong" in every locale.
   */
  messageKey: UserFacingKey | null;
  /** True while the undo window is open. */
  undoable: boolean;
  /**
   * Items carrying a weekly-block offer that the person set to «مرة وحدة بس».
   *
   * Stored as the exceptions, not the choices: an offered item is weekly until
   * somebody says otherwise, and nothing about it is saved before the confirm.
   * Cleared by every new analysis.
   */
  onceOnly: string[];
  /** The weekly blocks the confirm made, straight from the server's answer. */
  weeklySaved: NonNullable<CaptureConfirmation['weeklyBlocks']>;
  /**
   * The capture chat's conversation, as the server named it (owner decision
   * 2026-09-30). Null until the first answer; the next message carries it.
   * Memory only, like the draft: a closed capture forgets it.
   */
  conversationId: string | null;
  /**
   * The conversation as the server kept it — the person's messages and the
   * assistant's replies, oldest first. The server's copy, not the phone's
   * memory of what was said: it is bounded there, and it is what the model
   * was shown.
   */
  turns: CaptureChatTurn[];
}

export type CaptureEvent =
  | { type: 'open'; source?: CaptureSource; inputMode?: CaptureInputMode; meeting?: MeetingReviewContext }
  | { type: 'textChanged'; text: string }
  | { type: 'analyzeStarted' }
  | { type: 'analyzeSucceeded'; proposal: CaptureProposal }
  /**
   * The draft sent to the chat. It carries no text of its own — `textChanged`
   * stays the one way words enter the flow — and `text` holds the message
   * until the answer lands.
   */
  | { type: 'chatStarted' }
  /** The chat's answer: its reply, its turns, and the proposal it holds now. */
  | { type: 'chatAnswered'; answer: CaptureChatAnswer }
  /** Back from a failed send to the conversation, with the message still in the field. */
  | { type: 'dismissFailure' }
  /** The server's proposal after one question was answered (#165, #474). */
  | { type: 'clarified'; proposal: CaptureProposal }
  | { type: 'analyzeFailed'; kind: CaptureFailureKind; messageKey?: UserFacingKey; reason?: string }
  | { type: 'toggleItem'; itemId: string }
  | { type: 'selectAll' }
  | { type: 'deselectAll' }
  | { type: 'editItem'; itemId: string; edit: CaptureItemEdit }
  | { type: 'clearEdit'; itemId: string }
  /** «كل أسبوع» (`weekly: true`) or «مرة وحدة بس» on an item with a weekly offer. */
  | { type: 'setWeekly'; itemId: string; weekly: boolean }
  | { type: 'confirmStarted' }
  | { type: 'confirmSucceeded'; confirmation: CaptureConfirmation }
  | { type: 'confirmFailed'; reason?: string; messageKey?: UserFacingKey }
  | { type: 'undoWindowClosed' }
  | { type: 'backToComposer' }
  | { type: 'reset' };

/** The longest capture the backend will read. Its trace truncates at 2000. */
export const MAX_CAPTURE_LENGTH = 2000;
/**
 * The longest title the confirm will accept — `CAPTURE_EDIT_TITLE_MAX` in
 * `src/contracts/v1/captureContracts.ts`, enforced in `applyEdits.ts`.
 *
 * This said 200, and the comment claimed it was what the validator accepts. It
 * was not: the validator has always refused anything over 120. The gap was not
 * an off-by-eighty. One invalid edit fails the *entire* confirm with
 * `invalid_edit`, including the items the person never touched — so a
 * 121-character title was accepted by the field, shown on the card, and then
 * took the whole save down behind a generic line that named no field.
 *
 * `tests/mobile/captureTitleBounds.test.ts` pins this to the contract, so the
 * two cannot drift apart again in silence.
 */
export const MAX_TITLE_LENGTH = 120;
/** How long Undo stays available, in milliseconds. */
export const UNDO_WINDOW_MS = 5_000;

export function initialCaptureState(
  source: CaptureSource = 'tab',
  inputMode: CaptureInputMode = 'text',
): CaptureState {
  return {
    status: 'idle',
    source,
    inputMode,
    text: '',
    proposal: null,
    original: null,
    selected: [],
    edits: {},
    persisted: [],
    failed: [],
    collisions: [],
    errorReason: null,
    messageKey: null,
    undoable: false,
    onceOnly: [],
    weeklySaved: [],
    conversationId: null,
    turns: [],
  };
}

/**
 * Whether the user has answered a flagged item's question themselves (#492).
 *
 * The mirror of the server's rule in `commandsFor()`: a title *and* a time,
 * both supplied by hand, make a clarification item into a commitment. Half an
 * answer does not — a title with no time has nothing to remind anyone about,
 * and the server refuses it either way (`captureAtomicEdits.test.ts`, "a
 * clarification item with only half an answer stays unconfirmable").
 *
 * The empty `localDateTime` is the "No time" switch, which is the absence of a
 * time rather than one, so it does not complete anything.
 */
function completedByHand(edit: CaptureItemEdit | undefined): boolean {
  return Boolean(edit?.title?.trim()) && Boolean(edit?.localDateTime?.trim());
}

/**
 * Which items a user can actually confirm.
 *
 * An item needing clarification is not one of them: it has no resolved time, so
 * confirming it would persist a commitment with nothing to remind anyone about.
 * It becomes selectable once #165's question is answered or #164's manual edit
 * supplies the missing piece.
 *
 * ── Why the edits are read here ──────────────────────────────────
 *
 * "Fill it in yourself in the edit sheet" is what the product offers for a
 * question the user does not want to answer, and the server accepts exactly
 * that at confirm time. Judging confirmability from the proposal alone made
 * the client disagree with the server: the item stayed unselectable, the
 * fallback was unreachable from the app, and the only way out of the screen
 * was Cancel all (#492). One rule, and it is the server's.
 */
/**
 * The proposal statuses whose items can be judged one by one.
 *
 * Exactly the two the server's confirm accepts (`captureBoundaryService.ts`,
 * "proposed or needs_clarification"). The server sends `needs_clarification`
 * whenever *every* item needs a question, so a single flagged item always
 * arrives with it — #492's own repro. Gating the per-item rule on `proposed`
 * alone meant a hand-completed item in that proposal was never evaluated, and
 * the client refused what the server was ready to confirm (#492, reopened).
 *
 * `no_commitment` and `rejected` are terminal: there is nothing to confirm in
 * them however the items were edited.
 */
const ACTIONABLE_PROPOSAL_STATUSES: ReadonlySet<CaptureProposal['status']> = new Set([
  'proposed',
  'needs_clarification',
]);

export function confirmableItems(
  proposal: CaptureProposal | null,
  edits: Record<string, CaptureItemEdit> = {},
): string[] {
  if (!proposal || !ACTIONABLE_PROPOSAL_STATUSES.has(proposal.status)) return [];
  return proposal.items
    .filter((item) => !item.needsClarification || completedByHand(edits[item.itemId]))
    .map((item) => item.itemId);
}

/**
 * Items that start selected when a proposal arrives.
 *
 * For ordinary captures: all confirmable items start selected.
 * For document shares (UC-3.7, #191 Step 6): items with confidence >= 0.7
 * start selected; items with confidence < 0.7 start unselected.
 */
export function defaultSelectedItems(
  proposal: CaptureProposal | null,
  edits: Record<string, CaptureItemEdit> = {},
): string[] {
  if (!proposal) return [];
  const confirmable = confirmableItems(proposal, edits);
  const share = (proposal as { share?: { evidence?: readonly { itemId: string; document?: { confidence?: number } }[] } }).share;
  if (!share || !Array.isArray(share.evidence)) {
    return confirmable;
  }
  const confidenceByItem = new Map<string, number>();
  for (const ev of share.evidence) {
    if (ev?.itemId && ev.document && typeof ev.document.confidence === 'number') {
      confidenceByItem.set(ev.itemId, ev.document.confidence);
    }
  }
  if (confidenceByItem.size === 0) {
    return confirmable;
  }
  return confirmable.filter((id) => {
    const conf = confidenceByItem.get(id);
    return conf === undefined ? true : conf >= 0.7;
  });
}

/**
 * Whether an edit takes the weekly block off the table.
 *
 * The server's own rule (`captureBoundaryService`): a weekly item may carry a
 * new title, and nothing that moves it — no new time, no place reminder,
 * because a block's days and hours are the offer's and change on the block.
 * Sending one would fail the whole confirm with `invalid_edit`, so the card
 * says "once" instead and the confirm asks for the one-off.
 */
function editMovesItem(edit: CaptureItemEdit | undefined): boolean {
  return edit !== undefined && (edit.localDateTime !== undefined || !!edit.locationTrigger);
}

/**
 * «كل أسبوع» (`weekly`), «مرة وحدة بس» (`once`), or `null` for an item the
 * server offered no weekly block for.
 */
export function weeklyChoice(state: CaptureState, itemId: string): 'weekly' | 'once' | null {
  const item = state.proposal?.items.find((candidate) => candidate.itemId === itemId);
  if (!item?.weeklyBlock) return null;
  if (state.onceOnly.includes(itemId) || editMovesItem(state.edits[itemId])) return 'once';
  return 'weekly';
}

/** True when an edit has made «كل أسبوع» impossible for this item. */
export function weeklyLockedByEdit(state: CaptureState, itemId: string): boolean {
  const item = state.proposal?.items.find((candidate) => candidate.itemId === itemId);
  return !!item?.weeklyBlock && editMovesItem(state.edits[itemId]);
}

/** What the confirm request carries. Only the selection, and only its edits. */
export function confirmPayload(state: CaptureState): {
  proposalId: string;
  itemIds: string[];
  edits: Record<string, CaptureItemEdit>;
  /** The selected items kept as weekly blocks; everything else confirms once. */
  weeklyBlockItemIds: string[];
} {
  const itemIds = state.selected.filter((id) => confirmableItems(state.proposal, state.edits).includes(id));
  // Edits for items that are not being confirmed are dropped rather than sent.
  // Sending them would ask the server to validate a change to something the
  // user chose not to save.
  const edits: Record<string, CaptureItemEdit> = {};
  for (const id of itemIds) {
    if (state.edits[id]) edits[id] = state.edits[id];
  }
  const weeklyBlockItemIds = itemIds.filter((id) => weeklyChoice(state, id) === 'weekly');
  return { proposalId: state.proposal?.proposalId ?? '', itemIds, edits, weeklyBlockItemIds };
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((id) => setB.has(id));
}

/** True when the user has something worth a discard confirmation. */
export function hasUnsavedText(state: CaptureState): boolean {
  return state.text.trim().length > 0 && state.status !== 'saved';
}

/**
 * True when the user has something worth a discard confirmation (#504).
 *
 * In the composer: unanalyzed text that would be lost.
 * In review: hand edits or selections modified from the default.
 * Untouched proposals with default selections return false so "Cancel all" closes immediately.
 */
export function wantsDiscardConfirmation(state: CaptureState): boolean {
  if (state.status === 'saved') return false;
  if (state.proposal) {
    // In a conversation, a message typed under the proposal and not sent yet
    // is the person's words too. (Without one, `text` is the sentence the
    // proposal was read from, which Back keeps.)
    if (state.turns.length > 0 && state.text.trim() && state.status !== 'analyzing') return true;
    if (Object.keys(state.edits).length > 0) return true;
    if (state.onceOnly.length > 0) return true;
    const base = state.original ?? state.proposal;
    const defaultSelected = defaultSelectedItems(base);
    return !sameIds(state.selected, defaultSelected);
  }
  return state.text.trim().length > 0;
}


function statusForProposal(proposal: CaptureProposal): CaptureStatus {
  switch (proposal.status) {
    case 'proposed':
      // Every item needing a question is the clarification flow, even though
      // the proposal itself says 'proposed'.
      return confirmableItems(proposal).length > 0 ? 'needsConfirmation' : 'needsClarification';
    case 'needs_clarification':
      return 'needsClarification';
    case 'no_commitment':
      return 'noCommitment';
    case 'unresolved_intent':
      return 'unresolvedIntent';
    case 'rejected':
      return 'unsupportedRequest';
    default:
      return 'extractionFailed';
  }
}

/**
 * The review status a proposal is in once the person's own edits are counted:
 * a flagged item they completed by hand is confirmable (#492, #503).
 */
function reviewStatus(proposal: CaptureProposal, edits: Record<string, CaptureItemEdit>): CaptureStatus {
  const status = statusForProposal(proposal);
  return status === 'needsClarification' && confirmableItems(proposal, edits).length > 0 ? 'needsConfirmation' : status;
}

/** The statuses in which the cards of a proposal are on screen. */
const REVIEWING: ReadonlySet<CaptureStatus> = new Set([
  'needsConfirmation', 'needsClarification', 'unresolvedIntent', 'confirmFailed',
]);

/**
 * What the chat's proposal is on screen: one that is not a refusal and has
 * something to offer — an item to confirm, or a maybe to keep (#519) — or none.
 *
 * Today's server sends `null` itself for a proposal with no items
 * (`captureChatService.shown`), so a maybe named on its own does not reach the
 * chat yet; when it does, it is shown, never dropped here.
 */
export function chatProposalShown(proposal: CaptureProposal | null): CaptureProposal | null {
  if (!proposal || proposal.status === 'rejected') return null;
  return proposal.items.length > 0 || (proposal.seeds?.length ?? 0) > 0 ? proposal : null;
}

/** The facts of an item the server decides; a talk edit changes one of these. */
function sameServerFacts(a: CaptureProposal['items'][number], b: CaptureProposal['items'][number]): boolean {
  return a.title === b.title && a.resolvedTime === b.resolvedTime && (a.resolvedDate ?? null) === (b.resolvedDate ?? null)
    && a.needsClarification === b.needsClarification;
}

/**
 * A follow-up's proposal, with what the person already did to the last one.
 *
 * The rule is by item id, and only the server can keep one: an id that
 * survives names the same item. Its selection survives with it — a card the
 * person took out stays out — and so does its hand edit, but only while the
 * server's facts for that item are unchanged: if they changed, the person just
 * said something about that item, and their newest words win over an older
 * edit made by hand. Everything else — a new id, or the whole proposal new
 * (today's server mints fresh ids every turn) — starts as a new proposal does:
 * every confirmable item selected, no edits, weekly by default.
 */
function carriedInto(state: CaptureState, next: CaptureProposal): Pick<CaptureState, 'selected' | 'edits' | 'onceOnly'> {
  const before = new Map((state.proposal?.items ?? []).map((item) => [item.itemId, item]));
  const wasConfirmable = confirmableItems(state.proposal, state.edits);
  const edits: Record<string, CaptureItemEdit> = {};
  for (const item of next.items) {
    const old = before.get(item.itemId);
    const edit = state.edits[item.itemId];
    if (old && edit && sameServerFacts(old, item)) edits[item.itemId] = edit;
  }
  const defaults = defaultSelectedItems(next, edits);
  const selected = confirmableItems(next, edits).filter((id) =>
    wasConfirmable.includes(id) ? state.selected.includes(id) : defaults.includes(id));
  const onceOnly = state.onceOnly.filter((id) => next.items.some((item) => item.itemId === id && item.weeklyBlock));
  return { selected, edits, onceOnly };
}

export function captureReducer(state: CaptureState, event: CaptureEvent): CaptureState {
  switch (event.type) {
    case 'open': {
      const opened = initialCaptureState(event.source ?? state.source, event.inputMode ?? state.inputMode);
      return event.meeting ? { ...opened, meeting: event.meeting } : opened;
    }

    case 'textChanged': {
      // The message in flight is not a draft; nothing types over it.
      if (state.status === 'analyzing' || state.status === 'confirming') return state;
      // Truncated here rather than refused, so a long paste keeps its beginning
      // instead of silently doing nothing.
      const text = event.text.slice(0, MAX_CAPTURE_LENGTH);
      // Under a proposal the composer is the next message of the conversation:
      // typing it changes nothing about the proposal on screen (#chat).
      if (REVIEWING.has(state.status)) return { ...state, text };
      return { ...state, text, status: text.trim() ? 'editing' : 'idle', errorReason: null, messageKey: null };
    }

    case 'analyzeStarted':
      if (!state.text.trim()) return state;
      return { ...state, status: 'analyzing', errorReason: null, messageKey: null, proposal: null, original: null };

    case 'analyzeSucceeded':
      return {
        ...state,
        status: statusForProposal(event.proposal),
        proposal: event.proposal,
        // The untouched copy, for #164 to diff against.
        original: event.proposal,
        selected: defaultSelectedItems(event.proposal),
        edits: {},
        onceOnly: [],
        errorReason: null,
        messageKey: null,
      };

    case 'chatStarted':
      if (!state.text.trim() || state.status === 'confirming' || state.status === 'analyzing') return state;
      // The proposal and the conversation stay: a failed send goes back to
      // them, and the answer's own proposal replaces this one when it lands.
      return { ...state, status: 'analyzing', errorReason: null, messageKey: null };

    case 'chatAnswered': {
      const { answer } = event;
      const proposal = chatProposalShown(answer.proposal);
      const conversation = {
        ...state,
        // The message is in `turns` now; the field is for the next one.
        text: '',
        conversationId: answer.conversationId,
        turns: answer.turns,
        errorReason: null,
        messageKey: null,
      };
      if (!proposal) {
        return { ...conversation, status: 'idle', proposal: null, original: null, selected: [], edits: {}, onceOnly: [] };
      }
      const carried = carriedInto(state, proposal);
      return { ...conversation, ...carried, status: reviewStatus(proposal, carried.edits), proposal, original: proposal };
    }

    case 'dismissFailure':
      // Back from "that didn't go" to where the person was: the conversation,
      // its proposal with their edits, and the message still in the field.
      return {
        ...state,
        status: state.proposal ? reviewStatus(state.proposal, state.edits) : state.text.trim() ? 'editing' : 'idle',
        errorReason: null,
        messageKey: null,
      };

    case 'clarified': {
      // Answering one question — including "no specific time" (#474) — changes
      // one item. It is not a new analysis, so it must not throw away what the
      // user already chose for the others: their selection and their edits
      // survive. An item the answer made confirmable joins the selection, the
      // same way every confirmable item starts selected.
      if (!state.proposal || event.proposal.proposalId !== state.proposal.proposalId) return state;
      const before = confirmableItems(state.proposal, state.edits);
      const after = confirmableItems(event.proposal, state.edits);
      const selected = [
        ...state.selected.filter((id) => after.includes(id)),
        ...after.filter((id) => !before.includes(id) && !state.selected.includes(id)),
      ];
      return { ...state, status: statusForProposal(event.proposal), proposal: event.proposal, selected };
    }

    case 'analyzeFailed':
      // `text` is deliberately absent from this object. Whatever the person
      // typed survives every failure, including a quota refusal, because
      // losing somebody's words because a counter was full would be the worst
      // available response (UC-4.5, #181).
      return {
        ...state,
        status: event.kind === 'network' ? 'networkError'
          : event.kind === 'validation' ? 'validationError'
            : event.kind === 'refused' ? 'refused'
              : 'extractionFailed',
        errorReason: event.reason ?? null,
        messageKey: event.messageKey ?? null,
        // The proposal and the conversation are kept under the failure, so
        // Back returns to them (`dismissFailure`): a message that did not go
        // changed nothing about what was on screen.
      };

    case 'toggleItem': {
      if (!confirmableItems(state.proposal, state.edits).includes(event.itemId)) return state;
      const selected = state.selected.includes(event.itemId)
        ? state.selected.filter((id) => id !== event.itemId)
        : [...state.selected, event.itemId];
      return { ...state, selected };
    }

    case 'selectAll': {
      const confirmable = confirmableItems(state.proposal, state.edits);
      return { ...state, selected: confirmable };
    }

    case 'deselectAll': {
      return { ...state, selected: [] };
    }

    case 'editItem': {
      if (!state.proposal?.items.some((item) => item.itemId === event.itemId)) return state;
      const title = event.edit.title?.slice(0, MAX_TITLE_LENGTH);
      const edits = {
        ...state.edits,
        [event.itemId]: {
          ...state.edits[event.itemId],
          ...event.edit,
          ...(title !== undefined ? { title } : {}),
        },
      };
      const before = confirmableItems(state.proposal, state.edits);
      const after = confirmableItems(state.proposal, edits);
      // An item completed by hand joins the selection as soon as it is
      // confirmable (#503), the same way every confirmable item starts
      // selected and the way `clarified` behaves.
      const selected = [
        ...state.selected.filter((id) => after.includes(id)),
        ...after.filter((id) => !before.includes(id) && !state.selected.includes(id)),
      ];
      const status =
        state.status === 'needsClarification' && after.length > 0
          ? 'needsConfirmation'
          : state.status;
      return {
        ...state,
        status,
        edits,
        selected,
      };
    }

    case 'clearEdit': {
      const edits = { ...state.edits };
      delete edits[event.itemId];
      const after = confirmableItems(state.proposal, edits);
      const status =
        state.status === 'needsConfirmation' && after.length === 0 && (state.proposal?.items.length ?? 0) > 0
          ? 'needsClarification'
          : state.status;
      return {
        ...state,
        status,
        edits,
        selected: state.selected.filter((id) => after.includes(id)),
      };
    }

    case 'setWeekly': {
      const item = state.proposal?.items.find((candidate) => candidate.itemId === event.itemId);
      if (!item?.weeklyBlock) return state;
      const once = state.onceOnly.includes(event.itemId);
      if (event.weekly === !once) return state;
      return {
        ...state,
        onceOnly: event.weekly ? state.onceOnly.filter((id) => id !== event.itemId) : [...state.onceOnly, event.itemId],
      };
    }

    case 'confirmStarted':
      if (confirmPayload(state).itemIds.length === 0) return state;
      return { ...state, status: 'confirming', errorReason: null, messageKey: null };

    case 'confirmSucceeded':
      return {
        ...state,
        status: 'saved',
        // Straight from the server. The success screen shows exactly this, and
        // nothing the client believed it was saving.
        persisted: event.confirmation.persisted,
        failed: event.confirmation.failed,
        // Absent from an older server: no warning, rather than a parse failure.
        collisions: event.confirmation.collisions ?? [],
        // Absent from an older server, and from a confirm that named none.
        weeklySaved: event.confirmation.weeklyBlocks ?? [],
        undoable: event.confirmation.persisted.length > 0,
      };

    case 'confirmFailed':
      // The proposal survives, so Retry has something to retry. The line shown
      // is the failure's own, when it has one.
      return { ...state, status: 'confirmFailed', errorReason: event.reason ?? null, messageKey: event.messageKey ?? null };

    case 'undoWindowClosed':
      return { ...state, undoable: false };

    case 'backToComposer': {
      // Back from the proposal to a fresh composer holding what the person
      // said — their messages of this conversation, in order — so the words
      // are never what is lost. The conversation itself ends: the next send
      // starts a new one. With no conversation (a share's review, the
      // no-commitment "rephrase") the text is simply kept, as it always was.
      const said = state.turns.filter((turn) => turn.role === 'user').map((turn) => turn.text).join('\n');
      const text = (said || state.text).slice(0, MAX_CAPTURE_LENGTH);
      return {
        ...state,
        text,
        status: text.trim() ? 'editing' : 'idle',
        proposal: null, original: null, selected: [], edits: {}, onceOnly: [], errorReason: null, messageKey: null,
        conversationId: null,
        turns: [],
      };
    }

    case 'reset':
      return initialCaptureState(state.source, state.inputMode);

    default:
      return state;
  }
}
