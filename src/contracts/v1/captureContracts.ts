import { MODULE_CONTRACT_VERSION } from './moduleContracts';
import type { CaptureSeedProposalContract } from './intentContracts';

export const CAPTURE_CONTRACT_VERSION = MODULE_CONTRACT_VERSION;

export type CaptureProposalStatus =
  | 'proposed'
  | 'needs_clarification'
  | 'no_commitment'
  | 'rejected'
  /**
   * The capture named something the user is considering or waiting on, and no
   * commitment at all (#519).
   *
   * Its own status rather than a `no_commitment` with a list hanging off it,
   * because the two ask the client for different things. `no_commitment` means
   * "nothing to do here" and the app shows one neutral line; this means "there
   * is something here, and only you can say whether it is worth keeping" — the
   * review screen has to offer it. A client that has never heard of this
   * status shows its unknown-status fallback, which creates nothing, and that
   * is the correct behaviour for an older app: a seed nobody was offered is a
   * seed nobody has.
   *
   * A capture that produced both a commitment and a seed is `proposed`, not
   * this: the commitment is the thing needing confirmation, and `seeds` rides
   * along beside it.
   */
  | 'unresolved_intent';

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
  /**
   * The one question worth asking about this item (UC-2.5, #165).
   *
   * Declared here rather than only produced: `captureBoundaryService` has been
   * spreading this onto items since #293, and a spread is not excess-property
   * checked — so the field the phone parses was absent from the contract that
   * is supposed to define it. Null means the round is spent and the app should
   * open #164's edit sheet instead.
   */
  clarification?: ClarificationContract | null;
}

/**
 * The one question the product may ask about an item (UC-2.5, #165).
 *
 * ── Keys, never sentences ────────────────────────────────────────
 *
 * The server sends a `questionKey` and parameters; the phone renders the
 * sentence from its own locale files. The question text is therefore never
 * model-generated, which is the whole point: a model asked to phrase a question
 * will eventually phrase one that is long, or leading, or wrong in Arabic — and
 * a clarification the user cannot trust is worse than no clarification, because
 * the answer is applied to their commitment.
 *
 * It also means the three languages stay consistent and reviewable: the copy
 * lives in `mobile/src/i18n/locales/*.json` where a person can read all of it at
 * once, rather than being produced fresh per request.
 *
 * ── One question, one round ──────────────────────────────────────
 *
 * Never a chain. A product that asks twice has stopped being a capture box and
 * become an interview, and the fallback — #164's edit sheet — is a better answer
 * than a second question.
 */
export type ClarificationQuestionKey = 'ask_time' | 'ask_action' | 'ask_am_pm' | 'ask_day';
export type ClarificationField = 'time' | 'action' | 'time_period' | 'which_day';

export interface ClarificationOptionContract {
  optionId: string;
  /** An i18n key. The phone renders it; the server never sends prose. */
  labelKey: string;
  labelParams: Record<string, string>;
  /**
   * What choosing this means, as a local wall clock.
   *
   * Deliberately local rather than an instant: the answer is composed against
   * the proposal's own timezone when it arrives, by the same deterministic code
   * that resolved the capture (#162). An instant computed here would be an
   * instant computed twice, in two places, from two clocks.
   */
  value: { localTime?: string; localDate?: string };
}

export interface ClarificationContract {
  questionId: string;
  field: ClarificationField;
  questionKey: ClarificationQuestionKey;
  params: Record<string, string>;
  options: ClarificationOptionContract[];
  /** Whether the user may answer in their own words instead of picking. */
  allowFreeText: boolean;
}

/** At most one question per item, ever (UC-2.5, #165). */
export const CLARIFICATION_MAX_ROUNDS = 1;
/** The longest free-text answer the clarify endpoint will read. */
export const CLARIFICATION_FREE_TEXT_MAX = 200;

/**
 * The longest capture the **server** will read, in characters (#508).
 *
 * Two thousand, which is deliberately the same number as `MAX_CAPTURE_LENGTH`
 * in mobile/src/features/capture/captureMachine.ts. The client's copy is a UX
 * affordance — it keeps the composer's counter honest — and this one is the
 * boundary. Anybody holding a token can skip the first; only this one is
 * enforcement. They are the same number so that no capture the app accepts is
 * ever refused by the server, which would be a failure the user cannot explain.
 *
 * **Characters, not bytes.** `String.length` counts UTF-16 code units, which is
 * what the composer counts and what the parsers actually scan. A byte-based cap
 * would give Arabic and Hebrew roughly half the allowance — two UTF-8 bytes per
 * character against English's one — and Arabic is this app's default language,
 * so that is most of the users silently getting a stricter limit than the one
 * the product promises, and every ASCII test would still pass. An astral emoji
 * costs two code units under this rule; that is a far smaller effect and it is
 * the unit the client already uses.
 *
 * **Why the number has to be this low.** Two quadratic parsers sit behind this
 * boundary and both are reached by an ordinary authenticated capture. Measured
 * here, worst case per request on the one thread that serves everybody:
 *
 *                  splitInput      ruleBasedExtractor:386
 *     2,000 chars       2.8ms                      3.9ms
 *    20,000 chars     167.9ms                    294.8ms
 *   100,000 chars    3555.9ms                   7233.6ms
 *
 * So 20,000 — the figure `MAX_INPUT_CHARACTERS` and `MAX_SHARE_TEXT_CHARACTERS`
 * use for a model prompt and for an imported chat export — is not a safe
 * boundary for a *typed* capture: it still leaves nearly half a second of
 * blocked event loop reachable per request. 2,000 bounds both parsers to single
 * digit milliseconds, and is what the product already contracts for a capture.
 */
export const CAPTURE_INPUT_MAX_CHARACTERS = 2_000;

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
  /**
   * What the user may be considering or waiting on (#519).
   *
   * Always present, never optional, and empty for every capture that names
   * none — the same rule `collisions` follows on the confirmation. A field
   * that is sometimes missing is one every client has to guard, and an added
   * field that is sometimes absent is indistinguishable from one an older
   * server never sent.
   *
   * Nothing here is persisted. A seed exists only once the user picks it in
   * Review and the app posts it to `/api/mobile/seeds`, which reads the
   * summary back out of *this* stored proposal rather than from the request —
   * so what is kept is the sentence the person typed, not a sentence a client
   * sent back.
   */
  seeds: CaptureSeedProposalContract[];
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

