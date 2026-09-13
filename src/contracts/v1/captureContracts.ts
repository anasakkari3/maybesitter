import { MODULE_CONTRACT_VERSION } from './moduleContracts';

export const CAPTURE_CONTRACT_VERSION = MODULE_CONTRACT_VERSION;

export type CaptureProposalStatus =
  | 'proposed'
  | 'needs_clarification'
  | 'no_commitment'
  | 'rejected';

export interface CaptureProposalItemContract {
  itemId: string;
  title: string;
  resolvedTime: string | null;
  needsClarification: boolean;
  /**
   * What the extractor read the importance as (UC-2.4, #164).
   *
   * Shown as Must / Should / Nice. Sent so the review screen can render it
   * without a second call, and so an unchanged value round-trips rather than
   * being re-derived on the client.
   */
  priority?: 'low' | 'normal' | 'high';
  /**
   * True when the level above is the extractor's guess rather than something
   * the person said.
   *
   * The review screen marks it, so a user can see the difference between
   * "you said this is urgent" and "we assumed". A guess presented as a fact is
   * how a product loses the right to make guesses at all.
   */
  priorityEstimated?: boolean;
}

/**
 * One change a user made in review, before anything was saved (UC-2.4, #164).
 *
 * Only three fields, and deliberately: title, time and priority are what the
 * review screen shows, and an edit to anything else would be editing something
 * the user never saw. The server validates against this list rather than
 * against whatever keys arrive, so a field added to the client cannot become a
 * field the server writes.
 */
export interface CaptureItemEditContract {
  itemId: string;
  title?: string;
  /** An ISO instant, or null to say "no time". */
  resolvedTime?: string | null;
  priority?: 'low' | 'normal' | 'high';
}

/** The fields an edit may carry. Anything else is refused (#164). */
export const CAPTURE_EDITABLE_FIELDS = ['itemId', 'title', 'resolvedTime', 'priority'] as const;

/** Title bounds the confirm validates, before anything is persisted. */
export const CAPTURE_EDIT_TITLE_MIN = 1;
export const CAPTURE_EDIT_TITLE_MAX = 120;

/**
 * How long a proposal may sit before it is confirmed (UC-2.4, #164).
 *
 * Thirty minutes. A proposal resolved "tomorrow at 9" against a `now` that is
 * half an hour stale is still right; one resolved against a `now` from
 * yesterday is not, and the user would have no way to tell. Past this the
 * confirm refuses and the app offers to analyze the text again.
 */
export const CAPTURE_PROPOSAL_TTL_MS = 30 * 60 * 1_000;

/**
 * Why a capture produced nothing (UC-2.6, #166).
 *
 * Present only on a `no_commitment` proposal, and used for one thing: choosing
 * which single neutral line the client shows. It carries no content — a reason
 * code, not a reading of what the person wrote — and the client maps it to fixed
 * copy rather than composing a sentence about it.
 *
 * `informational`, `greeting_or_chat`, `question` and `past_event` describe what
 * kind of message arrived. `negated_request` is someone asking not to be
 * reminded, which used to be answered with HTTP 400 — an error, for a request
 * the product understood perfectly and was right to refuse. `low_confidence` is
 * the extractor not having read enough to propose anything.
 */
export type NoCommitmentReason =
  | 'informational'
  | 'greeting_or_chat'
  | 'question'
  | 'past_event'
  | 'negated_request'
  | 'low_confidence';

/** A proposal cannot claim or imply persistence. */
export interface CaptureProposalContract {
  version: typeof CAPTURE_CONTRACT_VERSION;
  proposalId: string;
  status: CaptureProposalStatus;
  /** Set only when `status` is `no_commitment`. */
  noCommitmentReason?: NoCommitmentReason;
  items: CaptureProposalItemContract[];
  provenance: {
    requestedEngine: 'model' | 'rules';
    executedEngine: 'gemini' | 'ollama' | 'rule-based';
    fallbackUsed: boolean;
  };
}

export interface CaptureConfirmationRequestContract {
  proposalId: string;
  scopeId: string;
  selectedItemIds: string[];
  idempotencyKey: string;
  /**
   * Edits applied atomically with the confirm (UC-2.4, #164).
   *
   * Not a separate PATCH afterwards. That was #172's original plan, and it
   * leaves the user holding a commitment with a title they already changed for
   * as long as the second request takes — permanently, if it fails. What the
   * user saw when they pressed confirm is what gets written, or nothing does.
   */
  edits?: CaptureItemEditContract[];
}

export interface CaptureConfirmationResultContract {
  version: typeof CAPTURE_CONTRACT_VERSION;
  success: boolean;
  replayed: boolean;
  persistedItemIds: string[];
  /**
   * `invalid_edit` (UC-2.4, #164) is deliberately separate from
   * `invalid_selection`: the selection was fine and a change to it was not, and
   * the user needs to know which. It fails the *whole* confirm -- partially
   * applying a set of edits would leave some commitments as the user wanted
   * them and others as the extractor guessed, with no way to tell which.
   */
  failureCode?: 'proposal_not_found' | 'proposal_rejected' | 'invalid_selection' | 'persistence_failed' | 'invalid_edit';
}

export const CAPTURE_PERSISTENCE_POLICY = Object.freeze({
  proposalCanPersist: false,
  confirmationRequired: true,
  adapterOwnsCanonicalWrites: true,
  atomicBatchRequired: true,
  rawInputInAudit: false,
});

