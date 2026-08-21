/**
 * The release endpoint's handler: every action, and every way to get them
 * wrong.
 *
 * Run against the library rather than the route, because the route parses JSON
 * and nothing else. `tests/personalizationControls/handler.test.ts` is the same
 * shape and the reason it is the shape.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SHADOW_CONSENT_SCOPES,
  SHADOW_STUDY_QUESTIONS,
  SHADOW_STUDY_RATING_SCALE,
  checkShadowStudyConsent,
} from '../../src/contracts/v1/shadowPipelineContracts.ts';
import { createInMemoryFeedbackEventStore } from '../../lib/feedback/feedbackEventStore.ts';
import { createInMemoryRuntimeMemoryStore } from '../../lib/runtimeMemory/runtimeMemoryStore.ts';
import { deletePersonalizationScope } from '../../lib/personalization/deletion.ts';
import { createInMemoryShadowStudyConsentStore } from '../../lib/release/consentStore.ts';
import { createInMemoryShadowStudyResponseStore } from '../../lib/release/studyStore.ts';
import { createInMemoryShadowArchive, notWiredArchive, wiredArchive } from '../../lib/release/deletion.ts';
import { unavailablePillarSource } from '../../lib/release/evidence.ts';
import {
  RELEASE_ACTIONS,
  RELEASE_REJECTION_CODES,
  handleReleaseRequest,
  type ReleaseHandlerDeps,
} from '../../lib/release/handler.ts';

const P = 'participant-a';
const NOW = '2027-01-10T09:00:00.000Z';
const LATER = '2027-01-11T09:00:00.000Z';

function deps(overrides: Partial<ReleaseHandlerDeps> = {}): ReleaseHandlerDeps {
  const feedbackEvents = createInMemoryFeedbackEventStore();
  const runtimeMemory = createInMemoryRuntimeMemoryStore();
  return {
    consent: createInMemoryShadowStudyConsentStore(),
    responses: createInMemoryShadowStudyResponseStore(),
    configuration: { stage: 'internal_dogfood', cohort: [P] },
    resolvePilot: () => ({ allowed: true, reason: 'authorized' }),
    traces: wiredArchive(createInMemoryShadowArchive([])),
    replayBundles: wiredArchive(createInMemoryShadowArchive([])),
    deletePersonalization: (scopeId, now) =>
      deletePersonalizationScope({ scopeId, now, feedbackEvents, runtimeMemory }),
    evidenceSources: () => ({
      quality: unavailablePillarSource('issue_43_evaluation_report'),
      safety: unavailablePillarSource('issue_45_shadow_traces'),
      reliability: unavailablePillarSource('issue_46_slo_readings'),
    }),
    ...overrides,
  };
}

function call(wired: ReleaseHandlerDeps, body: unknown) {
  return handleReleaseRequest(wired, body);
}

function kindOf(outcome: ReturnType<typeof call>): string {
  return (outcome.response as { kind?: string }).kind ?? '';
}

function rejectionOf(outcome: ReturnType<typeof call>): string {
  const response = outcome.response as { kind?: string; code?: string };
  assert.equal(response.kind, 'rejected', `expected a rejection, got ${JSON.stringify(outcome.response).slice(0, 160)}`);
  return response.code ?? '';
}

/* ── Hostile input is reported, never thrown ─────────────────────── */

test('every malformed request is reported with a named code and no throw', () => {
  const wired = deps();
  const cases: [unknown, string][] = [
    [null, 'MALFORMED_REQUEST_BODY'],
    ['a string', 'MALFORMED_REQUEST_BODY'],
    [[], 'MALFORMED_REQUEST_BODY'],
    [{}, 'MISSING_INSTANT'],
    [{ now: 42 }, 'MISSING_INSTANT'],
    // `2026-02-30` parses, to the 2nd of March. A regex would miss it.
    [{ now: '2026-02-30' }, 'MALFORMED_INSTANT'],
    [{ now: 'yesterday' }, 'MALFORMED_INSTANT'],
    [{ now: NOW }, 'UNKNOWN_ACTION'],
    [{ now: NOW, action: 'sudo' }, 'UNKNOWN_ACTION'],
    [{ now: NOW, action: 'consent_status' }, 'MISSING_PARTICIPANT'],
    [{ now: NOW, action: 'consent_status', participantId: '' }, 'MISSING_PARTICIPANT'],
    [{ now: NOW, action: 'grant_consent', participantId: P }, 'UNKNOWN_SCOPE'],
    [{ now: NOW, action: 'grant_consent', participantId: P, scopes: 'shadow_execution' }, 'UNKNOWN_SCOPE'],
    [{ now: NOW, action: 'grant_consent', participantId: P, scopes: ['telepathy'] }, 'UNKNOWN_SCOPE'],
    [{ now: NOW, action: 'revoke_consent', participantId: P }, 'CONSENT_REJECTED'],
    [{ now: NOW, action: 'submit_response', participantId: P }, 'RESPONSE_REJECTED'],
  ];
  for (const [body, code] of cases) {
    assert.equal(rejectionOf(call(wired, body)), code, `for ${JSON.stringify(body)}`);
  }
});

test('every declared rejection code is reachable', () => {
  const seen = new Set<string>();
  const wired = deps({ deletePersonalization: undefined, evidenceSources: undefined });
  const record = (body: unknown): void => {
    const outcome = call(wired, body);
    const response = outcome.response as { kind?: string; code?: string };
    if (response.kind === 'rejected' && response.code !== undefined) seen.add(response.code);
  };
  record(null);
  record({});
  record({ now: 'yesterday' });
  record({ now: NOW });
  record({ now: NOW, action: 'sudo' });
  record({ now: NOW, action: 'consent_status' });
  record({ now: NOW, action: 'grant_consent', participantId: P, scopes: [] });
  record({ now: NOW, action: 'revoke_consent', participantId: P });
  record({ now: NOW, action: 'submit_response', participantId: P, question: 'vibes', status: 'rated', runId: null });
  record({ now: NOW, action: 'delete', participantId: '../../etc' });
  record({ now: NOW, action: 'evidence_package', packageId: 'shadow-release-2027-01-10' });

  // A build that *does* have sources, so the package refusal is reachable
  // rather than shadowed by the not-wired one.
  const sourced = deps();
  const refused = call(sourced, { now: NOW, action: 'evidence_package', packageId: 'Not A Code' });
  const refusedBody = refused.response as { kind?: string; code?: string };
  if (refusedBody.kind === 'rejected' && refusedBody.code !== undefined) seen.add(refusedBody.code);

  assert.deepEqual(
    RELEASE_REJECTION_CODES.filter((code) => !seen.has(code)),
    [],
    'a declared rejection code has no test reaching it',
  );
});

/* ── Consent, opt-out and delete ─────────────────────────────────── */

test('granting consent writes it, and the next status read shows it', () => {
  const wired = deps();
  const granted = call(wired, { now: NOW, action: 'grant_consent', participantId: P, scopes: [...SHADOW_CONSENT_SCOPES] });
  assert.equal(granted.status, 200);
  assert.equal(kindOf(granted), 'consent_written');

  const status = call(wired, { now: NOW, action: 'consent_status', participantId: P });
  const body = status.response as { consent: { state: string; scopes: string[] } };
  assert.equal(body.consent.state, 'granted');
  for (const scope of SHADOW_CONSENT_SCOPES) {
    assert.equal(body.consent.scopes.includes(scope), true, `${scope} was not granted`);
  }
  assert.deepEqual(checkShadowStudyConsent(body.consent as never), []);
});

test('the consent response carries the exposure it implies, rebuilt in the same call', () => {
  const wired = deps();
  const granted = call(wired, { now: NOW, action: 'grant_consent', participantId: P, scopes: ['shadow_execution'] });
  const body = granted.response as { exposure: { allowed: boolean; reason: string } };
  assert.equal(body.exposure.allowed, true);

  const revoked = call(wired, { now: LATER, action: 'revoke_consent', participantId: P });
  const revokedBody = revoked.response as { exposure: { allowed: boolean; reason: string } };
  assert.equal(revokedBody.exposure.allowed, false, 'a client could show a live exposure beside a withdrawn consent');
  assert.equal(revokedBody.exposure.reason, 'study_consent_revoked');
});

test('opting out lands on the next exposure read', () => {
  const wired = deps();
  call(wired, { now: NOW, action: 'grant_consent', participantId: P, scopes: ['shadow_execution'] });
  const before = call(wired, { now: NOW, action: 'exposure', participantId: P }).response as { decision: { allowed: boolean } };
  assert.equal(before.decision.allowed, true);

  call(wired, { now: LATER, action: 'revoke_consent', participantId: P });
  const after = call(wired, { now: LATER, action: 'exposure', participantId: P }).response as { decision: { allowed: boolean; reason: string } };
  assert.equal(after.decision.allowed, false);
  assert.equal(after.decision.reason, 'study_consent_revoked');
});

test('a complete delete returns a receipt, and the stores agree when asked again', () => {
  const wired = deps();
  call(wired, { now: NOW, action: 'grant_consent', participantId: P, scopes: ['feedback_study'] });
  call(wired, {
    now: NOW,
    action: 'submit_response',
    participantId: P,
    runId: null,
    question: 'trust',
    status: 'rated',
    rating: SHADOW_STUDY_RATING_SCALE.maximum,
  });
  assert.equal(wired.consent.countFor(P), 1);
  assert.equal(wired.responses.countFor(P), 1);

  const deleted = call(wired, { now: LATER, action: 'delete', participantId: P });
  assert.equal(deleted.status, 200);
  assert.equal(kindOf(deleted), 'deleted');
  assert.equal(wired.consent.countFor(P), 0, 'a consent record survived a delete request');
  assert.equal(wired.responses.countFor(P), 0, 'a study response survived a delete request');
  assert.equal(wired.consent.read(P).state, 'withheld');
});

test('a delete this build cannot fully prove says so, and still deletes', () => {
  const wired = deps({ traces: notWiredArchive('issue_45_shadow_trace_store') });
  call(wired, { now: NOW, action: 'grant_consent', participantId: P, scopes: ['feedback_study'] });
  const deleted = call(wired, { now: LATER, action: 'delete', participantId: P });
  assert.equal(deleted.status, 200);
  assert.equal(kindOf(deleted), 'deleted_unproven');
  const body = deleted.response as { unprovable: string[] };
  assert.deepEqual(body.unprovable, ['traces']);
  assert.equal(wired.consent.countFor(P), 0, 'an unprovable store blocked a deletion that could have happened');
});

/* ── The collection API ──────────────────────────────────────────── */

test('both response variants are accepted and both come back in the summary', () => {
  const wired = deps();
  const rated = call(wired, {
    now: NOW,
    action: 'submit_response',
    participantId: P,
    runId: 'run-0001',
    question: 'helpfulness',
    status: 'rated',
    rating: SHADOW_STUDY_RATING_SCALE.maximum,
  });
  assert.equal(rated.status, 200);
  assert.equal(kindOf(rated), 'response_recorded');

  const declined = call(wired, {
    now: NOW,
    action: 'submit_response',
    participantId: P,
    runId: 'run-0001',
    question: 'intrusiveness',
    status: 'declined',
  });
  assert.equal(declined.status, 200);

  const summary = call(wired, { now: NOW, action: 'study_summary' }).response as {
    summary: { responseCount: number; declinedCount: number; questions: { question: string; declinedCount: number }[] };
  };
  assert.equal(summary.summary.responseCount, 2);
  assert.equal(summary.summary.declinedCount, 1, 'a decline was folded into a gap');
  const intrusiveness = summary.summary.questions.find((entry) => entry.question === 'intrusiveness');
  assert.equal(intrusiveness?.declinedCount, 1);
});

test('the response timestamp is the request\'s now, not anything the client sent', () => {
  const wired = deps();
  call(wired, {
    now: NOW,
    action: 'submit_response',
    participantId: P,
    runId: null,
    question: 'trust',
    status: 'rated',
    rating: SHADOW_STUDY_RATING_SCALE.minimum,
    respondedAt: '1999-01-01T00:00:00.000Z',
  });
  assert.equal(wired.responses.list(P)[0].respondedAt, NOW);
});

test('every study question is submittable', () => {
  const wired = deps();
  for (const question of SHADOW_STUDY_QUESTIONS) {
    const outcome = call(wired, {
      now: NOW,
      action: 'submit_response',
      participantId: P,
      runId: null,
      question,
      status: 'rated',
      rating: SHADOW_STUDY_RATING_SCALE.minimum,
    });
    assert.equal(outcome.status, 200, `${question} was refused`);
  }
  assert.equal(wired.responses.countFor(P), SHADOW_STUDY_QUESTIONS.length);
});

/* ── Exposure and the evidence package ───────────────────────────── */

test('the cohort view reports every decision and a tally computed from them', () => {
  const wired = deps({ configuration: { stage: 'internal_dogfood', cohort: [P, 'participant-b'] } });
  call(wired, { now: NOW, action: 'grant_consent', participantId: P, scopes: ['shadow_execution'] });
  const body = call(wired, { now: NOW, action: 'cohort_exposure' }).response as {
    decisions: { participantId: string; allowed: boolean }[];
    tally: { exposedCount: number; refusedCount: number; configuredCount: number };
    configurationDefects: unknown[];
  };
  assert.deepEqual(
    body.decisions.map((decision) => [decision.participantId, decision.allowed]),
    [[P, true], ['participant-b', false]],
  );
  assert.equal(body.tally.exposedCount, 1);
  assert.equal(body.tally.refusedCount, 1);
  assert.equal(body.tally.configuredCount, 2);
  assert.deepEqual(body.configurationDefects, []);
});

test('a misconfigured stage is reported rather than silently resolved against', () => {
  const wired = deps({ configuration: { stage: 'closed_pilot', cohort: [P] } });
  const body = call(wired, { now: NOW, action: 'cohort_exposure' }).response as {
    configurationDefects: { code: string }[];
  };
  assert.ok(body.configurationDefects.some((defect) => defect.code === 'EXPOSURE_COHORT_BELOW_STAGE_FLOOR'));
});

test('the evidence package is assembled with all three pillars saying what they can', () => {
  const wired = deps();
  const outcome = call(wired, { now: NOW, action: 'evidence_package', packageId: 'shadow-release-2027-01-10' });
  assert.equal(outcome.status, 200);
  const body = outcome.response as {
    package: { decision: string; evidence: Record<string, unknown[]> };
    unavailablePillars: string[];
    defects: unknown[];
  };
  assert.equal(body.package.decision, 'hold');
  assert.deepEqual(body.unavailablePillars, ['quality', 'safety', 'reliability']);
  assert.deepEqual(body.defects, []);
  for (const pillar of ['quality', 'safety', 'reliability']) {
    assert.ok(body.package.evidence[pillar].length >= 1, `${pillar} is missing from the package`);
  }
});

test('a build with no evidence sources refuses the package rather than inventing one', () => {
  const wired = deps({ evidenceSources: undefined });
  const outcome = call(wired, { now: NOW, action: 'evidence_package', packageId: 'shadow-release-2027-01-10' });
  assert.equal(outcome.status, 501);
  assert.equal(rejectionOf(outcome), 'NOT_WIRED');
});

test('every declared action is answered; none of them falls through to UNKNOWN_ACTION', () => {
  for (const action of RELEASE_ACTIONS) {
    // A fresh wiring per action, so an action that deletes cannot change what
    // the next one sees.
    const wired = deps();
    wired.consent.grant(P, ['shadow_execution'], NOW);
    const outcome = call(wired, {
      now: NOW,
      action,
      participantId: P,
      packageId: 'shadow-release-2027-01-10',
      scopes: ['shadow_execution'],
      runId: null,
      question: 'trust',
      status: 'declined',
    });
    assert.notEqual(
      (outcome.response as { code?: string }).code,
      'UNKNOWN_ACTION',
      `${action} is declared but not answered`,
    );
  }
});
