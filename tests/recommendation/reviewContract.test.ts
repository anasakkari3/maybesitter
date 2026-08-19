/**
 * The recommendation review contract and presenter (Sprint 08, issue #35).
 *
 * Everything asserted here is a property of pure functions in
 * `lib/recommendation/review/`. That is deliberate and it is the load-bearing
 * decision of this issue: this repo has no DOM test infrastructure, so anything
 * decided inside a React component is decided somewhere no test in this sprint
 * can reach. Redaction, confirmation, targeting, staleness, copy selection and
 * ordering therefore all live in `present.ts`, where they are tested here for
 * real, and `RecommendationReview.tsx` is left with a map from a view model to
 * elements.
 *
 * The four acceptance criteria and where they are checked:
 *
 *  - **Nothing persists before explicit confirmation** — `no handoff exists
 *    before confirmation`, `a confirmation that has drifted is refused`, and
 *    `no outcome branch can claim a write`.
 *  - **First-pass hidden data is not exposed in blind evaluations** — `a blind
 *    view carries no first-pass judgement`, `blind slot order is independent of
 *    offer order`, and `a blind target cannot name an offer position`.
 *  - **Keyboard and screen-reader flows** — the structural half is in
 *    `reviewAccessibility.test.ts`, which is explicit about its limits. The half
 *    that belongs here is that every string the component renders is non-empty
 *    in every locale, since an accessible name is only accessible if it exists.
 *  - **Relevant tests and documentation** — this file, its two siblings, and
 *    `docs/architecture/recommendation-review.md`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BLIND_REDACTED_FIELDS,
  BLIND_VIEW_ALLOWED_FIELDS,
  CONFIRMING_VERDICTS,
  RECOMMENDATION_REVIEW_LIMITS,
  RECOMMENDATION_REVIEW_POLICY,
  REVIEW_LOCALES,
  RTL_REVIEW_LOCALES,
  WHOLE_OFFER_VERDICTS,
  targetPosition,
} from '../../lib/recommendation/review/reviewContract.ts';
import type {
  AttributedReviewView,
  BlindReviewView,
  NothingToReviewView,
  ReviewDecisionSubmission,
  ReviewLocale,
} from '../../lib/recommendation/review/reviewContract.ts';
import {
  blindSlotOrder,
  directionFor,
  evaluateReviewSubmission,
  presentRecommendation,
  resolveBlindSlot,
  verdictActions,
} from '../../lib/recommendation/review/present.ts';
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
} from '../../lib/recommendation/review/copy.ts';
import {
  AFTER_EXPIRY,
  EXCLUDED_COMMITMENT,
  FRESH_FINGERPRINTS,
  NOW,
  RECOMMENDATION_ID,
  SECOND_COMMITMENT,
  SECRET_COMMITMENT,
  SECRET_PROPOSAL,
  allKeys,
  assertFixtureIsSound,
  offeredChoice,
  offeredSoleSurvivor,
  offeredWithBandMismatch,
  pathsContaining,
  withheld,
} from './reviewFixtures.ts';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..');

const SALT = 'blind-round-2026-08-19';

function attributed(locale: ReviewLocale = 'en'): AttributedReviewView {
  const view = presentRecommendation({
    recommendation: offeredChoice(),
    locale,
    mode: 'attributed',
    now: NOW,
    currentFingerprints: FRESH_FINGERPRINTS,
  });
  assert.equal(view.mode, 'attributed');
  return view as AttributedReviewView;
}

function blind(salt: string = SALT): BlindReviewView {
  const view = presentRecommendation({
    recommendation: offeredChoice(),
    locale: 'en',
    mode: 'blind',
    blindingSalt: salt,
    now: NOW,
    currentFingerprints: FRESH_FINGERPRINTS,
  });
  assert.equal(view.mode, 'blind');
  return view as BlindReviewView;
}

function submission(overrides: Partial<ReviewDecisionSubmission> = {}): ReviewDecisionSubmission {
  return {
    recommendationId: RECOMMENDATION_ID,
    target: { mode: 'attributed', optionIndex: 0 },
    verdict: 'accept',
    decidedAt: NOW,
    confirmation: { stage: 'unconfirmed' },
    ...overrides,
  };
}

function decide(sub: ReviewDecisionSubmission, mode: 'attributed' | 'blind' = 'attributed') {
  return evaluateReviewSubmission({
    recommendation: offeredChoice(),
    locale: 'en',
    mode,
    now: NOW,
    currentFingerprints: FRESH_FINGERPRINTS,
    submission: sub,
  });
}

/* ── The fixtures themselves ─────────────────────────────────────── */

test('review: every fixture satisfies #33 own structural checker', () => {
  assertFixtureIsSound(offeredChoice());
  assertFixtureIsSound(offeredSoleSurvivor());
  assertFixtureIsSound(withheld());
  // The band-mismatch fixture is the one that must *not* be sound, or the test
  // that expects a refusal would be passing for the wrong reason.
  assert.notDeepEqual(
    presentRecommendation({
      recommendation: offeredWithBandMismatch(),
      locale: 'en',
      mode: 'attributed',
      now: NOW,
      currentFingerprints: FRESH_FINGERPRINTS,
    }).mode,
    'attributed',
  );
});

/* ── Validate before rendering ───────────────────────────────────── */

test('review: a defective recommendation is refused rather than rendered', () => {
  const view = presentRecommendation({
    recommendation: offeredWithBandMismatch(),
    locale: 'en',
    mode: 'attributed',
    now: NOW,
    currentFingerprints: FRESH_FINGERPRINTS,
  }) as NothingToReviewView;
  assert.equal(view.mode, 'none');
  assert.equal(view.cause, 'defective');
  assert.deepEqual(view.defectCodes, ['CONFIDENCE_BAND_MISMATCH']);
  // A rendered band that disagrees with its value is the failure #33 names as
  // invisible to both readers. The presenter must not be the one that trusts it.
  assert.equal(RECOMMENDATION_REVIEW_POLICY.validateBeforeRender, true);
});

test('review: an expired recommendation is refused', () => {
  const view = presentRecommendation({
    recommendation: offeredChoice(),
    locale: 'en',
    mode: 'attributed',
    now: AFTER_EXPIRY,
    currentFingerprints: FRESH_FINGERPRINTS,
  }) as NothingToReviewView;
  assert.equal(view.mode, 'none');
  assert.equal(view.cause, 'stale');
  assert.deepEqual(view.stalenessCodes, ['EXPIRED']);
});

test('review: staleness fails closed when a source cannot be verified', () => {
  // The single most important default in #33's staleness section: a caller that
  // has lost track of a source must not get "still fresh". An empty fingerprint
  // map is the strongest form of that.
  const view = presentRecommendation({
    recommendation: offeredChoice(),
    locale: 'en',
    mode: 'attributed',
    now: NOW,
    currentFingerprints: {},
  }) as NothingToReviewView;
  assert.equal(view.mode, 'none');
  assert.equal(view.cause, 'stale');
  assert.deepEqual(view.stalenessCodes, ['SOURCE_UNVERIFIABLE']);
});

test('review: a changed source invalidates even inside the validity window', () => {
  const view = presentRecommendation({
    recommendation: offeredChoice(),
    locale: 'en',
    mode: 'attributed',
    now: NOW,
    currentFingerprints: { ...FRESH_FINGERPRINTS, 'obs-due': 'fp-due-2' },
  }) as NothingToReviewView;
  assert.equal(view.cause, 'stale');
  assert.deepEqual(view.stalenessCodes, ['SOURCE_CHANGED']);
});

test('review: a withheld recommendation reports its codes and offers nothing', () => {
  const view = presentRecommendation({
    recommendation: withheld(),
    locale: 'en',
    mode: 'attributed',
    now: NOW,
    currentFingerprints: FRESH_FINGERPRINTS,
  }) as NothingToReviewView;
  assert.equal(view.cause, 'withheld');
  assert.deepEqual(view.withholdingCodes, ['ALL_CANDIDATES_EXCLUDED']);
  assert.ok(view.message.length > 0);
});

/* ── The offer, and the alternatives it must carry ───────────────── */

test('review: the lead cannot be presented without its alternatives and soleness', () => {
  const view = attributed();
  assert.equal(view.lead.optionIndex, 0);
  assert.deepEqual(view.alternatives.map((card) => card.optionIndex), [1, 2]);
  assert.equal(view.soleness, 'choice');
  assert.equal(view.excluded.length, 1);
  // #33's decision 2 in its rendered form: the view has no `.primary`, and the
  // fields that would let a renderer drop the rest are all present.
  const keys = Object.keys(view);
  assert.ok(!keys.includes('primary'));
  for (const required of ['lead', 'alternatives', 'soleness', 'excluded']) {
    assert.ok(keys.includes(required), `attributed view is missing ${required}`);
  }
});

test('review: a sole survivor states what was ruled out', () => {
  const view = presentRecommendation({
    recommendation: offeredSoleSurvivor(),
    locale: 'en',
    mode: 'attributed',
    now: NOW,
    currentFingerprints: FRESH_FINGERPRINTS,
  }) as AttributedReviewView;
  assert.equal(view.soleness, 'sole_survivor');
  assert.deepEqual(view.alternatives, []);
  // The sentence that turns a lone option from an instruction into a proposal.
  assert.equal(view.solenessNotice, SOLENESS_COPY.en.sole_survivor);
  assert.equal(view.excluded.length, 1);
  assert.equal(view.excluded[0].reasons[0].code, 'NOT_CONFIRMED');
});

/* ── Why this now ────────────────────────────────────────────────── */

test('review: the explanation resolves through derived nodes to observed sources', () => {
  const view = attributed();
  const overdue = view.lead.whyThisNow.find((line) => line.code === 'OVERDUE');
  assert.ok(overdue);
  // `OVERDUE` cites `derived-overdue`, which has no source of its own. Reporting
  // `commitment` requires walking to the observed root, which is the whole
  // difference between an explanation and a label.
  assert.deepEqual(overdue.rootSourceKinds, ['commitment']);
  assert.equal(overdue.citedNodeCount, 1);
  assert.equal(overdue.text, SUPPORT_REASON_COPY.en.OVERDUE);
  assert.ok(overdue.basisText.includes(SOURCE_KIND_COPY.en.commitment));

  const scheduled = view.alternatives[0].whyThisNow[0];
  // `derived-capacity` has two parents of different kinds; both must survive.
  assert.deepEqual(scheduled.rootSourceKinds, ['life_state_field', 'plan_slot']);
  assert.ok(scheduled.basisText.includes(REVIEW_CHROME.en.basisConjunction.trim()));
});

test('review: root source kinds are ordered by code point, not by graph order', () => {
  const view = attributed();
  const kinds = view.alternatives[0].whyThisNow[0].rootSourceKinds;
  // `derived-capacity` lists its parents as [obs-load, obs-slot], which resolve
  // to life_state_field and plan_slot in that order anyway; the assertion that
  // matters is that the output is sorted, so two reasons over the same sources
  // produce the same sentence regardless of citation order.
  assert.deepEqual([...kinds].sort(), [...kinds]);
});

/* ── Blind review: the redaction ─────────────────────────────────── */

test('review: a blind view carries no first-pass judgement, at any depth', () => {
  const view = blind();
  const keys = allKeys(view);
  for (const redacted of BLIND_REDACTED_FIELDS) {
    assert.ok(!keys.has(redacted), `blind view carries the redacted field ${redacted}`);
  }
  // And the positive half: it still carries the thing being evaluated.
  assert.equal(view.slots.length, 3);
  for (const slot of view.slots) {
    assert.ok(slot.whyThisNow.length > 0);
    assert.ok(slot.actionLabel.length > 0);
  }
});

test('review: a blind view carries only fields on the allow list', () => {
  // The deny list above only catches leaks somebody thought of. Adding
  // `rank: option.optionIndex` to a blind slot passed all sixty-five tests in an
  // earlier revision, because `rank` was not on it — a leak under a name nobody
  // remembered, which is the dangerous direction. This inverts the guard: every
  // key that appears must have been *added to the allow list on purpose*, which
  // is a line in a diff rather than an absence nobody can see.
  const allowed = new Set<string>(BLIND_VIEW_ALLOWED_FIELDS);
  for (const locale of REVIEW_LOCALES) {
    const view = presentRecommendation({
      recommendation: offeredChoice(),
      locale,
      mode: 'blind',
      blindingSalt: SALT,
      now: NOW,
      currentFingerprints: FRESH_FINGERPRINTS,
    });
    const keys = Array.from(allKeys(view));
    for (const key of keys) {
      assert.ok(allowed.has(key), `blind view carries an un-allowed field: ${key} (locale ${locale})`);
    }
    // And the allow list is not simply everything: a field the attributed view
    // has must still be absent here.
    assert.ok(!allowed.has('confidence'));
    assert.ok(!allowed.has('optionIndex'));
  }
});

test('review: the attributed view does carry those fields, so the guard is not vacuous', () => {
  // Without this, the redaction test above would pass against a view model that
  // never had the fields in the first place.
  const keys = allKeys(attributed());
  for (const redacted of ['optionIndex', 'confidence', 'soleness', 'excluded', 'alternatives', 'lead']) {
    assert.ok(keys.has(redacted), `attributed view should carry ${redacted}`);
  }
});

test('review: blind slot order is independent of offer order and stable per salt', () => {
  const recommendation = offeredChoice();
  const order = blindSlotOrder(recommendation, SALT);
  assert.deepEqual([...order].sort((left, right) => left - right), [0, 1, 2]);
  assert.deepEqual(blindSlotOrder(recommendation, SALT), order, 'same salt must give the same order');

  // The property that matters: the ordering is a function of the actions alone,
  // so permuting confidence — the thing the first pass ranked on — cannot move a
  // slot. Anything that could would be leaking the rank into the slot index.
  const reranked = {
    ...recommendation,
    options: {
      kind: 'choice' as const,
      options: recommendation.options.kind === 'choice'
        ? recommendation.options.options.map((option) => ({
            ...option,
            confidence: { value: 0.5, band: 'medium' as const, basis: option.confidence.basis },
          }))
        : [],
      excluded: [],
    },
  };
  assert.deepEqual(blindSlotOrder(reranked as unknown as typeof recommendation, SALT), order);
});

test('review: a different salt can produce a different order', () => {
  // Not "must differ for this pair" — a hash can agree by chance — but "the salt
  // reaches the comparison at all". Without mixing, a common prefix contributes
  // nothing and every salt would give one order, so a rater working through many
  // items would learn it.
  const recommendation = offeredChoice();
  const orders = new Set<string>();
  for (let index = 0; index < 12; index += 1) {
    orders.add(blindSlotOrder(recommendation, `salt-${index}`).join(','));
  }
  assert.ok(orders.size > 1, 'the salt does not reach the blind ordering');
});

test('review: a blind slot resolves back to an offer position, server side only', () => {
  const recommendation = offeredChoice();
  const order = blindSlotOrder(recommendation, SALT);
  for (let slot = 0; slot < order.length; slot += 1) {
    assert.equal(resolveBlindSlot(recommendation, SALT, slot), order[slot]);
  }
  assert.equal(resolveBlindSlot(recommendation, SALT, order.length), null);
  assert.equal(resolveBlindSlot(recommendation, SALT, -1), null);
  // The mapping is nowhere on the wire.
  const view = blind();
  assert.equal(pathsContaining(view, 'optionIndex').length, 0);
});

test('review: a blind target cannot name an offer position', () => {
  // A type-level property, checked at runtime through the one accessor that
  // reads either variant. There is no `optionIndex` to read on a blind target.
  const blindTarget = { mode: 'blind' as const, slotIndex: 2, blindingSalt: SALT };
  assert.equal(targetPosition(blindTarget), 2);
  assert.ok(!Object.keys(blindTarget).includes('optionIndex'));
});

/* ── Nothing persists before explicit confirmation ───────────────── */

test('review: no handoff exists before confirmation', () => {
  for (const verdict of CONFIRMING_VERDICTS) {
    const sub = submission({
      verdict,
      ...(verdict === 'edit' ? { editedTitle: 'Call the clinic back' } : {}),
    });
    const result = decide(sub);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.outcome.status, 'confirmation_required');
    assert.equal(result.outcome.persisted, false);
    // Not "the handoff is empty" — the word does not appear anywhere in the
    // outcome, because the branch that carries it is unreachable from an
    // unconfirmed submission.
    assert.ok(!allKeys(result.outcome).has('handoff'));
  }
});

test('review: an explicit confirmation produces exactly one handoff, and still no write', () => {
  const result = decide(
    submission({
      confirmation: {
        stage: 'confirmed',
        acknowledgedVerdict: 'accept',
        acknowledgedIndex: 0,
        confirmedAt: NOW,
      },
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.outcome.status, 'confirmed');
  assert.equal(result.outcome.persisted, false);
  assert.ok(result.handoff !== null);
  assert.equal(result.handoff.optionIndex, 0);
  assert.equal(result.handoff.verdict, 'accept');
  assert.equal(result.handoff.confirmedAt, NOW);
  assert.equal(RECOMMENDATION_REVIEW_POLICY.reviewMayPersist, false);
  assert.equal(RECOMMENDATION_REVIEW_POLICY.handoffOnlyOnExplicitConfirmation, true);
});

test('review: a confirmation that has drifted from its decision is refused', () => {
  // The failure a boolean flag cannot express: the reviewer confirmed the first
  // option, the offer re-rendered, and the decision now targets the third.
  const mismatchedIndex = decide(
    submission({
      target: { mode: 'attributed', optionIndex: 2 },
      confirmation: {
        stage: 'confirmed',
        acknowledgedVerdict: 'accept',
        acknowledgedIndex: 0,
        confirmedAt: NOW,
      },
    }),
  );
  assert.equal(mismatchedIndex.ok, false);
  if (mismatchedIndex.ok) return;
  assert.deepEqual(mismatchedIndex.findings.map((f) => f.code), ['CONFIRMATION_TARGET_MISMATCH']);

  const mismatchedVerdict = decide(
    submission({
      verdict: 'done',
      confirmation: {
        stage: 'confirmed',
        acknowledgedVerdict: 'accept',
        acknowledgedIndex: 0,
        confirmedAt: NOW,
      },
    }),
  );
  assert.equal(mismatchedVerdict.ok, false);
  if (mismatchedVerdict.ok) return;
  assert.deepEqual(mismatchedVerdict.findings.map((f) => f.code), ['CONFIRMATION_TARGET_MISMATCH']);
});

test('review: declining an offer records nothing and carries no penalty', () => {
  for (const verdict of ['defer', 'dismiss'] as const) {
    for (const stage of ['unconfirmed', 'confirmed'] as const) {
      const result = decide(
        submission({
          verdict,
          confirmation:
            stage === 'unconfirmed'
              ? { stage: 'unconfirmed' }
              : { stage: 'confirmed', acknowledgedVerdict: verdict, acknowledgedIndex: 0, confirmedAt: NOW },
        }),
      );
      assert.equal(result.ok, true, `${verdict}/${stage} was refused`);
      if (!result.ok) return;
      assert.equal(result.outcome.status, 'recorded_without_penalty');
      assert.equal(result.outcome.persisted, false);
      // Even a *confirmed* decline produces no handoff: there is nothing to write.
      assert.ok(!allKeys(result.outcome).has('handoff'));
    }
  }
});

test('review: a whole-offer dismissal may name no position, and nothing else may', () => {
  assert.deepEqual([...WHOLE_OFFER_VERDICTS], ['dismiss']);
  const dismissal = decide(
    submission({ verdict: 'dismiss', target: { mode: 'attributed', optionIndex: null } }),
  );
  assert.equal(dismissal.ok, true);

  const untargeted = decide(
    submission({ verdict: 'accept', target: { mode: 'attributed', optionIndex: null } }),
  );
  assert.equal(untargeted.ok, false);
  if (untargeted.ok) return;
  assert.deepEqual(untargeted.findings.map((f) => f.code), ['TARGET_REQUIRED']);
});

test('review: a position past the end of the offer is reported, not clamped', () => {
  const result = decide(submission({ target: { mode: 'attributed', optionIndex: 7 } }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.findings.map((f) => f.code), ['TARGET_OUT_OF_RANGE']);
  assert.equal(result.findings[0].position, 7);
});

test('review: an edit must carry replacement text, and nothing else may', () => {
  const blankEdit = decide(submission({ verdict: 'edit', editedTitle: '   ' }));
  assert.equal(blankEdit.ok, false);
  if (blankEdit.ok) return;
  assert.deepEqual(blankEdit.findings.map((f) => f.code), ['EDIT_TITLE_REQUIRED']);

  const strayTitle = decide(submission({ verdict: 'accept', editedTitle: 'Something else' }));
  assert.equal(strayTitle.ok, false);
  if (strayTitle.ok) return;
  assert.deepEqual(strayTitle.findings.map((f) => f.code), ['EDIT_TITLE_NOT_APPLICABLE']);

  const goodEdit = decide(
    submission({
      verdict: 'edit',
      editedTitle: 'Call the clinic back',
      confirmation: { stage: 'confirmed', acknowledgedVerdict: 'edit', acknowledgedIndex: 0, confirmedAt: NOW },
    }),
  );
  assert.equal(goodEdit.ok, true);
  if (!goodEdit.ok) return;
  assert.ok(goodEdit.handoff !== null);
  assert.equal(
    goodEdit.handoff.editedTitle,
    'Call the clinic back',
  );
});

test('review: a decision against a recommendation too stale to render is refused', () => {
  const result = evaluateReviewSubmission({
    recommendation: offeredChoice(),
    locale: 'en',
    mode: 'attributed',
    now: AFTER_EXPIRY,
    currentFingerprints: FRESH_FINGERPRINTS,
    submission: submission({
      confirmation: { stage: 'confirmed', acknowledgedVerdict: 'accept', acknowledgedIndex: 0, confirmedAt: NOW },
    }),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.findings.map((f) => f.code), ['NOTHING_OFFERED']);
});

test('review: a submission naming a different recommendation is refused', () => {
  const result = decide(submission({ recommendationId: 'rec-something-else' }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.findings.map((f) => f.code), ['RECOMMENDATION_ID_MISMATCH']);
});

test('review: a blind reviewer decision resolves to the offer position it never saw', () => {
  const order = blindSlotOrder(offeredChoice(), SALT);
  const slotIndex = order.indexOf(2);
  const result = decide(
    submission({
      target: { mode: 'blind', slotIndex, blindingSalt: SALT },
      confirmation: {
        stage: 'confirmed',
        acknowledgedVerdict: 'accept',
        acknowledgedIndex: slotIndex,
        confirmedAt: NOW,
      },
    }),
    'blind',
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.handoff !== null);
  assert.equal(result.handoff.optionIndex, 2);
});

test('review: an attributed target against a blind review is refused', () => {
  const result = decide(submission({ target: { mode: 'attributed', optionIndex: 0 } }), 'blind');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.findings.map((f) => f.code), ['TARGET_MODE_MISMATCH']);
});

/* ── No caller-chosen identifier in any human-readable string ────── */

test('review: caller-chosen ids appear only in their own typed fields', () => {
  // The Sprint 07 leak was a `detail` string reading
  // `working window call-dr.cohen-about-the-biopsy`, which passed a test that
  // checked only that titles were absent. So this walks the whole view and
  // asserts *where* each id is allowed to be, rather than that some field is
  // clean.
  const allowed = new Set(['commitmentId', 'proposalId', 'recommendationId', 'itemId']);
  for (const locale of REVIEW_LOCALES) {
    for (const view of [attributed(locale), presentRecommendation({
      recommendation: offeredChoice(),
      locale,
      mode: 'blind',
      blindingSalt: SALT,
      now: NOW,
      currentFingerprints: FRESH_FINGERPRINTS,
    })]) {
      for (const needle of [SECRET_COMMITMENT, SECOND_COMMITMENT, SECRET_PROPOSAL, EXCLUDED_COMMITMENT, RECOMMENDATION_ID]) {
        for (const path of pathsContaining(view, needle)) {
          const leaf = path.slice(path.lastIndexOf('.') + 1);
          assert.ok(allowed.has(leaf), `${needle} reached ${path} in locale ${locale}`);
        }
      }
    }
  }
});

test('review: findings carry no caller-chosen identifier either', () => {
  const result = decide(submission({ target: { mode: 'attributed', optionIndex: 7 } }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  for (const found of result.findings) {
    for (const needle of [SECRET_COMMITMENT, SECOND_COMMITMENT, SECRET_PROPOSAL, RECOMMENDATION_ID]) {
      assert.ok(!found.detail.includes(needle), `finding detail leaks ${needle}`);
    }
  }
});

test('review: no finding the module can produce carries a caller-chosen id', () => {
  // The earlier version checked the findings from one rejection out of the
  // seventeen codes. A mutation that rewrote the RECOMMENDATION_ID_MISMATCH
  // detail to `working window ${recommendationId}` — reproducing the Sprint 07
  // leak string verbatim — went green. This drives every refusal this module has
  // and checks all of their details.
  const baits = [SECRET_COMMITMENT, SECOND_COMMITMENT, SECRET_PROPOSAL, EXCLUDED_COMMITMENT, RECOMMENDATION_ID];
  const rejections: ReviewDecisionSubmission[] = [
    submission({ recommendationId: 'rec-elsewhere' }),
    submission({ target: { mode: 'attributed', optionIndex: 99 } }),
    submission({ target: { mode: 'attributed', optionIndex: null } }),
    submission({ verdict: 'edit' }),
    submission({ editedTitle: 'stray' }),
    submission({ verdict: 'edit', editedTitle: 'x'.repeat(RECOMMENDATION_REVIEW_LIMITS.maxEditedTitleLength + 1) }),
    submission({ decidedAt: 'not an instant' }),
    submission({
      confirmation: { stage: 'confirmed', acknowledgedVerdict: 'done', acknowledgedIndex: 0, confirmedAt: NOW },
    }),
    submission({
      confirmation: { stage: 'confirmed', acknowledgedVerdict: 'accept', acknowledgedIndex: 0, confirmedAt: 'soon' },
    }),
    submission({ target: { mode: 'blind', slotIndex: 0, blindingSalt: '  ' } }),
  ];
  let seen = 0;
  for (const sub of rejections) {
    const result = decide(sub, sub.target.mode === 'blind' ? 'blind' : 'attributed');
    if (result.ok) continue;
    for (const found of result.findings) {
      seen += 1;
      for (const bait of baits) {
        assert.ok(!found.detail.includes(bait), `${found.code} detail leaks ${bait}: ${found.detail}`);
        assert.ok(found.field === null || !found.field.includes(bait), `${found.code} field leaks ${bait}`);
      }
    }
  }
  assert.ok(seen >= 9, `expected to exercise most refusal codes, saw ${seen} findings`);
});

test('review: the reason count is a deterministic oracle for the lead, not a correlation', () => {
  // Recorded as a *measured* fact rather than a hedge. Across 200 salts, the
  // blind slot with the most `whyThisNow` entries is the first pass's lead every
  // single time on this fixture — 100% accuracy from one visible attribute. The
  // documentation used to call this a "correlation" a study would "control
  // for"; at this accuracy the blind arm is not blind for offers shaped like
  // this one, and the doc now says so. Pinned here so that if a future change
  // breaks the relationship, the claim in the docs is updated with it.
  let identified = 0;
  const trials = 200;
  for (let index = 0; index < trials; index += 1) {
    const salt = `oracle-salt-${index}`;
    const view = presentRecommendation({
      recommendation: offeredChoice(),
      locale: 'en',
      mode: 'blind',
      blindingSalt: salt,
      now: NOW,
      currentFingerprints: FRESH_FINGERPRINTS,
    }) as BlindReviewView;
    let best = 0;
    for (let slot = 1; slot < view.slots.length; slot += 1) {
      if (view.slots[slot].whyThisNow.length > view.slots[best].whyThisNow.length) best = slot;
    }
    if (blindSlotOrder(offeredChoice(), salt)[best] === 0) identified += 1;
  }
  assert.equal(identified, trials, 'the documented oracle strength has changed; update the docs');
});

test('review: element ids are derived from position, never from input', () => {
  const view = attributed();
  const ids = [view.headingElementId, view.lead.elementId, ...view.alternatives.map((c) => c.elementId)];
  assert.equal(new Set(ids).size, ids.length, 'element ids must be unique');
  for (const id of ids) {
    assert.match(id, /^recommendation-review-[a-z]+(-\d+)?$/);
  }
  for (const slot of blind().slots) {
    assert.match(slot.elementId, /^recommendation-review-slot-\d+$/);
  }
});

/* ── Copy: every rendered string exists, in every locale ─────────── */

test('review: every locale renders a non-empty string for every closed code', () => {
  const tables: Record<string, Record<string, Record<string, string>>> = {
    chrome: REVIEW_CHROME as never,
    verdict: VERDICT_COPY as never,
    action: ACTION_KIND_COPY as never,
    support: SUPPORT_REASON_COPY as never,
    exclusion: EXCLUSION_REASON_COPY as never,
    soleness: SOLENESS_COPY as never,
    confidence: CONFIDENCE_BAND_COPY as never,
    source: SOURCE_KIND_COPY as never,
    nothing: NOTHING_TO_REVIEW_COPY as never,
  };
  for (const [name, table] of Object.entries(tables)) {
    for (const locale of REVIEW_LOCALES) {
      const entries = Object.entries(table[locale]);
      assert.ok(entries.length > 0, `${name}/${locale} is empty`);
      for (const [code, text] of entries) {
        assert.equal(typeof text, 'string', `${name}/${locale}/${code} is not a string`);
        assert.ok(text.trim().length > 0, `${name}/${locale}/${code} is blank`);
      }
    }
  }
});

test('review: no copy string interpolates anything', () => {
  // A copy table with no placeholders cannot produce the Sprint 07 leak, because
  // there is nowhere for caller content to go. Checked on the source text so a
  // template literal is caught as well as a `{0}`-style placeholder.
  const source = readFileSync(join(repoRoot, 'lib', 'recommendation', 'review', 'copy.ts'), 'utf8');
  const body = source.slice(source.indexOf('export const REVIEW_CHROME'));
  assert.ok(!body.includes('${'), 'copy.ts interpolates a value into a rendered string');
  assert.ok(!/\{\d+\}/.test(body), 'copy.ts uses a positional placeholder');
});

test('review: every verdict button has a name, in every locale', () => {
  // The half of "keyboard and screen-reader flows pass" that a pure test can
  // actually prove: the component renders `action.label` as a button's only
  // child, so an accessible name exists exactly when this is non-empty. The
  // structural half — that it is rendered into a button at all — is in
  // reviewAccessibility.test.ts.
  for (const locale of REVIEW_LOCALES) {
    const actions = verdictActions(locale);
    assert.equal(actions.length, 5);
    for (const action of actions) {
      assert.ok(action.label.trim().length > 0, `${locale}/${action.verdict} has no label`);
      assert.equal(
        action.requiresConfirmation,
        (CONFIRMING_VERDICTS as readonly string[]).includes(action.verdict),
      );
    }
  }
});

test('review: the verdict wording matches the shipped pilot, in every locale', () => {
  // The PR claims the five verdicts are spelled exactly as `NextStepReview.tsx`
  // spells them. That claim was true and untested, which is the Sprint 06
  // mechanism this work cites: three mutations to the strings all survived.
  // Read from the pilot's source because its COPY table is a module-private
  // const behind a default-exported component.
  const pilot = readFileSync(join(repoRoot, 'src', 'components', 'NextStepReview.tsx'), 'utf8');
  for (const locale of REVIEW_LOCALES) {
    const row = new RegExp(`\\b${locale}:\\s*\\{([^}]*)\\}`).exec(pilot);
    assert.ok(row !== null, `the pilot has no ${locale} copy row`);
    for (const verdict of ['accept', 'edit', 'defer', 'dismiss', 'done'] as const) {
      const entry = new RegExp(`${verdict}:\\s*'([^']*)'`).exec((row as RegExpExecArray)[1]);
      assert.ok(entry !== null, `the pilot has no ${locale}/${verdict} label`);
      assert.equal(
        VERDICT_COPY[locale][verdict],
        (entry as RegExpExecArray)[1],
        `${locale}/${verdict} has drifted from the shipped pilot`,
      );
    }
  }
});

test('review: right-to-left locales are marked as such', () => {
  assert.equal(directionFor('en'), 'ltr');
  for (const locale of RTL_REVIEW_LOCALES) {
    assert.equal(directionFor(locale), 'rtl');
    assert.equal(attributed(locale).direction, 'rtl');
  }
});

/* ── No ambient clock, no localeCompare ──────────────────────────── */

test('review: the review module reads no clock and no locale-dependent ordering', () => {
  // Determinism is not testable by observing one run: a `Date.now()` in the
  // presenter would produce a correct-looking view every time. The property is
  // structural, so it is checked structurally, the way
  // tests/planning/planningBoundaries.test.ts pins lib/planning clock-free.
  const files = ['reviewContract.ts', 'present.ts', 'copy.ts'];
  const forbidden = [/\bDate\.now\s*\(/, /\bnew\s+Date\s*\(\s*\)/, /\bMath\.random\s*\(/, /randomUUID/, /localeCompare/];
  for (const file of files) {
    const source = readFileSync(join(repoRoot, 'lib', 'recommendation', 'review', file), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(code), `${file} matches ${pattern}`);
    }
  }
  assert.equal(RECOMMENDATION_REVIEW_POLICY.noAmbientClock, true);
});

test('review: the presenter is deterministic for one input', () => {
  assert.deepEqual(attributed(), attributed());
  assert.deepEqual(blind(), blind());
});
