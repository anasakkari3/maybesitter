/**
 * Turning a `Recommendation` into something a reviewer can act on.
 *
 * Pure. No React, no `fetch`, no clock, no randomness, no I/O. Every instant and
 * every fingerprint arrives as an argument, which is what makes the freshness
 * rules testable at all — #33's `RECOMMENDATION_PERSISTENCE_POLICY.noAmbientClock`
 * exists because an expiry check that reads the clock is unreplayable in an audit,
 * and an audit is the point of having an expiry.
 *
 * ── Why everything lives here ────────────────────────────────────────────
 *
 * This repo has **no DOM test infrastructure** — no testing-library, no jsdom,
 * no browser driver, and adding one is a dependency change nobody reviewed for
 * this issue. So the accessibility criterion cannot be met by rendering and
 * driving a component. The response is not to test less; it is to move
 * everything that can be wrong out of the component. Redaction, confirmation,
 * option targeting, staleness, copy selection and ordering are all decided in
 * this file, against real assertions in `tests/recommendation/`. What is left in
 * `RecommendationReview.tsx` is a map from a view model to elements, and
 * `tests/recommendation/reviewAccessibility.test.ts` checks the structure of
 * that map by reading the source — with an explicit statement, in its header, of
 * what that does and does not prove.
 *
 * ── Validate before rendering ────────────────────────────────────────────
 *
 * `presentRecommendation` runs #33's `checkRecommendation` and
 * `evaluateRecommendationStaleness` before it builds an offer, and refuses to
 * build one if either reports anything. It does this even though #34's selector
 * is expected to run the same checks before emitting, and that duplication is
 * the point: Sprint 05's rule is that a check owned by the thing it checks is
 * not a check, and #33 says at `checkRecommendation` that it is "what #34 runs
 * before emitting and what #35 runs before rendering — both, deliberately".
 *
 * The order is defective → stale → withheld, and it is a suppression order, not
 * a preference. A staleness verdict over a graph already reported malformed
 * borrows its bounds from the malformed thing: `SOURCE_UNVERIFIABLE` against a
 * duplicated node id says nothing a reader can act on. The reverse is not true,
 * so nothing is suppressed in the other direction.
 *
 * ── Blinding ────────────────────────────────────────────────────────────
 *
 * `blindSlotOrder` is a pure function of the recommendation's *actions* and the
 * caller's salt. It never reads `optionIndex`, `confidence` or the offer's array
 * order, so the slot ordering carries no information about which option the
 * first pass preferred — see `lib/calibration/contracts.ts` for the calibration
 * round that lost to exactly this confound. The mapping from slot back to offer
 * position is recomputed server-side by `resolveBlindSlot`; it is never put on
 * the wire, so it is not something a blind client is trusted to keep — it is
 * something a blind client never had.
 *
 * The sort key contains `actionKey(...)`, which contains a `commitmentId`. It is
 * internal and never rendered, on exactly the terms #33 states for `actionKey`
 * itself: "It is *not* safe to put in a `detail` string — it contains
 * `commitmentId` — which is why the checkers below compare keys internally and
 * report positions."
 */

import {
  actionKey,
  checkRecommendation,
  checkRecommendationDecision,
  evaluateRecommendationStaleness,
  offeredOptions,
  resolveEvidenceRoots,
  summarizeOptionSet,
  isInstant,
} from '../../../src/contracts/v1/recommendationContracts';
import type {
  EvidenceNodeId,
  Instant,
  OfferedRecommendation,
  Recommendation,
  RecommendationDecisionVerdict,
  RecommendationDefectCode,
  RecommendationOption,
  RecommendedAction,
  StalenessReasonCode,
  SupportReason,
  TrustedSource,
  WithholdingReasonCode,
} from '../../../src/contracts/v1/recommendationContracts';
import { compareByCodePoint } from '../../planning/shared/compare';
import {
  ACTION_KIND_COPY,
  CONFIDENCE_BAND_COPY,
  EXCLUSION_REASON_COPY,
  NOTHING_TO_REVIEW_COPY,
  REVIEW_CHROME,
  SOLENESS_COPY,
  SOURCE_KIND_COPY,
  SUPPORT_REASON_COPY,
  VERDICT_COPY,
} from './copy';
import {
  BLIND_REDACTED_FIELDS,
  CONFIRMING_VERDICTS,
  RECOMMENDATION_REVIEW_LIMITS,
  RECOMMENDATION_REVIEW_POLICY,
  RECOMMENDATION_REVIEW_SCHEMA_VERSION,
  REVIEW_LOCALES,
  REVIEW_MODES,
  RTL_REVIEW_LOCALES,
  targetPosition,
} from './reviewContract';
import type {
  AttributedReviewView,
  ReviewPersistenceHandoff,
  BlindReviewSlot,
  BlindReviewView,
  NothingToReviewCause,
  NothingToReviewView,
  ReviewActionSubject,
  ReviewDecisionOutcome,
  ReviewDecisionSubmission,
  ReviewDirection,
  ReviewExclusionLine,
  ReviewFinding,
  ReviewFindingCode,
  ReviewLocale,
  ReviewMode,
  ReviewOptionCard,
  ReviewReasonLine,
  ReviewResponse,
  ReviewTarget,
  ReviewVerdictAction,
  ReviewView,
} from './reviewContract';

/* ── Small shared helpers ────────────────────────────────────────── */

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

/**
 * Whether a value is an instant the contract would accept.
 *
 * Delegated to `isInstant`, exported by `recommendationContracts` in `092d5e7`.
 * This file previously carried a byte-for-byte copy of the contract's pattern,
 * because the rule was module-private and `decidedAt`/`confirmedAt` are checked
 * by no contract function. The copy was marked with the condition for its own
 * deletion and that condition is now met.
 *
 * The delegated check is also *stronger* than the copy it replaces. A pattern
 * match accepts `2026-02-30T00:00:00Z`, which `Date.parse` silently rolls to
 * March 2 — so an expiry written as a date that does not exist would have kept
 * a recommendation live two days past its stated life, reported by nothing.
 * `isInstant` is derived from `instantToMillis`, which round-trips the fields
 * and rejects it.
 */
function parses(value: unknown): boolean {
  return isInstant(value);
}

function finding(
  code: ReviewFindingCode,
  field: string | null,
  position: number | null,
  detail: string,
): ReviewFinding {
  return { code, field, position, detail };
}

/**
 * The id of the element that names the whole surface.
 *
 * A constant, and derived from nothing the caller supplied. An id built from a
 * `recommendationId` would put a caller-chosen free string into the DOM and into
 * every accessibility-tree dump taken of the page, which is the leak #33's rule
 * on `detail` strings exists for — a rendered id is as readable as rendered
 * text.
 */
export const REVIEW_HEADING_ELEMENT_ID = 'recommendation-review-title';

export function directionFor(locale: ReviewLocale): ReviewDirection {
  return (RTL_REVIEW_LOCALES as readonly string[]).includes(locale) ? 'rtl' : 'ltr';
}

/**
 * The verdicts offered, with the confirmation rule attached to each.
 *
 * The same five in the same order for every offer, because a verdict that
 * appears and disappears depending on the recommendation trains a user to hunt
 * for the control they used last time. `requiresConfirmation` is read from
 * `CONFIRMING_VERDICTS` rather than restated, so the component, the presenter
 * and `evaluateReviewSubmission` cannot disagree about which acts need
 * confirming.
 */
export function verdictActions(locale: ReviewLocale): readonly [ReviewVerdictAction, ...ReviewVerdictAction[]] {
  const order: readonly RecommendationDecisionVerdict[] = ['accept', 'edit', 'defer', 'dismiss', 'done'];
  const actions = order.map((verdict) => ({
    verdict,
    label: VERDICT_COPY[locale][verdict],
    requiresConfirmation: (CONFIRMING_VERDICTS as readonly RecommendationDecisionVerdict[]).includes(verdict),
  }));
  return actions as [ReviewVerdictAction, ...ReviewVerdictAction[]];
}

/* ── The why-this-now explanation ────────────────────────────────── */

/**
 * The distinct kinds of trusted state a reason ultimately rests on.
 *
 * This walks the evidence graph rather than reading the reason's own ids: each
 * `supportedBy` node is resolved through `resolveEvidenceRoots` to the *observed*
 * nodes at the end of its ancestry, and the observed nodes' `source.kind` is what
 * comes back. A derived claim three hops from the state it summarises therefore
 * still explains itself in terms of the state, which is the difference between an
 * explanation and a label.
 *
 * `resolveEvidenceRoots` returns null for an unresolvable or cyclic reference.
 * That cannot happen for a recommendation that has already passed
 * `checkRecommendation`, and this is only ever called after it has — but null is
 * skipped rather than thrown on, because a presenter that throws on a graph the
 * checker accepted would be a second, disagreeing opinion about what a valid
 * graph is.
 *
 * Ordered with `compareByCodePoint`, never `localeCompare`: two reasons resting
 * on the same sources must produce the same sentence regardless of which one
 * cited which node first, and `localeCompare`'s result depends on the runtime's
 * ICU data and `LANG`.
 */
function rootSourceKindsFor(
  recommendation: Recommendation,
  reason: SupportReason,
): readonly TrustedSource['kind'][] {
  const kinds = new Set<TrustedSource['kind']>();
  const known = SOURCE_KIND_COPY[REVIEW_LOCALES[0]];
  for (let index = 0; index < reason.supportedBy.length; index += 1) {
    const roots = resolveEvidenceRoots(recommendation.evidence, reason.supportedBy[index]);
    if (roots === null) continue;
    for (let root = 0; root < roots.length; root += 1) {
      // An observed node whose `source` is not an object, or whose kind this
      // version has no name for, contributes nothing rather than crashing the
      // render or printing `undefined` into a sentence.
      //
      // Found by the single-site mutation sweep in `reviewApi.test.ts`, not by
      // hand: `evidence.nodes[0].source = null` reached here as a `TypeError`
      // out of a public route. #33's checkers never dereference `source`, so
      // this one is genuinely the presenter's — it is the only code that reads
      // it, and a consumer that reads a field owns being able to survive it.
      const source = roots[root].source as TrustedSource | null | undefined;
      if (source === null || source === undefined || typeof source !== 'object') continue;
      const kind = source.kind;
      if (typeof kind !== 'string') continue;
      if (!Object.prototype.hasOwnProperty.call(known, kind)) continue;
      kinds.add(kind);
    }
  }
  return Array.from(kinds).sort(compareByCodePoint);
}

/**
 * "Based on your commitments and your plan."
 *
 * Built from a closed set of localised nouns joined by the locale's own
 * separator and conjunction. There is no interpolation of anything the caller
 * supplied, so this sentence cannot carry a commitment title or an id.
 */
function basisSentence(locale: ReviewLocale, kinds: readonly TrustedSource['kind'][]): string {
  if (kinds.length === 0) return '';
  const chrome = REVIEW_CHROME[locale];
  const names = kinds.map((kind) => SOURCE_KIND_COPY[locale][kind]);
  if (names.length === 1) return `${chrome.basisPrefix}${names[0]}${chrome.basisSuffix}`;
  const head = names.slice(0, names.length - 1).join(chrome.basisSeparator);
  return `${chrome.basisPrefix}${head}${chrome.basisConjunction}${names[names.length - 1]}${chrome.basisSuffix}`;
}

function reasonLines(
  recommendation: Recommendation,
  locale: ReviewLocale,
  support: readonly [SupportReason, ...SupportReason[]],
): readonly [ReviewReasonLine, ...ReviewReasonLine[]] {
  const lines = support.map((reason) => {
    const rootSourceKinds = rootSourceKindsFor(recommendation, reason);
    return {
      code: reason.code,
      text: SUPPORT_REASON_COPY[locale][reason.code],
      citedNodeCount: reason.supportedBy.length,
      rootSourceKinds,
      basisText: basisSentence(locale, rootSourceKinds),
    };
  });
  return lines as [ReviewReasonLine, ...ReviewReasonLine[]];
}

/**
 * The identifiers an action carries, kept in one droppable object.
 *
 * Every branch is filled explicitly rather than spread, so a new
 * `RecommendedAction` variant is a compile error here instead of a card that
 * silently loses its subject.
 */
function subjectOf(action: RecommendedAction): ReviewActionSubject {
  switch (action.kind) {
    case 'do_now':
      return { commitmentId: action.commitmentId, slot: null, until: null, proposalId: null };
    case 'schedule':
      return { commitmentId: action.commitmentId, slot: action.slot, until: null, proposalId: null };
    case 'decompose':
      return { commitmentId: action.commitmentId, slot: null, until: null, proposalId: action.proposalId };
    case 'defer':
      return { commitmentId: action.commitmentId, slot: null, until: action.until, proposalId: null };
  }
}

/* ── Blinding ────────────────────────────────────────────────────── */

/**
 * FNV-1a, 32-bit, so the salt actually changes the ordering.
 *
 * Without a mixing step, sorting on `salt + actionKey` sorts on `actionKey`: a
 * common prefix contributes nothing to a comparison, so every salt would produce
 * the same order and a rater working through many items would learn the
 * ordering. Non-cryptographic on purpose — this hides the *offer order* from an
 * evaluator, it is not a secrecy mechanism, and calling it one would be the more
 * dangerous claim. No dependency is added for it.
 */
function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Internal only. Contains a `commitmentId` and never leaves this module.
 *
 * The `actionKey` tail is the tie-break, and it is what makes the order *total*:
 * two options can collide in 32 bits, and a comparator that returned 0 there
 * would hand the tie to `Array.prototype.sort`, whose behaviour for equal
 * elements would then be the only thing deciding a slot position — an
 * implementation detail leaking into a blind ordering. `actionKey` is unique
 * across offered options because `DUPLICATE_OPTION_ACTION` is a checked defect.
 */
function blindSortKey(salt: string, action: RecommendedAction): string {
  const key = actionKey(action);
  return `${fnv1a32(`${salt}\u0000${key}`).toString(16).padStart(8, '0')}:${key}`;
}

/**
 * Offer positions in blind-slot order: `blindSlotOrder(...)[slotIndex]` is the
 * `optionIndex` that slot shows.
 *
 * Reads only `option.action`. It never reads `optionIndex`, `confidence`,
 * `support` or the array order, which is what makes "the slot ordering carries
 * no information about the first pass's preference" a property of the code
 * rather than a claim about it.
 */
export function blindSlotOrder(recommendation: OfferedRecommendation, salt: string): readonly number[] {
  const options = offeredOptions(recommendation.options);
  const positions: number[] = [];
  for (let index = 0; index < options.length; index += 1) positions.push(index);
  return positions.sort((left, right) =>
    compareByCodePoint(blindSortKey(salt, options[left].action), blindSortKey(salt, options[right].action)),
  );
}

/** The offer position behind a blind slot, or null when the slot is out of range. */
export function resolveBlindSlot(
  recommendation: OfferedRecommendation,
  salt: string,
  slotIndex: number,
): number | null {
  if (!Number.isInteger(slotIndex) || slotIndex < 0) return null;
  const order = blindSlotOrder(recommendation, salt);
  return slotIndex < order.length ? order[slotIndex] : null;
}

/* ── Presentation ────────────────────────────────────────────────── */

interface PresentReviewCommon {
  readonly recommendation: Recommendation;
  readonly locale: ReviewLocale;
  readonly now: Instant;
  readonly currentFingerprints: Readonly<Record<EvidenceNodeId, string | null>>;
}

/**
 * A union rather than `mode` plus a nullable salt.
 *
 * `{ mode: 'blind', blindingSalt: null }` was constructible in an earlier
 * revision and produced an ordering every caller could reproduce, which is the
 * opposite of blinding. The union makes it unrepresentable; the request boundary
 * remains the runtime guard against a *blank* salt, since a type cannot check
 * whitespace.
 */
export type PresentReviewInput =
  | (PresentReviewCommon & { readonly mode: 'attributed' })
  | (PresentReviewCommon & { readonly mode: 'blind'; readonly blindingSalt: string });

function distinct<T>(values: readonly T[]): readonly T[] {
  const seen = new Set<T>();
  const output: T[] = [];
  for (let index = 0; index < values.length; index += 1) {
    if (seen.has(values[index])) continue;
    seen.add(values[index]);
    output.push(values[index]);
  }
  return output;
}

function nothingToReview(
  input: PresentReviewInput,
  cause: NothingToReviewCause,
  codes: {
    withholding?: readonly WithholdingReasonCode[];
    staleness?: readonly StalenessReasonCode[];
    defects?: readonly RecommendationDefectCode[];
  },
): NothingToReviewView {
  return {
    schema: RECOMMENDATION_REVIEW_SCHEMA_VERSION,
    recommendationId: input.recommendation.recommendationId,
    locale: input.locale,
    direction: directionFor(input.locale),
    heading: REVIEW_CHROME[input.locale].headingNothing,
    headingElementId: REVIEW_HEADING_ELEMENT_ID,
    confirmNotice: REVIEW_CHROME[input.locale].confirmNotice,
    confirmPrompt: REVIEW_CHROME[input.locale].confirmPrompt,
    confirmLabel: REVIEW_CHROME[input.locale].confirmButton,
    cancelLabel: REVIEW_CHROME[input.locale].cancelButton,
    whyHeading: REVIEW_CHROME[input.locale].whyHeading,
    mode: 'none',
    cause,
    message: NOTHING_TO_REVIEW_COPY[input.locale][cause],
    withholdingCodes: codes.withholding ?? [],
    stalenessCodes: codes.staleness ?? [],
    defectCodes: codes.defects ?? [],
  };
}

function optionCard(
  recommendation: Recommendation,
  locale: ReviewLocale,
  option: RecommendationOption,
): ReviewOptionCard {
  return {
    optionIndex: option.optionIndex,
    actionKind: option.action.kind,
    actionLabel: ACTION_KIND_COPY[locale][option.action.kind],
    subject: subjectOf(option.action),
    whyThisNow: reasonLines(recommendation, locale, option.support),
    confidence: option.confidence.band,
    confidenceLabel: CONFIDENCE_BAND_COPY[locale][option.confidence.band],
    elementId: `recommendation-review-option-${option.optionIndex}`,
  };
}

/**
 * The one entry point that turns a recommendation into a view.
 *
 * Total: every input produces a `ReviewView`, and the three refusal causes are
 * views rather than errors. A reviewer told "there is nothing to show you, and
 * the reason is `SOURCE_CHANGED`" is better served than one shown a 500, and the
 * caller gets a shape it can render either way.
 */
export function presentRecommendation(input: PresentReviewInput): ReviewView {
  const { recommendation, locale } = input;

  const defects = checkRecommendation(recommendation);
  if (defects.length > 0) {
    return nothingToReview(input, 'defective', {
      defects: distinct(defects.map((defect) => defect.code)),
    });
  }

  const staleness = evaluateRecommendationStaleness({
    recommendation,
    now: input.now,
    currentFingerprints: input.currentFingerprints,
  });
  if (!staleness.fresh) {
    return nothingToReview(input, 'stale', {
      staleness: distinct(staleness.reasons.map((reason) => reason.code)),
    });
  }

  if (recommendation.outcome === 'withheld') {
    return nothingToReview(input, 'withheld', {
      withholding: distinct(recommendation.reasons.map((reason) => reason.code)),
    });
  }

  const chrome = REVIEW_CHROME[locale];
  const base = {
    schema: RECOMMENDATION_REVIEW_SCHEMA_VERSION,
    recommendationId: recommendation.recommendationId,
    locale,
    direction: directionFor(locale),
    headingElementId: REVIEW_HEADING_ELEMENT_ID,
    confirmNotice: chrome.confirmNotice,
    confirmPrompt: chrome.confirmPrompt,
    confirmLabel: chrome.confirmButton,
    cancelLabel: chrome.cancelButton,
    whyHeading: chrome.whyHeading,
  } as const;

  /**
   * #33's `summarizeOptionSet` returns `lead: null` and `soleness: 'unknown'`
   * for an `OptionSet.kind` this version does not know.
   *
   * Handled explicitly rather than allowed to fall through, because falling
   * through is the exact defect the contract change was made to close: the old
   * signature returned `lead: undefined` while still reporting
   * `soleness: 'only_candidate'`, so the surface asserted "this was the only
   * candidate" about a value that did not exist, and rendered without
   * complaining.
   *
   * Belt and braces by design. `checkRecommendation` above already reports
   * `UNKNOWN_OPTION_SET_KIND` and would have returned, and the request boundary
   * rejects an unknown kind before that. This branch is for a *direct library
   * caller* who reached the presenter without either, and it refuses rather than
   * renders — the whole point of `RECOMMENDATION_REVIEW_POLICY.validateBeforeRender`
   * is that the presenter does not trust the producer.
   */
  const summary = summarizeOptionSet(recommendation.options);
  if (summary.lead === null || summary.soleness === 'unknown') {
    return nothingToReview(input, 'defective', { defects: ['UNKNOWN_OPTION_SET_KIND'] });
  }
  const lead = summary.lead;

  if (input.mode === 'blind') {
    const salt = input.blindingSalt;
    const order = blindSlotOrder(recommendation, salt);
    const options = offeredOptions(recommendation.options);
    const slots = order.map((optionIndex, slotIndex): BlindReviewSlot => {
      const option = options[optionIndex];
      return {
        slotIndex,
        actionKind: option.action.kind,
        actionLabel: ACTION_KIND_COPY[locale][option.action.kind],
        subject: subjectOf(option.action),
        whyThisNow: reasonLines(recommendation, locale, option.support),
        elementId: `recommendation-review-slot-${slotIndex}`,
      };
    });
    const view: BlindReviewView = {
      ...base,
      heading: chrome.headingBlind,
      mode: 'blind',
      slotsHeading: chrome.slotsHeading,
      slots: slots as [BlindReviewSlot, ...BlindReviewSlot[]],
      verdicts: verdictActions(locale),
    };
    return view;
  }

  // `summarizeOptionSet` is the only way to reach the lead, and it hands back
  // `soleness`, `alternatives` and `excluded` with it. See #33's decision 2:
  // a renderer that wants only the lead has to visibly discard the rest.
  const view: AttributedReviewView = {
    ...base,
    heading: chrome.heading,
    mode: 'attributed',
    leadHeading: chrome.leadHeading,
    alternativesHeading: chrome.alternativesHeading,
    excludedHeading: chrome.excludedHeading,
    soleness: summary.soleness,
    solenessNotice: SOLENESS_COPY[locale][summary.soleness],
    lead: optionCard(recommendation, locale, lead),
    alternatives: summary.alternatives.map((option) => optionCard(recommendation, locale, option)),
    excluded: summary.excluded.map((candidate) => ({
      actionKind: candidate.action.kind,
      actionLabel: ACTION_KIND_COPY[locale][candidate.action.kind],
      subject: subjectOf(candidate.action),
      reasons: candidate.exclusion.map((reason) => ({
        code: reason.code,
        text: EXCLUSION_REASON_COPY[locale][reason.code],
      })) as [ReviewExclusionLine, ...ReviewExclusionLine[]],
    })),
    verdicts: verdictActions(locale),
  };
  return view;
}

/* ── Decisions ───────────────────────────────────────────────────── */

export interface DecideReviewInput {
  readonly recommendation: Recommendation;
  readonly locale: ReviewLocale;
  readonly mode: ReviewMode;
  readonly now: Instant;
  readonly currentFingerprints: Readonly<Record<EvidenceNodeId, string | null>>;
  readonly submission: ReviewDecisionSubmission;
}

/**
 * The result of ruling on a submission.
 *
 * `handoff` is a **sibling** of `outcome`, not a field inside it, and that
 * placement is the fix for a real leak: when the handoff lived in the
 * `confirmed` outcome branch, `handleReviewRequest` returned it verbatim, so a
 * blind reviewer's confirmation came back carrying `handoff.optionIndex` — the
 * offer position. Three confirmed decisions recovered the whole permutation.
 *
 * Now `handleReviewRequest` returns only `outcome`, and there is no
 * mode-dependent redaction step to get wrong: write authority is not part of the
 * response type at all. `handoff` is non-null exactly when `outcome.status` is
 * `confirmed`, and it is for a server-side adapter.
 */
export type ReviewDecisionResult =
  | {
      readonly ok: true;
      readonly outcome: ReviewDecisionOutcome;
      /** Server-side write authority. Never serialised. Null unless confirmed. */
      readonly handoff: ReviewPersistenceHandoff | null;
    }
  | { readonly ok: false; readonly findings: readonly [ReviewFinding, ...ReviewFinding[]] };

/**
 * Rule the submission on, or say why not.
 *
 * Reports; never throws — #33's `RECOMMENDATION_INPUT_POLICY` applied at the
 * decision boundary. The check order is a suppression order in the sense
 * `planningContracts` uses: a finding is emitted only when it does not borrow a
 * bound from something already reported. There is no offer to range-check a
 * position against once `NOTHING_OFFERED` has fired, so everything after it is
 * suppressed; there *is* still a verdict to check when an edit title is missing,
 * so those two are reported together.
 *
 * Nothing here writes, and nothing here can be made to write: the only branch
 * that produces a `ReviewPersistenceHandoff` is the one reached from
 * `confirmation.stage === 'confirmed'`, and even that branch returns
 * `persisted: false` — the handoff is authority for an adapter, not a record of
 * a write.
 */
export function evaluateReviewSubmission(input: DecideReviewInput): ReviewDecisionResult {
  const { submission, recommendation, locale } = input;
  const chrome = REVIEW_CHROME[locale];

  if (submission.target.mode !== input.mode) {
    return {
      ok: false,
      findings: [
        finding(
          'TARGET_MODE_MISMATCH',
          'target.mode',
          null,
          'the submission targets the offer in a different mode than the one it was reviewed in',
        ),
      ],
    };
  }

  if (submission.target.mode === 'blind' && isBlank(submission.target.blindingSalt)) {
    return {
      ok: false,
      findings: [
        finding('BLINDING_SALT_REQUIRED', 'target.blindingSalt', null, 'a blind target carries no salt'),
      ],
    };
  }

  // The same path that decides whether this can be *rendered* decides whether it
  // can be *decided on*. A recommendation too defective or too stale to show is
  // not one a decision may be recorded against, and running one checker for both
  // questions is what stops the two answers from drifting.
  const common = {
    recommendation,
    locale,
    now: input.now,
    currentFingerprints: input.currentFingerprints,
  };
  const view = presentRecommendation(
    submission.target.mode === 'blind'
      ? { ...common, mode: 'blind', blindingSalt: submission.target.blindingSalt }
      : { ...common, mode: 'attributed' },
  );
  if (view.mode === 'none') {
    return {
      ok: false,
      findings: [
        finding(
          'NOTHING_OFFERED',
          null,
          null,
          `there is no offer to decide on: the recommendation is ${view.cause}`,
        ),
      ],
    };
  }

  const findings: ReviewFinding[] = [];
  // `presentRecommendation` returned an offer view, which it does only for an
  // `offered` outcome, so this narrowing is the one the checker already made.
  const offered = recommendation as OfferedRecommendation;
  const position = targetPosition(submission.target);

  /**
   * A blind slot is resolved to an offer position *before* the contract sees it.
   *
   * `checkRecommendationDecision` reasons about `optionIndex`, which is the only
   * vocabulary the contract has. It cannot range-check a slot, because slots are
   * this module's invention — so the one bound that stays here is "is this slot
   * in the blind ordering", and everything downstream is the contract's.
   */
  let resolved = position;
  if (submission.target.mode === 'blind' && position !== null) {
    resolved = resolveBlindSlot(offered, submission.target.blindingSalt, position);
    if (resolved === null) {
      return {
        ok: false,
        findings: [
          finding('TARGET_OUT_OF_RANGE', 'target', position, 'the submission names a slot this blind view does not have'),
        ],
      };
    }
  }

  /**
   * Index bounds, verdict validity, the whole-offer rule, the edit-title rule
   * and the id match are all `checkRecommendationDecision`'s, as of `3a8158b`.
   *
   * They were re-derived here in the previous revision, which is the duplication
   * this sprint keeps paying for: two implementations of "which option does this
   * decision target" would disagree the day either moved. The codes are
   * translated into this surface's taxonomy rather than passed through, because
   * a *reviewer* is being told about the control they used — and `position` is
   * reported in their own vocabulary, so a blind reviewer sees the slot they
   * clicked and never the offer position it resolved to.
   */
  const decisionDefects = checkRecommendationDecision(recommendation, {
    version: recommendation.version,
    recommendationId: submission.recommendationId,
    optionIndex: resolved,
    verdict: submission.verdict,
    ...(submission.editedTitle === undefined ? {} : { editedTitle: submission.editedTitle }),
    decidedAt: submission.decidedAt,
  });
  const TRANSLATION: Readonly<Record<string, ReviewFindingCode>> = {
    DECISION_RECOMMENDATION_MISMATCH: 'RECOMMENDATION_ID_MISMATCH',
    DECISION_TARGETS_WITHHELD: 'NOTHING_OFFERED',
    DECISION_TARGET_REQUIRED: 'TARGET_REQUIRED',
    DECISION_TARGETS_UNKNOWN_OPTION: 'TARGET_OUT_OF_RANGE',
    DECISION_EDIT_WITHOUT_TITLE: 'EDIT_TITLE_REQUIRED',
    DECISION_UNKNOWN_VERDICT: 'MALFORMED_SUBMISSION',
  };
  for (let index = 0; index < decisionDefects.length; index += 1) {
    const defect = decisionDefects[index];
    findings.push(finding(TRANSLATION[defect.code], 'submission', position, defect.detail));
  }

  if (submission.verdict === 'edit') {
    if (submission.editedTitle !== undefined && !isBlank(submission.editedTitle)
      && submission.editedTitle.length > RECOMMENDATION_REVIEW_LIMITS.maxEditedTitleLength) {
      // Unbounded by anything else in the pipeline: a five-million-character
      // title was accepted and echoed back before this existed.
      findings.push(
        finding(
          'EDIT_TITLE_TOO_LONG',
          'editedTitle',
          position,
          `replacement text is longer than the ${RECOMMENDATION_REVIEW_LIMITS.maxEditedTitleLength} character limit`,
        ),
      );
    }
  } else if (submission.editedTitle !== undefined) {
    findings.push(
      finding(
        'EDIT_TITLE_NOT_APPLICABLE',
        'editedTitle',
        position,
        'replacement text was supplied for a verdict that does not use it',
      ),
    );
  }

  if (!parses(submission.decidedAt)) {
    findings.push(finding('INVALID_INSTANT', 'decidedAt', position, 'the decision instant does not parse'));
  }

  const confirmation = submission.confirmation;
  if (confirmation.stage === 'confirmed') {
    if (!parses(confirmation.confirmedAt)) {
      findings.push(
        finding('INVALID_INSTANT', 'confirmation.confirmedAt', position, 'the confirmation instant does not parse'),
      );
    }
    if (
      confirmation.acknowledgedVerdict !== submission.verdict ||
      confirmation.acknowledgedIndex !== position
    ) {
      findings.push(
        finding(
          'CONFIRMATION_TARGET_MISMATCH',
          'confirmation',
          position,
          'the confirmation names a different verdict or position than the decision it accompanies',
        ),
      );
    }
  }

  if (findings.length > 0) {
    return { ok: false, findings: findings as [ReviewFinding, ...ReviewFinding[]] };
  }

  const needsConfirmation = (CONFIRMING_VERDICTS as readonly RecommendationDecisionVerdict[]).includes(
    submission.verdict,
  );

  if (!needsConfirmation) {
    // `defer` and `dismiss` write nothing whether confirmed or not, so neither
    // stage produces a handoff. `NEXT_STEP_PRODUCT_POLICY.rejectionHasPenalty`
    // is false for the same reason: declining an offer that was never canonical
    // costs the user nothing and records nothing.
    return {
      ok: true,
      handoff: null,
      outcome: { status: 'recorded_without_penalty', persisted: false, notice: chrome.announceRecorded },
    };
  }

  if (confirmation.stage === 'unconfirmed') {
    return {
      ok: true,
      handoff: null,
      outcome: {
        status: 'confirmation_required',
        persisted: false,
        awaitingVerdict: submission.verdict,
        awaitingIndex: position,
        notice: chrome.confirmPrompt,
      },
    };
  }

  return {
    ok: true,
    outcome: { status: 'confirmed', persisted: false, notice: chrome.announceConfirmed },
    handoff: {
      recommendationId: recommendation.recommendationId,
      optionIndex: resolved,
      verdict: submission.verdict,
      ...(submission.verdict === 'edit' ? { editedTitle: submission.editedTitle as string } : {}),
      confirmedAt: confirmation.confirmedAt,
    },
  };
}

/* ── The request boundary ────────────────────────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * What is left for this boundary to check once #33 owns shape.
 *
 * The first revision of this file had a shallow envelope check and handed
 * everything else to `checkRecommendation`, which was typed
 * `(recommendation: Recommendation)` and total over nothing else. Twelve
 * malformed bodies escaped `POST` as unhandled `TypeError`s. The second
 * revision over-corrected into a two-hundred-line deep validator that
 * re-derived node kinds, parent lists, confidence shape, reason lists and the
 * `choice` minimum — every one of which is a question about *meaning* that #33
 * answers with a named code.
 *
 * `3a8158b` made #33's checkers total over `unknown`-shaped input and gave the
 * cases their own codes: `UNKNOWN_NODE_KIND`, `UNSOURCED_DERIVATION`,
 * `CHOICE_BELOW_MINIMUM`, `EMPTY_REASON_LIST`, `UNKNOWN_OPTION_SET_KIND`. Ten of
 * the twelve now come back as reported defects. Re-measured after the merge:
 * with this function disabled entirely, **one** of the twelve still threw.
 *
 * So this function shrank to the two things that are genuinely the boundary's:
 *
 *  1. **The envelope**, so `checkRecommendation` can be *called* at all — an id,
 *     a validity window, and an evidence node list that is a list.
 *  2. **Resource limits**, which no contract-level checker can impose because
 *     they are a property of being a public HTTP surface, not of being a
 *     recommendation.
 *
 * Plus one narrow guard, `checkActionsAreObjects`, documented at its definition.
 *
 * Everything else is deliberately *not* checked here, and the difference is
 * visible to callers: a malformed envelope is a `400`, while a structurally
 * defective recommendation is a `200` carrying a `NothingToReviewView` whose
 * `defectCodes` name what is wrong. A reviewer told "there is nothing to show
 * you, and the code is `UNSOURCED_DERIVATION`" is better served than one handed
 * a generic rejection, and that is what this contract said it would do from the
 * start.
 */
function malformed(field: string, detail: string): ReviewFinding {
  return finding('MALFORMED_RECOMMENDATION', field, null, detail);
}

function tooLarge(field: string, detail: string): ReviewFinding {
  return finding('RECOMMENDATION_TOO_LARGE', field, null, detail);
}

/**
 * Every `RecommendedAction` reachable from an offer must be an object.
 *
 * The one case that still threw after `3a8158b`: `actionKey` switches on
 * `action.kind`, and `checkRecommendation` calls it on every offered and
 * excluded action, so `action: null` is a `TypeError` from inside the contract
 * at `recommendationContracts.ts:250`. That is a gap in #33 rather than here —
 * reported upstream rather than patched, since this file must not edit the
 * contract — and this is the local guard that keeps a public route from
 * returning a 500 while the gap is open.
 *
 * Narrow on purpose. It asks only "is there an object with a string kind", not
 * what the kind means or which fields it needs; `checkRecommendation` and
 * `checkActionShape`-style questions belong to #33 and are reported by it.
 */
function checkActionsAreObjects(options: unknown): ReviewFinding[] {
  if (!isRecord(options)) return [];
  // Holders as well as actions. A `choice` legitimately has no `option` and a
  // `sole_survivor` legitimately has no `options`, so an absent *holder* is
  // normal — but a holder that is present and is not an object, or one with no
  // readable `action`, is the defect. Three separate mutation-sweep runs were
  // needed to get this predicate right: skipping `undefined` at the end let
  // `{}` through, and testing only the action let `[]` through.
  const holders: unknown[] = [];
  if (Array.isArray(options.options)) {
    for (let index = 0; index < options.options.length; index += 1) holders.push(options.options[index]);
  }
  if (options.option !== undefined) holders.push(options.option);
  if (Array.isArray(options.excluded)) {
    for (let index = 0; index < options.excluded.length; index += 1) holders.push(options.excluded[index]);
  }
  for (let index = 0; index < holders.length; index += 1) {
    const holder = holders[index];
    if (!isRecord(holder)) {
      return [malformed(`recommendation.options[${index}]`, 'an offered or excluded entry is not an object')];
    }
    const action = holder.action;
    if (!isRecord(action) || typeof action.kind !== 'string') {
      return [
        malformed(
          `recommendation.options[${index}].action`,
          'an action is not an object with a kind, which the contract checker cannot read',
        ),
      ];
    }
  }
  return [];
}

/**
 * Hard size limits, applied before anything reaches #33.
 *
 * The findings that produced these are now half-resolved upstream, and saying so
 * matters more than keeping the original justification: `3a8158b` made
 * `resolveEvidenceRoots` iterative and removed the quadratic term in the cycle
 * detector, so the measured stack overflow at 8,000 nodes and the 55.9 seconds
 * of CPU at 60,000 are both gone — re-measured here at 150,000 nodes and 19 MB,
 * which now completes in 157ms.
 *
 * They are still enforced, for a reason that is about the route rather than the
 * algorithm: App Router handlers have no default body cap, so without a limit
 * this endpoint accepts a body of arbitrary size and allocates in proportion to
 * it, unauthenticated. Refusing the input is the boundary's job whether or not
 * the code behind it happens to be fast.
 */
function checkRecommendationSize(value: Record<string, unknown>): ReviewFinding[] {
  const evidence = value.evidence;
  if (isRecord(evidence) && Array.isArray(evidence.nodes)) {
    if (evidence.nodes.length > RECOMMENDATION_REVIEW_LIMITS.maxEvidenceNodes) {
      return [
        tooLarge(
          'recommendation.evidence.nodes',
          `the evidence graph carries more than ${RECOMMENDATION_REVIEW_LIMITS.maxEvidenceNodes} nodes`,
        ),
      ];
    }
    for (let index = 0; index < evidence.nodes.length; index += 1) {
      const node = evidence.nodes[index];
      if (!isRecord(node) || !Array.isArray(node.derivedFrom)) continue;
      if (node.derivedFrom.length > RECOMMENDATION_REVIEW_LIMITS.maxParentsPerNode) {
        return [tooLarge(`recommendation.evidence.nodes[${index}]`, 'a node names too many parents')];
      }
    }
  }
  const options = value.options;
  if (isRecord(options)) {
    if (Array.isArray(options.options) && options.options.length > RECOMMENDATION_REVIEW_LIMITS.maxOfferedOptions) {
      return [
        tooLarge(
          'recommendation.options.options',
          `the offer carries more than ${RECOMMENDATION_REVIEW_LIMITS.maxOfferedOptions} options`,
        ),
      ];
    }
    if (Array.isArray(options.excluded) && options.excluded.length > RECOMMENDATION_REVIEW_LIMITS.maxExcludedCandidates) {
      return [tooLarge('recommendation.options.excluded', 'the excluded list is longer than the limit')];
    }
  }
  if (Array.isArray(value.reasons) && value.reasons.length > RECOMMENDATION_REVIEW_LIMITS.maxReasonsPerOption) {
    return [tooLarge('recommendation.reasons', 'a withheld recommendation states too many reasons')];
  }
  return [];
}

function checkRecommendationShape(value: unknown): ReviewFinding[] {
  if (!isRecord(value)) return [malformed('recommendation', 'the request carries no recommendation object')];
  if (typeof value.recommendationId !== 'string' || isBlank(value.recommendationId)) {
    return [malformed('recommendation.recommendationId', 'the recommendation carries no id')];
  }
  if (!isRecord(value.validity) || typeof value.validity.basisAt !== 'string' || typeof value.validity.expiresAt !== 'string') {
    return [malformed('recommendation.validity', 'the recommendation carries no readable validity window')];
  }
  if (!isRecord(value.evidence) || !Array.isArray(value.evidence.nodes)) {
    return [malformed('recommendation.evidence', 'the evidence graph carries no node list')];
  }
  if (value.outcome !== 'offered' && value.outcome !== 'withheld') {
    return [malformed('recommendation.outcome', 'the recommendation is neither offered nor withheld')];
  }
  const size = checkRecommendationSize(value);
  if (size.length > 0) return size;
  return checkActionsAreObjects(value.options);
}

function readFingerprints(
  value: unknown,
): Readonly<Record<EvidenceNodeId, string | null>> | 'malformed' {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) return 'malformed';
  const keys = Object.keys(value);
  for (let index = 0; index < keys.length; index += 1) {
    const entry = value[keys[index]];
    if (entry !== null && typeof entry !== 'string') return 'malformed';
  }
  return value as Readonly<Record<EvidenceNodeId, string | null>>;
}

const VERDICTS: readonly RecommendationDecisionVerdict[] = ['accept', 'edit', 'defer', 'dismiss', 'done'];

function readTarget(value: unknown): ReviewTarget | null {
  if (!isRecord(value)) return null;
  if (value.mode === 'attributed') {
    const optionIndex = value.optionIndex;
    if (optionIndex !== null && typeof optionIndex !== 'number') return null;
    return { mode: 'attributed', optionIndex: optionIndex as number | null };
  }
  if (value.mode === 'blind') {
    const slotIndex = value.slotIndex;
    if (slotIndex !== null && typeof slotIndex !== 'number') return null;
    if (typeof value.blindingSalt !== 'string') return null;
    return { mode: 'blind', slotIndex: slotIndex as number | null, blindingSalt: value.blindingSalt };
  }
  return null;
}

function readSubmission(value: unknown): ReviewDecisionSubmission | null {
  if (!isRecord(value)) return null;
  if (typeof value.recommendationId !== 'string') return null;
  if (typeof value.decidedAt !== 'string') return null;
  if (!VERDICTS.includes(value.verdict as RecommendationDecisionVerdict)) return null;
  if (value.editedTitle !== undefined && typeof value.editedTitle !== 'string') return null;
  const target = readTarget(value.target);
  if (target === null) return null;
  const confirmation = value.confirmation;
  if (!isRecord(confirmation)) return null;
  if (confirmation.stage === 'unconfirmed') {
    return {
      recommendationId: value.recommendationId,
      target,
      verdict: value.verdict as RecommendationDecisionVerdict,
      ...(value.editedTitle === undefined ? {} : { editedTitle: value.editedTitle as string }),
      decidedAt: value.decidedAt,
      confirmation: { stage: 'unconfirmed' },
    };
  }
  if (confirmation.stage !== 'confirmed') return null;
  if (!VERDICTS.includes(confirmation.acknowledgedVerdict as RecommendationDecisionVerdict)) return null;
  if (confirmation.acknowledgedIndex !== null && typeof confirmation.acknowledgedIndex !== 'number') return null;
  if (typeof confirmation.confirmedAt !== 'string') return null;
  return {
    recommendationId: value.recommendationId,
    target,
    verdict: value.verdict as RecommendationDecisionVerdict,
    ...(value.editedTitle === undefined ? {} : { editedTitle: value.editedTitle as string }),
    decidedAt: value.decidedAt,
    confirmation: {
      stage: 'confirmed',
      acknowledgedVerdict: confirmation.acknowledgedVerdict as RecommendationDecisionVerdict,
      acknowledgedIndex: confirmation.acknowledgedIndex as number | null,
      confirmedAt: confirmation.confirmedAt,
    },
  };
}

export interface ReviewRequestOutcome {
  readonly status: 200 | 400;
  readonly response: ReviewResponse;
}

function rejected(findings: readonly [ReviewFinding, ...ReviewFinding[]]): ReviewRequestOutcome {
  return { status: 400, response: { kind: 'rejected', persisted: false, findings } };
}

/**
 * The whole HTTP surface, minus HTTP.
 *
 * `src/app/api/recommendation/review/route.ts` parses the body, calls this, and
 * serialises the result. Keeping the decision here rather than in the route is
 * what makes `tests/recommendation/reviewApi.test.ts` able to assert the
 * boundary's behaviour without a server — and it means the route has no
 * behaviour of its own to drift.
 *
 * Every malformed input is a finding, never a throw. The one thing this cannot
 * catch is a body that is not JSON at all, because that fails in `request.json()`
 * before this is reached; the route converts that to `MALFORMED_REQUEST_BODY`
 * and the API test covers it.
 */
export function handleReviewRequest(body: unknown): ReviewRequestOutcome {
  if (!isRecord(body)) {
    return rejected([
      finding('MALFORMED_REQUEST_BODY', null, null, 'the request body is not a JSON object'),
    ]);
  }

  if (body.kind !== 'present' && body.kind !== 'decide') {
    return rejected([
      finding('UNSUPPORTED_REQUEST_KIND', 'kind', null, 'the request names no supported review operation'),
    ]);
  }

  const findings: ReviewFinding[] = [];

  const localeOk = (REVIEW_LOCALES as readonly string[]).includes(body.locale as string);
  if (!localeOk) {
    findings.push(finding('UNSUPPORTED_LOCALE', 'locale', null, 'the request names a locale this surface does not render'));
  }

  if (typeof body.now !== 'string' || isBlank(body.now)) {
    findings.push(finding('MISSING_EVALUATION_INSTANT', 'now', null, 'no evaluation instant was supplied'));
  } else if (!parses(body.now)) {
    findings.push(finding('INVALID_INSTANT', 'now', null, 'the evaluation instant does not parse'));
  }

  const shape = checkRecommendationShape(body.recommendation);
  for (let index = 0; index < shape.length; index += 1) findings.push(shape[index]);

  const fingerprints = readFingerprints(body.currentFingerprints);
  if (fingerprints === 'malformed') {
    findings.push(
      finding(
        'MALFORMED_FINGERPRINT_MAP',
        'currentFingerprints',
        null,
        'the fingerprint map is not a record of strings or nulls',
      ),
    );
  }

  const mode = body.mode;
  const modeOk = (REVIEW_MODES as readonly string[]).includes(mode as string);
  if (!modeOk) {
    findings.push(finding('UNSUPPORTED_REQUEST_KIND', 'mode', null, 'the request names no supported review mode'));
  } else if (mode === 'blind' && body.kind === 'present' && (typeof body.blindingSalt !== 'string' || isBlank(body.blindingSalt))) {
    findings.push(finding('BLINDING_SALT_REQUIRED', 'blindingSalt', null, 'a blind presentation carries no salt'));
  }

  let submission: ReviewDecisionSubmission | null = null;
  if (body.kind === 'decide') {
    submission = readSubmission(body.submission);
    if (submission === null) {
      findings.push(finding('MALFORMED_SUBMISSION', 'submission', null, 'the submission is not a readable decision'));
    }
  }

  if (findings.length > 0) {
    return rejected(findings as [ReviewFinding, ...ReviewFinding[]]);
  }

  const locale = body.locale as ReviewLocale;
  const recommendation = body.recommendation as Recommendation;
  const currentFingerprints = fingerprints as Readonly<Record<EvidenceNodeId, string | null>>;

  if (body.kind === 'present') {
    const common = { recommendation, locale, now: body.now as Instant, currentFingerprints };
    // The blank-salt gate above already ran, so `body.blindingSalt` is a
    // non-blank string here whenever the mode is blind.
    const view = presentRecommendation(
      mode === 'blind'
        ? { ...common, mode: 'blind', blindingSalt: body.blindingSalt as string }
        : { ...common, mode: 'attributed' },
    );
    return { status: 200, response: { kind: 'presented', persisted: false, view } };
  }

  const result = evaluateReviewSubmission({
    recommendation,
    locale,
    mode: mode as ReviewMode,
    now: body.now as Instant,
    currentFingerprints,
    submission: submission as ReviewDecisionSubmission,
  });
  if (!result.ok) return rejected(result.findings);
  // `result.handoff` is deliberately dropped here. It is server-side write
  // authority and carries the resolved offer position, which a blind reviewer
  // must never receive. See `ReviewDecisionResult`.
  return { status: 200, response: { kind: 'decided', persisted: false, outcome: result.outcome } };
}

/**
 * Re-exported so a test can assert the policy the presenter was written against
 * without importing two modules to do it, and so a reader of `present.ts` can
 * see what it claims to hold.
 */
export { BLIND_REDACTED_FIELDS, RECOMMENDATION_REVIEW_POLICY };
