import { MODULE_CONTRACT_VERSION } from './moduleContracts';
import type { CaptureSeedProposalContract } from './intentContracts';
import type { WeeklyBlockOfferContract } from './weeklyBlockContracts';

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
   * When the item ends, as an ISO instant (M2a, audit 2026-10-06: «من ٤ لـ٨»
   * kept only the 4). Present only when the person said an end and a
   * deterministic range parse of this item's own words found it — never a
   * model's guess. It is the local end clock resolved on the item's local
   * date and timezone (next-day ranges allowed), and the same instant the
   * confirmed command stores as `timeSpec.endAt`.
   */
  endTime?: string;
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
   * The local day the item lands on, `YYYY-MM-DD` on the user's clock (L4).
   *
   * Sent because `resolvedTime` is null for an item still waiting on its hour,
   * and "doctor on Sunday" with no hour used to reach the review card as "no
   * time" — the Sunday the product had picked was invisible. Absent when the
   * capture named no day.
   */
  resolvedDate?: string;
  /**
   * True when `resolvedDate` is the product's guess — a weekday name resolved
   * to one particular week — rather than a day the person stated (L4).
   *
   * The same mechanism as `priorityEstimated`: the review card marks it with
   * the guessed chip and offers the same weekday one week later. Present
   * exactly when `resolvedDate` is.
   */
  dateEstimated?: boolean;
  /**
   * True when the hour of `resolvedTime` is the product's guess: the person
   * named only a part of the day — «المسا», "tonight", «בערב» — and no number
   * (UAT round 6, D2). «لازم أتصل بأمي اليوم المسا» is 18:00, on both
   * engines, and the review card marks it «حزرنا الساعة» the way it marks a
   * guessed day. Which hour is picked does not change.
   *
   * False when the person stated the hour («5 المسا», «الساعة 7», "7pm"),
   * when they chose it answering the question (a button or typed words), and
   * when `resolvedTime` is null. A question about something else — the action,
   * or which day for the hour already shown — leaves a guessed hour a guess.
   * A content-free boolean: it is never persisted with the commitment, and a
   * confirm-time edit of the time makes the hour theirs (the phone drops the
   * mark as soon as the time is edited). Absent from an older server, which
   * the phone reads as false.
   */
  timeEstimated?: boolean;
  /**
   * True when the item is an event *on* `resolvedDate` with no hour — an
   * appointment answered "no specific time" (FY1 N4) — rather than a deadline
   * *by* that day. Absent otherwise. A settled item with a day and no
   * `resolvedTime` reads «لحد <day>» on the review card; this one reads
   * «<day> · بدون وقت».
   */
  allDayEvent?: boolean;
  /**
   * True when the item happens *on* `resolvedDate` — an appointment, a
   * meeting — so clearing its hour in the review edit sheet keeps it there as
   * an all-day event (FY1 M1, `keepEventOnItsDay`); a task cleared of its hour
   * loses the day. Added by the mobile capture wrapper from the same test the
   * confirm uses, so the card can say «<day> · بدون وقت» only when the confirm
   * will keep the day (UAT round 3, N11). Absent otherwise.
   */
  eventOnDay?: boolean;
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
  /**
   * The words said this repeats weekly — «كل سبت», "every Saturday", «כל
   * שבת» (FIX-R8-CAPTURE). Until weekly blocks exist the item itself is a
   * one-off on the next occurrence (`resolvedDate`, marked estimated) with
   * the phrase kept in its title; this hint is what the recurring-block lane
   * turns into a weekly proposal. Content-free: `weekdays` are 0 = Sunday …
   * 6 = Saturday (empty when only "every week" was said and the day is
   * asked), and `start`/`end` are `HH:MM` on the person's clock, present only
   * once the hour is settled. Absent when no recurrence was said; optional on
   * the phone, so an older app ignores it.
   */
  recurrenceHint?: RecurrenceHintContract | null;
  /**
   * The offer to keep this as a weekly fixed block («ثابت أسبوعي»): present
   * only when `recurrenceHint` is complete — weekdays, and a settled start and
   * end on the same day — and the item needs no question. The Review card
   * renders it «كل سبت · 10:00–16:00». Offered, never saved: the confirm
   * creates the block only for an item named in `weeklyBlockItemIds`, and
   * without that the item confirms as the one-off it also is. Optional, so an
   * older app ignores it and keeps its one-off.
   */
  weeklyBlock?: WeeklyBlockOfferContract;
  /**
   * What this item's time lands on, among what the person already has — the
   * capture chat's answer only (owner request 2026-09-30: "he cannot describe
   * what the commitment is if there is a collision"). Proposal-time, so it
   * says the clash before anything is kept; the confirm still returns its own
   * `collisions`, unchanged. Absent when the item has no time or clashes with
   * nothing; optional on the phone, so an older app ignores it.
   */
  conflicts?: CaptureItemConflictContract[];
  /**
   * An active goal of the person's this item looks like a step of (audit
   * 2026-10-03 #6: React study sessions captured beside the goal "Learn
   * React" left it at «0 من 0»). A suggestion the card shows as «مرتبط بهدف
   * …» and the person keeps or removes: the confirm links the commitment to
   * the goal only for an item named in `goalLinkItemIds`. The id is read back
   * from the stored proposal at confirm, never from the request. Optional, so
   * an older app ignores it and links nothing.
   */
  goalLink?: CaptureGoalLinkSuggestionContract;
  /**
   * Words the server corrected in a dictated message (M2b, condition 1): «فهمت
   * "الطلع" إنها "اطلع"». Only when the request said `spoken: true`, only
   * corrections actually applied to this item's title, at most three, with
   * server-minted unique ids. The person can undo one with
   * `rejectCorrectionIds` on a proposal edit. Absent otherwise.
   */
  corrections?: CaptureCorrectionContract[];
}

/** One applied dictation correction (M2b). `from`/`to` are single words. */
export interface CaptureCorrectionContract {
  id: string;
  from: string;
  to: string;
}

/** See `CaptureProposalItemContract.goalLink`. `title` is the goal in the person's own words. */
export interface CaptureGoalLinkSuggestionContract {
  goalId: string;
  title: string;
}

/** What a proposed item clashes with: the chat card's line and the reply both name it. */
export const CAPTURE_ITEM_CONFLICT_KINDS = ['commitment', 'weekly', 'fixture', 'calendar_busy'] as const;
export type CaptureItemConflictKind = (typeof CAPTURE_ITEM_CONFLICT_KINDS)[number];

/**
 * One clash (see `CaptureProposalItemContract.conflicts`). `title` is the
 * person's own: a saved commitment's, a weekly block's («ثابت أسبوعي»), a
 * followed match's. Null for `calendar_busy` — a synced calendar's busy time
 * carries no title by design, and none is ever invented for it. The interval
 * is the one the clash was measured on, half-open, UTC instants.
 */
export interface CaptureItemConflictContract {
  title: string | null;
  startsAt: string;
  endsAt: string;
  kind: CaptureItemConflictKind;
  /**
   * The clash is with another item of this same proposal, not with something
   * already saved (audit 2026-10-03 #1: three items at one hour were only
   * found to clash after they were saved). Optional; an older app reads the
   * line as it reads a commitment's.
   */
  inProposal?: true;
}

/** See `CaptureProposalItemContract.recurrenceHint`. */
export interface RecurrenceHintContract {
  weekdays: number[];
  start?: string;
  end?: string;
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
 * So 20,000 — the figure `MAX_INPUT_CHARACTERS` uses for a model prompt and
 * `MAX_SHARE_RAW_TEXT_CHARACTERS` for what a share channel may read — is not a safe
 * boundary for a *typed* capture: it still leaves nearly half a second of
 * blocked event loop reachable per request. 2,000 bounds both parsers to single
 * digit milliseconds, and is what the product already contracts for a capture.
 */
export const CAPTURE_INPUT_MAX_CHARACTERS = 2_000;

/**
 * The phone's UI language, sent as `locale` on every request whose answer
 * carries a title a model wrote (owner request 2026-09-30: «لما لغة التطبيق
 * عربي … ينحفظ بالعربي»). The model then writes each proposed title in this
 * language as well as in the person's own words; the card shows the first,
 * and the evidence checks read the second.
 *
 * A closed set, never free text: the value is only ever turned into one of the
 * fixed language names the prompts carry. Anything else — absent, misspelt, a
 * locale this app does not speak — is `undefined`, which is the behaviour
 * before this field existed.
 */
export const CAPTURE_APP_LOCALES = ['ar', 'en', 'he'] as const;
export type CaptureAppLocale = (typeof CAPTURE_APP_LOCALES)[number];

export function captureAppLocaleFrom(value: unknown): CaptureAppLocale | undefined {
  return typeof value === 'string' && (CAPTURE_APP_LOCALES as readonly string[]).includes(value)
    ? value as CaptureAppLocale
    : undefined;
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
  /**
   * "Remind me when I arrive / leave", chosen in review (closure CL4). Carried
   * with the confirm so the commitment is written with it or not at all.
   * Validated by `parseLocationTrigger`: no coordinates, ever.
   */
  locationTrigger?: unknown;
}

/** The fields an edit may carry. Anything else is refused (#164). */
export const CAPTURE_EDITABLE_FIELDS = ['itemId', 'title', 'resolvedTime', 'priority', 'locationTrigger'] as const;

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
  /**
   * What the assistant understood, one line per thing, in the order the
   * person said them (M2a). Shown before any card. Every item and every seed
   * appears exactly once; a seed's point carries that seed's kind. Plain
   * text, at most 160 characters, grounded in its own item or seed, never
   * claiming anything was saved. Absent from older servers.
   */
  understood?: CaptureUnderstoodPoint[];
  /**
   * Which version of this proposal this is (M2b). Every write to it — a
   * structured edit, a clarification answer, the confirm — checks the
   * revision the person was looking at and writes the next one, so what was
   * seen is what is saved. Absent from older servers (read as 0).
   */
  revision?: number;
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
  /**
   * The selected items the person confirmed as weekly blocks rather than
   * one-offs («ثابت أسبوعي»). Each must be selected and carry a `weeklyBlock`
   * offer, or the whole confirm is `invalid_selection`. Only a `title` edit
   * may accompany one; a time edit is `invalid_edit` (the block's days and
   * hours are changed on the block itself, after it exists).
   */
  weeklyBlockItemIds?: string[];
  /**
   * The selected items whose suggested goal link (`goalLink`) the person kept
   * on the card. Each one's commitment is linked to that goal after it is
   * saved, so the goal's progress counts it; an item not named here is saved
   * unlinked. An id without a stored suggestion is ignored, never an error.
   */
  goalLinkItemIds?: string[];
  /**
   * The proposal revision the person confirmed (M2b). Compared inside the
   * confirm's transaction after the idempotent replay check; a mismatch saves
   * nothing and answers 409 `proposal_changed`. May be absent only while the
   * stored proposal is still at revision 0 (an older app).
   */
  revision?: number;
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
  /**
   * Why the write failed, when `failureCode` is `persistence_failed` (#419).
   *
   * `persistence_failed` is one code for every way a durable write can go
   * wrong, and the two it most often means need opposite responses: a database
   * under load that lost a race, and a genuine durability regression. Told
   * apart only by re-running, which is what made the emulator idempotency test
   * unreadable — a contended run and a broken one printed the same line.
   *
   * A short name — `ABORTED`, `UNAVAILABLE`, `PERMISSION_DENIED`,
   * `contention after 5 attempts` — and never the underlying message, which
   * quotes document paths and so carries uids. The full error is logged where
   * operators can read it. Nothing branches on this: it is for the human
   * reading the failure, and a caller that wants to retry should look at
   * `failureCode`.
   */
  failureCause?: string;
}

export const CAPTURE_PERSISTENCE_POLICY = Object.freeze({
  proposalCanPersist: false,
  confirmationRequired: true,
  adapterOwnsCanonicalWrites: true,
  atomicBatchRequired: true,
  rawInputInAudit: false,
});

/** One line of `CaptureProposalContract.understood` (M2a). `habit` is M3. */
export type CaptureUnderstoodPoint =
  | { kind: 'commitment'; itemId: string; text: string }
  | { kind: 'possible_goal' | 'consideration' | 'idea' | 'waiting_for'; seedItemId: string; text: string };

/** The longest `understood` line the server sends. */
export const UNDERSTOOD_TEXT_MAX = 160;

/* ── M2b: structured proposal edits (CONTRACT v4) ───────────────────── */

/** The longest title or seed summary a structured edit may set. */
export const CAPTURE_EDIT_TEXT_MAX = 120;

/**
 * One atomic change to one point of the conversation's current proposal,
 * sent as `edit` on `POST /api/mobile/capture/chat` (M2b, condition 7).
 * Proposal-only and deterministic on both engines; nothing is persisted
 * beyond the proposal until the ordinary confirm.
 */
export interface CaptureProposalEditContract {
  proposalId: string;
  /** The revision the person was looking at. */
  revision: number;
  target: { itemId: string } | { seedItemId: string };
  /** At least one field; all applied together or none. `text` and `rejectCorrectionIds` never together. */
  change: {
    kind?: 'commitment' | 'possible_goal' | 'consideration' | 'idea' | 'waiting_for';
    text?: string;
    /** `at` null = no time. `timeZone` is the IANA zone the app displayed. Only for a commitment. */
    time?: { at: string | null; timeZone: string };
    rejectCorrectionIds?: string[];
  };
}

/** The chat route's request: a new message, or an edit — never both (M2b). */
export type CaptureChatRequestContract =
  | { conversationId?: string | null; message: string; spoken?: boolean; timezone: string; referenceTime?: string; locale?: CaptureAppLocale }
  | { conversationId: string; edit: CaptureProposalEditContract; timezone: string; referenceTime?: string; locale?: CaptureAppLocale };

/**
 * 409 `proposal_changed` (M2b): the write was against a revision that is no
 * longer current, or the proposal was already confirmed by another intent.
 * Nothing was saved. The chat edit carries the current chat answer; confirm,
 * clarify and seed keep carry the current proposal (they also serve proposals
 * with no conversation: shares, meeting prep, Google imports).
 */
export type CaptureProposalChangedContract =
  | { reason: 'proposal_changed'; answer: unknown /* the CaptureChatAnswer the chat route returns */ }
  | { reason: 'proposal_changed'; proposal: CaptureProposalContract; state: 'open' | 'confirmed'; confirmation?: CaptureConfirmationResultContract };
