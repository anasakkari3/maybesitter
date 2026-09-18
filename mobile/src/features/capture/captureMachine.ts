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
import type { CaptureProposal, CaptureConfirmation } from '../../api/schemas/capture';
import type { UserFacingKey } from '../../api/ui/userFacingMessage';

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
  /** `POST /api/mobile/capture` in flight. */
  | 'analyzing'
  /** A proposal came back with at least one item to confirm. */
  | 'needsConfirmation'
  /** Every item needs a question answered before it can be confirmed (#165). */
  | 'needsClarification'
  /** The message named no commitment. Nothing was created (#166). */
  | 'noCommitment'
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
export type CaptureSource = 'tab' | 'widget' | 'share' | 'notification';

/** How an analyze failed, before it becomes a status. */
export type CaptureFailureKind = 'network' | 'validation' | 'extraction' | 'refused';

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
}

export interface CaptureState {
  status: CaptureStatus;
  source: CaptureSource;
  inputMode: CaptureInputMode;
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
}

export type CaptureEvent =
  | { type: 'open'; source?: CaptureSource; inputMode?: CaptureInputMode }
  | { type: 'textChanged'; text: string }
  | { type: 'analyzeStarted' }
  | { type: 'analyzeSucceeded'; proposal: CaptureProposal }
  /** The server's proposal after one question was answered (#165, #474). */
  | { type: 'clarified'; proposal: CaptureProposal }
  | { type: 'analyzeFailed'; kind: CaptureFailureKind; messageKey?: UserFacingKey; reason?: string }
  | { type: 'toggleItem'; itemId: string }
  | { type: 'editItem'; itemId: string; edit: CaptureItemEdit }
  | { type: 'clearEdit'; itemId: string }
  | { type: 'confirmStarted' }
  | { type: 'confirmSucceeded'; confirmation: CaptureConfirmation }
  | { type: 'confirmFailed'; reason?: string }
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
 *
 * ── The aggregate status is not the item's status ────────────────
 *
 * A proposal with an unanswered question is `needs_clarification`, not
 * `proposed` — `proposed` is what it becomes *after* the question is answered.
 * Reading the aggregate status first therefore threw the hand-completed item
 * away before the per-item rule could see it, which is how the first fix for
 * #492 still failed on a device while its tests passed: the fixture they used
 * was `proposed`, the one status in which the path cannot occur.
 *
 * So the aggregate status decides only what it is entitled to decide. A
 * proposal that created nothing (`no_commitment`) or was refused (`rejected`)
 * has nothing to confirm whatever the edits say. While a question is still
 * being asked, the item the user answered by hand is confirmable and the rest
 * of the proposal waits, exactly as it did before.
 */
export function confirmableItems(
  proposal: CaptureProposal | null,
  edits: Record<string, CaptureItemEdit> = {},
): string[] {
  if (!proposal) return [];
  if (proposal.status !== 'proposed' && proposal.status !== 'needs_clarification') return [];
  const asked = proposal.status === 'proposed';
  return proposal.items
    .filter((item) => completedByHand(edits[item.itemId]) || (asked && !item.needsClarification))
    .map((item) => item.itemId);
}

/** What the confirm request carries. Only the selection, and only its edits. */
export function confirmPayload(state: CaptureState): {
  proposalId: string;
  itemIds: string[];
  edits: Record<string, CaptureItemEdit>;
} {
  const itemIds = state.selected.filter((id) => confirmableItems(state.proposal, state.edits).includes(id));
  // Edits for items that are not being confirmed are dropped rather than sent.
  // Sending them would ask the server to validate a change to something the
  // user chose not to save.
  const edits: Record<string, CaptureItemEdit> = {};
  for (const id of itemIds) {
    if (state.edits[id]) edits[id] = state.edits[id];
  }
  return { proposalId: state.proposal?.proposalId ?? '', itemIds, edits };
}

/** True when the user has something worth a discard confirmation. */
export function hasUnsavedText(state: CaptureState): boolean {
  return state.text.trim().length > 0 && state.status !== 'saved';
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
    case 'rejected':
      return 'unsupportedRequest';
    default:
      return 'extractionFailed';
  }
}

export function captureReducer(state: CaptureState, event: CaptureEvent): CaptureState {
  switch (event.type) {
    case 'open':
      return initialCaptureState(event.source ?? state.source, event.inputMode ?? state.inputMode);

    case 'textChanged': {
      // Truncated here rather than refused, so a long paste keeps its beginning
      // instead of silently doing nothing.
      const text = event.text.slice(0, MAX_CAPTURE_LENGTH);
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
        selected: confirmableItems(event.proposal),
        edits: {},
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
        proposal: null,
        original: null,
      };

    case 'toggleItem': {
      if (!confirmableItems(state.proposal, state.edits).includes(event.itemId)) return state;
      const selected = state.selected.includes(event.itemId)
        ? state.selected.filter((id) => id !== event.itemId)
        : [...state.selected, event.itemId];
      return { ...state, selected };
    }

    case 'editItem': {
      if (!state.proposal?.items.some((item) => item.itemId === event.itemId)) return state;
      const title = event.edit.title?.slice(0, MAX_TITLE_LENGTH);
      return {
        ...state,
        edits: {
          ...state.edits,
          [event.itemId]: {
            ...state.edits[event.itemId],
            ...event.edit,
            ...(title !== undefined ? { title } : {}),
          },
        },
      };
    }

    case 'clearEdit': {
      const edits = { ...state.edits };
      delete edits[event.itemId];
      return { ...state, edits };
    }

    case 'confirmStarted':
      if (confirmPayload(state).itemIds.length === 0) return state;
      return { ...state, status: 'confirming', errorReason: null };

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
        undoable: event.confirmation.persisted.length > 0,
      };

    case 'confirmFailed':
      // The proposal survives, so Retry has something to retry.
      return { ...state, status: 'confirmFailed', errorReason: event.reason ?? null };

    case 'undoWindowClosed':
      return { ...state, undoable: false };

    case 'backToComposer':
      // The text is kept on purpose: this is the Edit button on a
      // no-commitment or error state, and losing what they wrote would be the
      // worst possible response to "I could not read that".
      return { ...state, status: state.text.trim() ? 'editing' : 'idle', proposal: null, original: null, selected: [], edits: {}, errorReason: null, messageKey: null };

    case 'reset':
      return initialCaptureState(state.source, state.inputMode);

    default:
      return state;
  }
}
