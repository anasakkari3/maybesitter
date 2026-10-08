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
import type { CaptureChatAnswer, CaptureChatTurn, CaptureProposal, CaptureConfirmation, CaptureEntry } from '../../api/schemas/capture';
import { goalsOf, habitsOf, usableUnderstood, type UnderstoodPoint } from '../../api/schemas/capture';
import { familyIdOf, hasPoint, pointIdFor, pointsOf } from './pointIdentity';
import type { UserFacingKey } from '../../api/ui/userFacingMessage';
import type { CaptureProposalEdit } from '../../api/endpoints/capture';
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
/** Which staged card fields went into a structured edit, so only those are cleared (M2b). */
export interface FoldedEdit { itemId: string; title: boolean; time: boolean }

/**
 * A change from the «عدّل» sheet refused because the proposal moved on (M2b):
 * the person's own values, kept on the point's id — never its line, which
 * the current version may have moved — until they reopen it, the point is
 * gone, or the conversation is (M2B-A-R2-REVIEW-003).
 */
export interface RefusedEdit { target: CaptureProposalEdit['target']; change: CaptureProposalEdit['change'] }

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
  /**
   * `day_before`: the step is the first free hour the day before an exam-like
   * event (audit 2026-10-03 #3), and Review says why; `sessions` counts the
   * proposed sessions (2 with the short review an hour before).
   */
  readonly timing?: 'day_before';
  readonly sessions?: number;
}

/** Which input the user was offered first. */
export type CaptureInputMode = 'text' | 'voice';

/**
 * What a confirm in the chat saved, kept as a line of the conversation (owner
 * request 2026-09-30: «ما تطلع من صفحة الالتزام… يمكن بدي أضيف التزام تاني»).
 * The server's own answer, as the saved screen showed it; `undone` once Undo
 * was pressed on it — the commitment ids Undo could not take back.
 */
export interface ChatSavedNote {
  kind: 'saved';
  persisted: CaptureConfirmation['persisted'];
  failed: CaptureConfirmation['failed'];
  collisions: NonNullable<CaptureConfirmation['collisions']>;
  weeklySaved: NonNullable<CaptureConfirmation['weeklyBlocks']>;
  /** The titles of what did not save, from the proposal the person confirmed. */
  failedTitles: string[];
  /** The goals what was saved now counts toward (`goalLinks`), by their titles. Absent from older lines. */
  goalTitles?: string[];
  /** What the same confirm saved of the other families (M3b); absent from older lines. */
  habitsSaved?: NonNullable<CaptureConfirmation['habitsPersisted']>;
  goalsSaved?: NonNullable<CaptureConfirmation['goalsPersisted']>;
  seedsSaved?: NonNullable<CaptureConfirmation['seedsPersisted']>;
  undone?: { stillSaved: string[] };
}

/**
 * The chat before its last save: the conversations that ended in a confirm,
 * their turns and what each saved. Memory only, like everything here, and
 * shown above the conversation that is going on now.
 */
export type ChatEarlierEntry = { kind: 'turn'; role: CaptureChatTurn['role']; text: string } | ChatSavedNote;

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
   * Items carrying a suggested goal link («مرتبط بهدف …», audit 2026-10-03
   * #6) that the person took off the card. Stored as the exceptions, like
   * `onceOnly`: a suggestion is kept until somebody removes it, and nothing
   * is linked before the confirm.
   */
  goalUnlinked: string[];
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
  /**
   * What the chat said and saved before the conversation going on now (owner
   * request 2026-09-30). A confirm in the chat keeps the person there: its
   * conversation moves here, with a line saying what was saved, and the next
   * message starts a new one.
   */
  earlier: ChatEarlierEntry[];
  /**
   * The proposal whose cards the person opened from «هيك فهمت» (audit
   * 2026-10-06 #5/#6), by id. A chat answer that carries `understood` shows
   * that summary first; «هيك صح» or a tap on one of its lines opens the cards,
   * and Back from them returns to the summary. Keyed to the proposal, so a new
   * answer — a new id — starts at its own summary, and a clarification of the
   * same proposal keeps the cards open.
   */
  reviewOf: string | null;
  /**
   * The draft came from dictation (M2b): the next message says `spoken: true`,
   * edited by hand or not. Forgotten when the draft is sent or emptied.
   */
  spoken: boolean;
  /**
   * Other whole-draft readings the recognizer offered for an untouched
   * dictation, shown as «أو قصدك: …» chips, at most three (M2b). Never sent:
   * only the words in the field leave the phone. Cleared by any typing, a
   * chosen chip, a send and a new dictation.
   */
  alternatives: string[];
  /**
   * Why the proposal on screen is to be looked at again (M2b): a 409 brought
   * the current version back. Shown in review; cleared by the next write.
   */
  reviewNotice: 'proposalChanged' | null;
  /** Another device or intent already confirmed this conversation's proposal (M2b). */
  confirmedElsewhere: boolean;
  /** The person's refused summary change, to open again over the current version (M2b). */
  refusedEdit: RefusedEdit | null;
  /**
   * The page the chat was opened from (M3b): «ضيف هدف», «ضيف عادة», «احكي فكرة».
   * Sent with the conversation's first message; null for the plain chat.
   */
  entry: CaptureEntry | null;
  /**
   * The habits, goals and thought-entry thoughts the person took out of the
   * save, by their logical `pointId` (M3b, R2-011). Everything confirmable
   * starts selected; a choice follows the point when it changes family.
   */
  deselectedPoints: string[];
  /** What the last confirm saved of the other families (M3b), for the saved screen. */
  otherSaved: {
    habits: NonNullable<CaptureConfirmation['habitsPersisted']>;
    goals: NonNullable<CaptureConfirmation['goalsPersisted']>;
    seeds: NonNullable<CaptureConfirmation['seedsPersisted']>;
  };
}

export type CaptureEvent =
  | { type: 'open'; source?: CaptureSource; inputMode?: CaptureInputMode; meeting?: MeetingReviewContext; entry?: CaptureEntry | null }
  /** The account changed under an open chat: its entry belonged to the last one (M3b). */
  | { type: 'entryForgotten' }
  /** Take a habit, goal or thought-entry thought out of the save, or put it back (M3b). */
  | { type: 'togglePoint'; pointId: string }
  | { type: 'textChanged'; text: string }
  /**
   * A dictation is starting: the chips of the previous one go at once, and a
   * voice launch's auto-start is spent — reopening capture later never starts
   * the microphone again by itself (M2b).
   */
  | { type: 'dictationStarted' }
  /** Dictation in progress: the draft so far. It is the person's words, still spoken. */
  | { type: 'dictationChanged'; text: string }
  /** Dictation finished, with the whole-draft alternatives the recognizer offered. */
  | { type: 'dictationFinished'; text: string; alternatives: readonly string[] }
  /** A «أو قصدك» chip: that reading replaces the draft; nothing is sent. */
  | { type: 'alternativeChosen'; text: string }
  /**
   * The answer to a structured edit of the summary (M2b), or the current answer
   * a 409 brought back. Unlike `chatAnswered` it never touches the draft: no
   * message was sent. `folded` is the item whose staged card title/time went
   * into the edit, so they are cleared here.
   */
  | { type: 'editAnswered'; answer: CaptureChatAnswer; folded?: FoldedEdit; refused?: RefusedEdit; applied?: CaptureProposalEdit['target'] }
  /** The refused change was opened again in the sheet: it is the sheet's now. */
  | { type: 'refusedEditTaken' }
  /** The current proposal a 409 `proposal_changed` carried (confirm, clarify, seed keep). */
  | { type: 'proposalReplaced'; proposal: CaptureProposal }
  /**
   * A 409 said the proposal was already confirmed elsewhere: nothing more to
   * write here. With the id it is about, so a late answer for a former
   * proposal leaves the one on screen alone (M2B-A-R3-REVIEW-004).
   */
  | { type: 'proposalConfirmedElsewhere'; proposalId?: string }
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
  /** Keep (`linked: true`) or remove an item's suggested goal link. */
  | { type: 'setGoalLink'; itemId: string; linked: boolean }
  | { type: 'confirmStarted' }
  | { type: 'confirmSucceeded'; confirmation: CaptureConfirmation }
  | { type: 'confirmFailed'; reason?: string; messageKey?: UserFacingKey }
  | { type: 'undoWindowClosed' }
  /** What Undo could not take back, recorded on the chat's last saved line. */
  | { type: 'undoRecorded'; stillSaved: string[] }
  | { type: 'backToComposer' }
  /** «هيك صح», or a line of the summary: the cards of the proposal on screen. */
  | { type: 'understoodAccepted' }
  /** Back from those cards to the summary of the same proposal. */
  | { type: 'understoodReopened' }
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
    goalUnlinked: [],
    conversationId: null,
    turns: [],
    earlier: [],
    reviewOf: null,
    spoken: false,
    alternatives: [],
    reviewNotice: null,
    confirmedElsewhere: false,
    refusedEdit: null,
    entry: null,
    deselectedPoints: [],
    otherSaved: { habits: [], goals: [], seeds: [] },
  };
}

/** How many times the chat has saved in this capture. */
export function chatSaves(state: CaptureState): number {
  return state.earlier.filter((entry) => entry.kind === 'saved').length;
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

/** The habits that can be saved: the server marks one confirmable once its rhythm and length are known (R4-002). */
export function confirmableHabits(proposal: CaptureProposal | null): string[] {
  if (!proposal || !ACTIONABLE_PROPOSAL_STATUSES.has(proposal.status)) return [];
  return habitsOf(proposal).filter((habit) => habit.confirmable).map((habit) => habit.pointId);
}

/** The goals that can be saved: every goal point. */
export function confirmableGoals(proposal: CaptureProposal | null): string[] {
  if (!proposal || !ACTIONABLE_PROPOSAL_STATUSES.has(proposal.status)) return [];
  return goalsOf(proposal).map((goal) => goal.pointId);
}

/**
 * The thoughts saved by the confirm itself: only a proposal from the thought
 * entry (R002). Elsewhere a thought keeps its own «خلّيه».
 */
export function confirmableThoughts(proposal: CaptureProposal | null): string[] {
  if (!proposal || proposal.entry !== 'thought') return [];
  if (!ACTIONABLE_PROPOSAL_STATUSES.has(proposal.status) && proposal.status !== 'unresolved_intent') return [];
  return (proposal.seeds ?? []).map((seed) => seed.pointId ?? seed.seedItemId);
}

/** Whether a habit, goal or thought point is in the save (selected by default). */
export function pointSelected(state: CaptureState, pointId: string): boolean {
  const confirmable = [...confirmableHabits(state.proposal), ...confirmableGoals(state.proposal), ...confirmableThoughts(state.proposal)];
  return confirmable.includes(pointId) && !state.deselectedPoints.includes(pointId);
}

/** Whether Undo can honestly take a receipt back: commitments only (R3-004). */
export function undoableReceipt(confirmation: CaptureConfirmation): boolean {
  return confirmation.persisted.length > 0
    && (confirmation.habitsPersisted ?? []).length === 0
    && (confirmation.goalsPersisted ?? []).length === 0
    && (confirmation.seedsPersisted ?? []).length === 0;
}

/** How many points «احفظ N» saves: selected commitments plus the other families. */
export function selectedCount(state: CaptureState): number {
  const commitments = state.selected.filter((id) => confirmableItems(state.proposal, state.edits).includes(id)).length;
  const others = [...confirmableHabits(state.proposal), ...confirmableGoals(state.proposal), ...confirmableThoughts(state.proposal)]
    .filter((pointId) => !state.deselectedPoints.includes(pointId)).length;
  return commitments + others;
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

/** The goals a confirm linked, by title, as a saved line keeps them; nothing when it linked none. */
function goalTitlesOf(state: CaptureState, confirmation: CaptureConfirmation): { goalTitles?: string[] } {
  const titles = Array.from(new Set((confirmation.goalLinks ?? [])
    .map((link) => state.proposal?.items.find((candidate) => candidate.itemId === link.itemId)?.goalLink?.title ?? '')
    .filter((title) => title.trim().length > 0)));
  return titles.length > 0 ? { goalTitles: titles } : {};
}

/** Whether the item's suggested goal link is kept on the card; false when it has none. */
export function goalLinkKept(state: CaptureState, itemId: string): boolean {
  const item = state.proposal?.items.find((candidate) => candidate.itemId === itemId);
  return !!item?.goalLink && !state.goalUnlinked.includes(itemId);
}

/** What the confirm request carries. Only the selection, and only its edits. */
export function confirmPayload(state: CaptureState): {
  proposalId: string;
  itemIds: string[];
  edits: Record<string, CaptureItemEdit>;
  /** The selected items kept as weekly blocks; everything else confirms once. */
  weeklyBlockItemIds: string[];
  /** The selected items whose goal link is kept; absent when none is. */
  goalLinkItemIds?: string[];
  /** The proposal revision on screen, when the server sent one (M2b). */
  revision?: number;
  /**
   * The other families, by their family ids, translated from the logical
   * points (M3b, R3-002). Each only when non-empty, so a commitment-only
   * confirm is exactly the one an older app sent (R3-003).
   */
  selectedHabitItemIds?: string[];
  selectedGoalItemIds?: string[];
  selectedSeedItemIds?: string[];
} {
  const itemIds = state.selected.filter((id) => confirmableItems(state.proposal, state.edits).includes(id));
  const chosen = (pointIds: string[]) => pointIds.filter((pointId) => !state.deselectedPoints.includes(pointId));
  const habits = habitsOf(state.proposal ?? { habits: [] });
  const goals = goalsOf(state.proposal ?? { goals: [] });
  const selectedHabitItemIds = chosen(confirmableHabits(state.proposal))
    .map((pointId) => habits.find((habit) => habit.pointId === pointId)!.habitItemId);
  const selectedGoalItemIds = chosen(confirmableGoals(state.proposal))
    .map((pointId) => goals.find((goal) => goal.pointId === pointId)!.goalItemId);
  const selectedSeedItemIds = chosen(confirmableThoughts(state.proposal))
    .map((pointId) => state.proposal!.seeds.find((seed) => (seed.pointId ?? seed.seedItemId) === pointId)!.seedItemId);
  // Edits for items that are not being confirmed are dropped rather than sent.
  // Sending them would ask the server to validate a change to something the
  // user chose not to save.
  const edits: Record<string, CaptureItemEdit> = {};
  for (const id of itemIds) {
    if (state.edits[id]) edits[id] = state.edits[id];
  }
  const weeklyBlockItemIds = itemIds.filter((id) => weeklyChoice(state, id) === 'weekly');
  // Only the chat's cards show «مرتبط بهدف …»: a review that never drew the
  // chip (a share, a meeting prep) links nothing — no link the person did not see.
  const goalLinkItemIds = state.conversationId === null ? [] : itemIds.filter((id) => goalLinkKept(state, id));
  const revision = state.proposal?.revision;
  return {
    proposalId: state.proposal?.proposalId ?? '', itemIds, edits, weeklyBlockItemIds,
    ...(goalLinkItemIds.length > 0 ? { goalLinkItemIds } : {}),
    // What was seen is what is saved (M2b).
    ...(revision !== undefined ? { revision } : {}),
    ...(selectedHabitItemIds.length > 0 ? { selectedHabitItemIds } : {}),
    ...(selectedGoalItemIds.length > 0 ? { selectedGoalItemIds } : {}),
    ...(selectedSeedItemIds.length > 0 ? { selectedSeedItemIds } : {}),
  };
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
    if (state.goalUnlinked.length > 0) return true;
    const base = state.original ?? state.proposal;
    const defaultSelected = defaultSelectedItems(base);
    return !sameIds(state.selected, defaultSelected);
  }
  return state.text.trim().length > 0;
}


function statusForProposal(proposal: CaptureProposal): CaptureStatus {
  // Only removed points left: the summary shows them to bring back (contract v5).
  if (onlyRemoved(proposal)) return 'unresolvedIntent';
  // A habit, a goal, or a thought from the thought entry can be saved on its
  // own (M3b, R001): the review offers «احفظ» even with no commitment.
  if (proposal.status !== 'rejected' && proposal.status !== 'no_commitment'
    && confirmableHabits(proposal).length + confirmableGoals(proposal).length + confirmableThoughts(proposal).length > 0) {
    return 'needsConfirmation';
  }
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
  return proposal.items.length > 0 || (proposal.seeds?.length ?? 0) > 0 || habitsOf(proposal).length > 0
    || goalsOf(proposal).length > 0 || onlyRemoved(proposal) ? proposal : null;
}

/**
 * A versioned proposal whose every point a later message took off the list
 * (contract v5): still a proposal — its removed points are shown with
 * «رجّعها», never dropped as "nothing found" (M2B-A-R7-001).
 */
export function onlyRemoved(proposal: CaptureProposal): boolean {
  return proposal.revision !== undefined && proposal.items.length === 0 && (proposal.seeds?.length ?? 0) === 0
    && habitsOf(proposal).length === 0 && goalsOf(proposal).length === 0 && (proposal.removedItems?.length ?? 0) > 0;
}

/** The summary's lines: `understood` when it describes the proposal, none when only removed points are left. */
export function summaryPoints(proposal: CaptureProposal): readonly UnderstoodPoint[] | undefined {
  return usableUnderstood(proposal) ?? (onlyRemoved(proposal) ? [] : undefined);
}

/**
 * Whether the chat shows «هيك فهمت» — the numbered summary of the answer —
 * instead of its cards: a proposal under review whose `understood` lines
 * describe exactly it (`usableUnderstood`), and whose cards were not opened.
 * Without `understood` (an older server, a legacy proposal) it is false and the
 * cards show as they always did.
 */
export function showsUnderstood(state: CaptureState): boolean {
  const proposal = state.proposal;
  if (!proposal || !REVIEWING.has(state.status) || state.conversationId === null) return false;
  return state.reviewOf !== proposal.proposalId && summaryPoints(proposal) !== undefined;
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
function carriedInto(state: CaptureState, next: CaptureProposal): Pick<CaptureState, 'selected' | 'edits' | 'onceOnly' | 'goalUnlinked' | 'deselectedPoints'> {
  const before = new Map((state.proposal?.items ?? []).map((item) => [item.itemId, item]));
  const wasConfirmable = confirmableItems(state.proposal, state.edits);
  // Every point the person took out, by its logical id, across families
  // (R2-011): a deselected commitment, or a deselected habit/goal/thought.
  const out = new Set(state.deselectedPoints);
  for (const id of wasConfirmable) if (!state.selected.includes(id)) out.add(pointIdFor(state.proposal, id));
  const knownPoints = new Set(state.proposal ? pointsOf(state.proposal).map((point) => point.pointId) : []);
  const edits: Record<string, CaptureItemEdit> = {};
  for (const item of next.items) {
    const old = before.get(item.itemId);
    const edit = state.edits[item.itemId];
    if (old && edit && sameServerFacts(old, item)) edits[item.itemId] = edit;
  }
  const defaults = defaultSelectedItems(next, edits);
  const selected = confirmableItems(next, edits).filter((id) => {
    if (wasConfirmable.includes(id)) return state.selected.includes(id);
    // A new family id for a point the person already knew: their choice follows the point.
    const pointId = pointIdFor(next, id);
    if (pointId !== id && knownPoints.has(pointId)) return !out.has(pointId);
    return defaults.includes(id);
  });
  const onceOnly = state.onceOnly.filter((id) => next.items.some((item) => item.itemId === id && item.weeklyBlock));
  const goalUnlinked = state.goalUnlinked.filter((id) => next.items.some((item) => item.itemId === id && item.goalLink));
  const nonCommitment = new Set([...habitsOf(next).map((habit) => habit.pointId), ...goalsOf(next).map((goal) => goal.pointId),
    ...(next.seeds ?? []).map((seed) => seed.pointId ?? seed.seedItemId)]);
  const deselectedPoints = Array.from(out).filter((pointId) => nonCommitment.has(pointId));
  return { selected, edits, onceOnly, goalUnlinked, deselectedPoints };
}

/**
 * Choices carried across a structured edit or a 409's current proposal (M2b).
 * Ids are kept by the server, so a choice follows its id: the selection as
 * `carriedInto` keeps it, a hand edit while the server's facts for that item
 * did not change — except the `folded` item, whose staged title and time just
 * went into the edit and are now the server's (its priority and place stay).
 * An item that became a seed takes its choices with it.
 */
/** The id a structured-edit target names; a point keeps it when its kind changes. */
function targetId(target: CaptureProposalEdit['target']): string {
  return familyIdOf(target);
}

/**
 * A refused change outlives an answer only while its point is still there and
 * no newer change to that point was applied since (M2B-A-R3-REVIEW-003).
 */
function stillRefused(refused: RefusedEdit | null, proposal: CaptureProposal, applied?: CaptureProposalEdit['target']): RefusedEdit | null {
  if (!refused) return null;
  const id = targetId(refused.target);
  if (applied && targetId(applied) === id) return null;
  return hasPoint(proposal, id) ? refused : null;
}

function carriedAcrossEdit(state: CaptureState, next: CaptureProposal, folded?: FoldedEdit): Pick<CaptureState, 'selected' | 'edits' | 'onceOnly' | 'goalUnlinked' | 'deselectedPoints'> {
  const carried = carriedInto(state, next);
  // Choices on an item the edit did not touch follow their id even if the
  // answer's facts differ from the last answer's; only what went into the
  // patch becomes the server's.
  const edits: Record<string, CaptureItemEdit> = {};
  for (const item of next.items) {
    const staged = state.edits[item.itemId];
    if (!staged) continue;
    if (folded?.itemId !== item.itemId) { edits[item.itemId] = staged; continue; }
    const rest: CaptureItemEdit = { ...staged };
    if (folded.title) delete rest.title;
    if (folded.time) delete rest.localDateTime;
    if (Object.keys(rest).length > 0) edits[item.itemId] = rest;
  }
  return { ...carried, edits };
}

export function captureReducer(state: CaptureState, event: CaptureEvent): CaptureState {
  switch (event.type) {
    case 'open': {
      const opened = { ...initialCaptureState(event.source ?? state.source, event.inputMode ?? state.inputMode), entry: event.entry ?? null };
      return event.meeting ? { ...opened, meeting: event.meeting } : opened;
    }

    case 'entryForgotten':
      return state.entry === null ? state : { ...state, entry: null };

    case 'togglePoint': {
      const confirmable = [...confirmableHabits(state.proposal), ...confirmableGoals(state.proposal), ...confirmableThoughts(state.proposal)];
      if (!confirmable.includes(event.pointId)) return state;
      const deselectedPoints = state.deselectedPoints.includes(event.pointId)
        ? state.deselectedPoints.filter((pointId) => pointId !== event.pointId)
        : [...state.deselectedPoints, event.pointId];
      return { ...state, deselectedPoints };
    }

    case 'textChanged': {
      // The message in flight is not a draft; nothing types over it.
      if (state.status === 'analyzing' || state.status === 'confirming') return state;
      // Truncated here rather than refused, so a long paste keeps its beginning
      // instead of silently doing nothing.
      const text = event.text.slice(0, MAX_CAPTURE_LENGTH);
      // Typing over a dictation keeps it spoken but drops the alternatives:
      // they were readings of words that are no longer there (M2b).
      const voice = { spoken: state.spoken && text.trim().length > 0, alternatives: [] as string[] };
      // Under a proposal the composer is the next message of the conversation:
      // typing it changes nothing about the proposal on screen (#chat).
      if (REVIEWING.has(state.status)) return { ...state, ...voice, text };
      return { ...state, ...voice, text, status: text.trim() ? 'editing' : 'idle', errorReason: null, messageKey: null };
    }

    case 'dictationStarted':
      return { ...state, alternatives: [], inputMode: 'text' };

    case 'dictationChanged':
    case 'dictationFinished':
    case 'alternativeChosen': {
      if (state.status === 'analyzing' || state.status === 'confirming') return state;
      const text = event.text.slice(0, MAX_CAPTURE_LENGTH);
      const alternatives = event.type === 'dictationFinished'
        ? Array.from(new Set(event.alternatives.map((value) => value.slice(0, MAX_CAPTURE_LENGTH))))
          .filter((value) => value.trim() && value !== text).slice(0, 3)
        : [];
      const voice = { spoken: text.trim().length > 0, alternatives };
      if (REVIEWING.has(state.status)) return { ...state, ...voice, text };
      return { ...state, ...voice, text, status: text.trim() ? 'editing' : 'idle', errorReason: null, messageKey: null };
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
        goalUnlinked: [],
        errorReason: null,
        messageKey: null,
      };

    case 'chatStarted':
      if (!state.text.trim() || state.status === 'confirming' || state.status === 'analyzing') return state;
      // The proposal and the conversation stay: a failed send goes back to
      // them, and the answer's own proposal replaces this one when it lands.
      // The chips go with the send: they were readings of this draft (M2b).
      return { ...state, status: 'analyzing', errorReason: null, messageKey: null, alternatives: [], reviewNotice: null, confirmedElsewhere: false };

    case 'chatAnswered': {
      const { answer } = event;
      const proposal = chatProposalShown(answer.proposal);
      const conversation = {
        ...state,
        // The message is in `turns` now; the field is for the next one.
        text: '',
        spoken: false,
        alternatives: [],
        conversationId: answer.conversationId,
        turns: answer.turns,
        errorReason: null,
        messageKey: null,
      };
      if (!proposal) {
        return { ...conversation, status: 'idle', proposal: null, original: null, selected: [], edits: {}, onceOnly: [], goalUnlinked: [], reviewOf: null, refusedEdit: null };
      }
      const carried = carriedInto(state, proposal);
      // A new proposal starts at its own summary; the same one keeps its cards.
      const reviewOf = state.reviewOf === proposal.proposalId ? state.reviewOf : null;
      const refusedEdit = state.proposal?.proposalId === proposal.proposalId ? stillRefused(state.refusedEdit, proposal) : null;
      return { ...conversation, ...carried, status: reviewStatus(proposal, carried.edits), proposal, original: proposal, reviewOf, refusedEdit };
    }

    case 'editAnswered': {
      // A structured edit sent no message: the draft, its spoken state and its
      // chips stay exactly as they were (M2b).
      const { answer } = event;
      const proposal = chatProposalShown(answer.proposal);
      const conversation = { ...state, conversationId: answer.conversationId, turns: answer.turns, errorReason: null, messageKey: null };
      if (!proposal) {
        return { ...conversation, status: state.text.trim() ? 'editing' : 'idle', proposal: null, original: null, selected: [], edits: {}, onceOnly: [], goalUnlinked: [], reviewOf: null, refusedEdit: null };
      }
      const carried = carriedAcrossEdit(state, proposal, event.folded);
      const reviewOf = state.reviewOf === proposal.proposalId ? state.reviewOf : null;
      // A refusal keeps the person's change; an applied change to the same
      // point spends an older refused one.
      const refusedEdit = event.refused ?? stillRefused(state.refusedEdit, proposal, event.applied);
      return { ...conversation, ...carried, status: reviewStatus(proposal, carried.edits), proposal, original: proposal, reviewOf, reviewNotice: null, refusedEdit };
    }

    case 'proposalReplaced': {
      // A 409 brought the proposal as it is now (M2b). Nothing was saved; the
      // person reviews this version. Their choices carry where it did not move.
      if (!state.proposal || event.proposal.proposalId !== state.proposal.proposalId) return state;
      // The person's staged choices are theirs and unsent: they stay on their
      // ids even where the server's facts moved, to be reviewed again (M2b).
      const carried = carriedAcrossEdit(state, event.proposal);
      const edits: Record<string, CaptureItemEdit> = {};
      for (const item of event.proposal.items) {
        const staged = state.edits[item.itemId];
        if (staged) edits[item.itemId] = staged;
      }
      return {
        ...state, ...carried, edits, status: reviewStatus(event.proposal, edits), proposal: event.proposal, original: event.proposal,
        errorReason: null, messageKey: null, reviewNotice: 'proposalChanged', refusedEdit: stillRefused(state.refusedEdit, event.proposal),
      };
    }

    case 'proposalConfirmedElsewhere':
      // Nothing to confirm, clarify or keep any more: say so instead of
      // offering writes that can only be refused again.
      if (!state.proposal || (event.proposalId !== undefined && event.proposalId !== state.proposal.proposalId)) return state;
      return {
        ...state, proposal: null, original: null, selected: [], edits: {}, onceOnly: [], goalUnlinked: [], reviewOf: null,
        status: state.text.trim() ? 'editing' : 'idle', errorReason: null, messageKey: null, reviewNotice: null, confirmedElsewhere: true, refusedEdit: null,
      };

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

    case 'setGoalLink': {
      const item = state.proposal?.items.find((candidate) => candidate.itemId === event.itemId);
      if (!item?.goalLink) return state;
      const removed = state.goalUnlinked.includes(event.itemId);
      if (event.linked === !removed) return state;
      return {
        ...state,
        goalUnlinked: event.linked ? state.goalUnlinked.filter((id) => id !== event.itemId) : [...state.goalUnlinked, event.itemId],
      };
    }

    case 'confirmStarted':
      if (confirmPayload(state).itemIds.length === 0) return state;
      return { ...state, status: 'confirming', errorReason: null, messageKey: null };

    case 'confirmSucceeded': {
      const saved = {
        // Straight from the server. The success screen shows exactly this, and
        // nothing the client believed it was saving.
        persisted: event.confirmation.persisted,
        failed: event.confirmation.failed,
        // Absent from an older server: no warning, rather than a parse failure.
        collisions: event.confirmation.collisions ?? [],
        // Absent from an older server, and from a confirm that named none.
        weeklySaved: event.confirmation.weeklyBlocks ?? [],
        otherSaved: {
          habits: event.confirmation.habitsPersisted ?? [],
          goals: event.confirmation.goalsPersisted ?? [],
          seeds: event.confirmation.seedsPersisted ?? [],
        },
        // Undo takes back commitments only; a save that also wrote a habit, a
        // goal or a thought offers each one's own page instead (R3-004), so
        // "nothing was kept" can never follow it.
        undoable: undoableReceipt(event.confirmation),
      };
      // A review with no conversation — a share, a meeting prep, a Gmail
      // scan — ends on the saved screen, as it always did.
      if (state.conversationId === null) return { ...state, ...saved, status: 'saved' };
      // The chat keeps the person in it (owner request 2026-09-30): the
      // conversation moves above, with a line saying what was saved, the
      // proposal goes, and the next message starts a new conversation. A
      // message typed under the proposal and not sent stays in the field.
      return {
        ...state,
        ...saved,
        status: state.text.trim() ? 'editing' : 'idle',
        earlier: [
          ...state.earlier,
          ...state.turns.map((turn): ChatEarlierEntry => ({ kind: 'turn', role: turn.role, text: turn.text })),
          {
            kind: 'saved', persisted: saved.persisted, failed: saved.failed, collisions: saved.collisions, weeklySaved: saved.weeklySaved,
            failedTitles: saved.failed.map((item) => state.proposal?.items.find((candidate) => candidate.itemId === item.itemId)?.title ?? '')
              .filter((title) => title.trim().length > 0),
            ...goalTitlesOf(state, event.confirmation),
            ...(saved.otherSaved.habits.length > 0 ? { habitsSaved: saved.otherSaved.habits } : {}),
            ...(saved.otherSaved.goals.length > 0 ? { goalsSaved: saved.otherSaved.goals } : {}),
            ...(saved.otherSaved.seeds.length > 0 ? { seedsSaved: saved.otherSaved.seeds } : {}),
          },
        ],
        turns: [],
        conversationId: null,
        proposal: null, original: null, selected: [], edits: {}, onceOnly: [], goalUnlinked: [], errorReason: null, messageKey: null,
        reviewOf: null, deselectedPoints: [],
      };
    }

    case 'undoRecorded': {
      // Only the chat's last saved line: the saved screen shows its own.
      const at = state.earlier.map((entry) => entry.kind).lastIndexOf('saved');
      if (at < 0) return state;
      const earlier = [...state.earlier];
      earlier[at] = { ...(earlier[at] as ChatSavedNote), undone: { stillSaved: event.stillSaved } };
      return { ...state, earlier };
    }

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
        proposal: null, original: null, selected: [], edits: {}, onceOnly: [], goalUnlinked: [], errorReason: null, messageKey: null,
        conversationId: null,
        turns: [],
        reviewOf: null,
      };
    }

    case 'understoodAccepted':
      return showsUnderstood(state) ? { ...state, reviewOf: state.proposal!.proposalId } : state;

    case 'understoodReopened':
      if (!state.proposal || state.reviewOf !== state.proposal.proposalId || state.status === 'confirming') return state;
      return { ...state, reviewOf: null };

    case 'refusedEditTaken':
      return state.refusedEdit ? { ...state, refusedEdit: null } : state;

    case 'reset':
      return initialCaptureState(state.source, state.inputMode);

    default:
      return state;
  }
}
