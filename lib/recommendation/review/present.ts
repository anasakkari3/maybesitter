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
  evaluateRecommendationStaleness,
  offeredOptions,
  resolveEvidenceRoots,
  summarizeOptionSet,
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
  WHOLE_OFFER_VERDICTS,
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
 * Epoch millis, or null when the value does not parse.
 *
 * Copied in shape from #33's private `instantToMillis` and for the same reason
 * stated there: never a lexicographic comparison of the strings, because
 * `2026-01-01T00:00:00Z` and `2026-01-01T00:00:00.000+00:00` denote one instant
 * and compare unequal. This module only needs the *parses / does not parse*
 * half, so nothing here re-implements #33's comparisons — the staleness verdict
 * is #33's to compute and this file asks it rather than repeating it.
 */
function parses(value: unknown): boolean {
  if (typeof value !== 'string' || isBlank(value)) return false;
  return !Number.isNaN(Date.parse(value));
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
  for (let index = 0; index < reason.supportedBy.length; index += 1) {
    const roots = resolveEvidenceRoots(recommendation.evidence, reason.supportedBy[index]);
    if (roots === null) continue;
    for (let root = 0; root < roots.length; root += 1) kinds.add(roots[root].source.kind);
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
  const summary = summarizeOptionSet(recommendation.options);
  const view: AttributedReviewView = {
    ...base,
    heading: chrome.heading,
    mode: 'attributed',
    leadHeading: chrome.leadHeading,
    alternativesHeading: chrome.alternativesHeading,
    excludedHeading: chrome.excludedHeading,
    soleness: summary.soleness,
    solenessNotice: SOLENESS_COPY[locale][summary.soleness],
    lead: optionCard(recommendation, locale, summary.lead),
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

  if (submission.recommendationId !== recommendation.recommendationId) {
    return {
      ok: false,
      findings: [
        finding(
          'RECOMMENDATION_ID_MISMATCH',
          'recommendationId',
          null,
          'the submission names a different recommendation than the one supplied',
        ),
      ],
    };
  }

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
  const offerSize = offeredOptions(offered.options).length;
  const position = targetPosition(submission.target);
  const wholeOffer = (WHOLE_OFFER_VERDICTS as readonly RecommendationDecisionVerdict[]).includes(
    submission.verdict,
  );

  if (position === null) {
    if (!wholeOffer) {
      findings.push(
        finding(
          'TARGET_REQUIRED',
          'target',
          null,
          'this verdict is about one option and the submission names no position',
        ),
      );
    }
  } else if (!Number.isInteger(position) || position < 0 || position >= offerSize) {
    findings.push(
      finding(
        'TARGET_OUT_OF_RANGE',
        'target',
        position,
        `the submission names a position outside an offer of ${offerSize} options`,
      ),
    );
  }

  if (submission.verdict === 'edit') {
    if (submission.editedTitle === undefined || isBlank(submission.editedTitle)) {
      findings.push(
        finding(
          'EDIT_TITLE_REQUIRED',
          'editedTitle',
          position,
          'an edit carries no replacement text, so the proposed wording would be recorded as what the reviewer wrote',
        ),
      );
    } else if (submission.editedTitle.length > RECOMMENDATION_REVIEW_LIMITS.maxEditedTitleLength) {
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

  // Blind reviewers name a slot; an adapter needs an offer position. The
  // translation happens here, from the salt. The range check above has already
  // returned if the slot was out of range, so this resolves.
  let optionIndex: number | null = position;
  if (submission.target.mode === 'blind' && position !== null) {
    optionIndex = resolveBlindSlot(offered, submission.target.blindingSalt, position);
  }

  return {
    ok: true,
    outcome: { status: 'confirmed', persisted: false, notice: chrome.announceConfirmed },
    handoff: {
      recommendationId: recommendation.recommendationId,
      optionIndex,
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
 * A **total** structural check on a recommendation arriving as `unknown`.
 *
 * The previous revision of this function was a deliberately shallow envelope
 * check that handed everything else to `checkRecommendation`, on the reasoning
 * that re-validating #33's invariants here would be a second, disagreeing copy
 * of that checker. That reasoning was right about *invariants* and wrong about
 * *shape*, and the difference cost a whole class of 500s.
 *
 * `checkRecommendation` is typed `(recommendation: Recommendation)`. It is total
 * over that type and over nothing else — it reads `node.derivedFrom.length`,
 * `option.confidence.basis`, `candidate.exclusion`, and every one of those is a
 * `TypeError` on input a caller can send. Twelve hand-written malformed bodies
 * threw on both the `present` and the `decide` path, from a public route: an
 * `options` object with no `options` array, `[null, null]`, `kind: "nonsense"`,
 * `evidence.nodes: [null, 3, "x"]`, a `withheld` outcome with `reasons:
 * [null, 5]`. The route's `try` covered `request.json()` only, so every one of
 * them escaped `POST` as an unhandled `TypeError`.
 *
 * The division of labour that is actually correct: **this file owns shape, #33
 * owns meaning.** "Is `derivedFrom` an array of strings" is a question about
 * whether the value is a `Recommendation` at all, and it has to be answered
 * before anything typed `(r: Recommendation)` may be called. "Does
 * `derivedFrom` name a node that exists, without a cycle" is #33's, and nothing
 * here duplicates it — this function never reports `UNKNOWN_EVIDENCE_NODE`,
 * `CYCLIC_EVIDENCE`, `CONFIDENCE_BAND_MISMATCH` or any other member of #33's
 * taxonomy.
 *
 * Gates are staged: each returns as soon as it has anything to say, because
 * every later gate reads through what an earlier one just reported broken.
 * That is `planningContracts`' suppression rule, and here it is also what keeps
 * the validator itself from crashing.
 */
function malformed(field: string, detail: string): ReviewFinding {
  return finding('MALFORMED_RECOMMENDATION', field, null, detail);
}

function tooLarge(field: string, detail: string): ReviewFinding {
  return finding('RECOMMENDATION_TOO_LARGE', field, null, detail);
}

function isStringArray(value: unknown): value is readonly string[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (typeof value[index] !== 'string') return false;
  }
  return true;
}

/** Shape of one `EvidenceBackedReason`, whichever partition it belongs to. */
function checkReasonShape(value: unknown, field: string): ReviewFinding[] {
  if (!isRecord(value)) return [malformed(field, 'a reason is not an object')];
  if (typeof value.code !== 'string') return [malformed(field, 'a reason carries no code')];
  if (typeof value.detail !== 'string') return [malformed(field, 'a reason carries no detail')];
  if (!isStringArray(value.supportedBy) || value.supportedBy.length === 0) {
    return [malformed(field, 'a reason names no evidence, or names it with something other than node ids')];
  }
  if (value.supportedBy.length > RECOMMENDATION_REVIEW_LIMITS.maxEvidenceRefsPerReason) {
    return [tooLarge(field, `a reason cites more than ${RECOMMENDATION_REVIEW_LIMITS.maxEvidenceRefsPerReason} evidence nodes`)];
  }
  return [];
}

function checkActionShape(value: unknown, field: string): ReviewFinding[] {
  if (!isRecord(value)) return [malformed(field, 'an action is not an object')];
  if (typeof value.commitmentId !== 'string') return [malformed(field, 'an action names no commitment')];
  switch (value.kind) {
    case 'do_now':
      return [];
    case 'schedule':
      if (!isRecord(value.slot) || typeof value.slot.startsAt !== 'string' || typeof value.slot.endsAt !== 'string') {
        return [malformed(field, 'a schedule action carries no readable slot')];
      }
      return [];
    case 'decompose':
      return typeof value.proposalId === 'string' ? [] : [malformed(field, 'a decompose action names no proposal')];
    case 'defer':
      return typeof value.until === 'string' ? [] : [malformed(field, 'a defer action names no target instant')];
    default:
      return [malformed(field, 'an action names no supported kind')];
  }
}

function checkOptionShape(value: unknown, field: string): ReviewFinding[] {
  if (!isRecord(value)) return [malformed(field, 'an option is not an object')];
  if (typeof value.optionIndex !== 'number' || !Number.isFinite(value.optionIndex)) {
    return [malformed(field, 'an option carries no numeric index')];
  }
  const action = checkActionShape(value.action, `${field}.action`);
  if (action.length > 0) return action;
  if (!Array.isArray(value.support) || value.support.length === 0) {
    return [malformed(field, 'an option states no support')];
  }
  if (value.support.length > RECOMMENDATION_REVIEW_LIMITS.maxReasonsPerOption) {
    return [tooLarge(field, `an option states more than ${RECOMMENDATION_REVIEW_LIMITS.maxReasonsPerOption} reasons`)];
  }
  for (let index = 0; index < value.support.length; index += 1) {
    const reason = checkReasonShape(value.support[index], `${field}.support[${index}]`);
    if (reason.length > 0) return reason;
  }
  const confidence = value.confidence;
  if (!isRecord(confidence)) return [malformed(field, 'an option carries no confidence')];
  if (typeof confidence.value !== 'number') return [malformed(field, 'a confidence carries no numeric value')];
  if (typeof confidence.band !== 'string') return [malformed(field, 'a confidence carries no band')];
  if (!isStringArray(confidence.basis) || confidence.basis.length === 0) {
    return [malformed(field, 'a confidence rests on no named evidence')];
  }
  return [];
}

function checkExcludedShape(value: unknown, field: string): ReviewFinding[] {
  if (!isRecord(value)) return [malformed(field, 'an excluded candidate is not an object')];
  const action = checkActionShape(value.action, `${field}.action`);
  if (action.length > 0) return action;
  if (!Array.isArray(value.exclusion) || value.exclusion.length === 0) {
    return [malformed(field, 'an excluded candidate states no cause')];
  }
  if (value.exclusion.length > RECOMMENDATION_REVIEW_LIMITS.maxReasonsPerOption) {
    return [tooLarge(field, 'an excluded candidate states too many reasons')];
  }
  for (let index = 0; index < value.exclusion.length; index += 1) {
    const reason = checkReasonShape(value.exclusion[index], `${field}.exclusion[${index}]`);
    if (reason.length > 0) return reason;
  }
  return [];
}

function checkEvidenceShape(value: unknown): ReviewFinding[] {
  if (!isRecord(value) || !Array.isArray(value.nodes)) {
    return [malformed('recommendation.evidence', 'the evidence graph carries no node list')];
  }
  if (value.nodes.length > RECOMMENDATION_REVIEW_LIMITS.maxEvidenceNodes) {
    // Checked before the per-node walk, and before anything is handed to #33:
    // this cap is what bounds both the recursion depth in `resolveEvidenceRoots`
    // and the quadratic term in the cycle detector.
    return [
      tooLarge(
        'recommendation.evidence.nodes',
        `the evidence graph carries more than ${RECOMMENDATION_REVIEW_LIMITS.maxEvidenceNodes} nodes`,
      ),
    ];
  }
  for (let index = 0; index < value.nodes.length; index += 1) {
    const node = value.nodes[index];
    const field = `recommendation.evidence.nodes[${index}]`;
    if (!isRecord(node)) return [malformed(field, 'an evidence node is not an object')];
    if (typeof node.nodeId !== 'string') return [malformed(field, 'an evidence node carries no id')];
    if (!isRecord(node.claim) || typeof node.claim.kind !== 'string') {
      return [malformed(field, 'an evidence node carries no readable claim')];
    }
    if (node.kind === 'observed') {
      if (!isRecord(node.source) || typeof node.source.kind !== 'string') {
        return [malformed(field, 'an observed node names no trusted source')];
      }
      if (typeof node.valueFingerprint !== 'string') {
        return [malformed(field, 'an observed node carries no value fingerprint')];
      }
      if (node.observedAt !== null && typeof node.observedAt !== 'string') {
        return [malformed(field, 'an observed node carries an unreadable observation instant')];
      }
      continue;
    }
    if (node.kind === 'derived') {
      if (typeof node.rule !== 'string') return [malformed(field, 'a derived node names no rule')];
      if (!isStringArray(node.derivedFrom) || node.derivedFrom.length === 0) {
        return [malformed(field, 'a derived node names no parents, so it is an unsourced claim')];
      }
      if (node.derivedFrom.length > RECOMMENDATION_REVIEW_LIMITS.maxParentsPerNode) {
        return [tooLarge(field, 'a derived node names too many parents')];
      }
      continue;
    }
    return [malformed(field, 'an evidence node is neither observed nor derived')];
  }
  return [];
}

function checkOptionSetShape(value: unknown): ReviewFinding[] {
  if (!isRecord(value)) return [malformed('recommendation.options', 'the offer is not an object')];
  const field = 'recommendation.options';
  if (value.kind === 'choice') {
    if (!Array.isArray(value.options)) return [malformed(field, 'a choice carries no option list')];
    if (value.options.length > RECOMMENDATION_REVIEW_LIMITS.maxOfferedOptions) {
      return [tooLarge(field, `a choice carries more than ${RECOMMENDATION_REVIEW_LIMITS.maxOfferedOptions} options`)];
    }
    if (value.options.length < 2) {
      // #33's `choice` variant is a tuple of at least two. One option in a
      // `choice` is the `{ primary, alternatives }` shape decision 2 forbids,
      // arriving through a hole in the wire format instead of through the type.
      return [malformed(field, 'a choice carries fewer than two options')];
    }
    for (let index = 0; index < value.options.length; index += 1) {
      const option = checkOptionShape(value.options[index], `${field}.options[${index}]`);
      if (option.length > 0) return option;
    }
    return checkExcludedListShape(value.excluded, field, false);
  }
  if (value.kind === 'sole_survivor') {
    const option = checkOptionShape(value.option, `${field}.option`);
    if (option.length > 0) return option;
    return checkExcludedListShape(value.excluded, field, true);
  }
  if (value.kind === 'only_candidate') {
    const option = checkOptionShape(value.option, `${field}.option`);
    if (option.length > 0) return option;
    if (!isStringArray(value.attested) || value.attested.length === 0) {
      return [malformed(field, 'an only-candidate offer attests to nothing, so "nothing else existed" is unsourced')];
    }
    return [];
  }
  return [malformed(field, 'the offer names no supported soleness kind')];
}

function checkExcludedListShape(value: unknown, field: string, required: boolean): ReviewFinding[] {
  if (!Array.isArray(value)) return [malformed(field, 'the excluded list is not a list')];
  if (required && value.length === 0) {
    return [malformed(field, 'a sole survivor states nothing that was ruled out, which is what makes it a proposal')];
  }
  if (value.length > RECOMMENDATION_REVIEW_LIMITS.maxExcludedCandidates) {
    return [tooLarge(field, 'the excluded list is longer than the limit')];
  }
  for (let index = 0; index < value.length; index += 1) {
    const candidate = checkExcludedShape(value[index], `${field}.excluded[${index}]`);
    if (candidate.length > 0) return candidate;
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
  const evidence = checkEvidenceShape(value.evidence);
  if (evidence.length > 0) return evidence;

  if (value.outcome === 'offered') return checkOptionSetShape(value.options);
  if (value.outcome === 'withheld') {
    if (!Array.isArray(value.reasons) || value.reasons.length === 0) {
      return [malformed('recommendation.reasons', 'a withheld recommendation states no reason, so its refusal is unsourced')];
    }
    if (value.reasons.length > RECOMMENDATION_REVIEW_LIMITS.maxReasonsPerOption) {
      return [tooLarge('recommendation.reasons', 'a withheld recommendation states too many reasons')];
    }
    for (let index = 0; index < value.reasons.length; index += 1) {
      const reason = checkReasonShape(value.reasons[index], `recommendation.reasons[${index}]`);
      if (reason.length > 0) return reason;
    }
    return [];
  }
  return [malformed('recommendation.outcome', 'the recommendation is neither offered nor withheld')];
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
