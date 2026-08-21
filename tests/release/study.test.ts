/**
 * The feedback-study data model: both variants first-class, both bounds of the
 * scale probed from the constant, and a declined answer that stays visible all
 * the way into the summary.
 *
 * The bound fixtures derive from `SHADOW_STUDY_RATING_SCALE` so that moving the
 * scale moves them, and the constant's value is pinned against a literal so
 * that moving the scale is a deliberate diff rather than a silent one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  SHADOW_STUDY_QUESTIONS,
  SHADOW_STUDY_RATING_SCALE,
  type ShadowStudyResponse,
} from '../../src/contracts/v1/shadowPipelineContracts.ts';
import {
  SHADOW_STUDY_RECORD_REJECTIONS,
  createFileShadowStudyResponseStore,
  createInMemoryShadowStudyResponseStore,
  type ShadowStudyResponseStore,
} from '../../lib/release/studyStore.ts';
import { parseStudyResponse, summarizeStudyResponses } from '../../lib/release/study.ts';

const P = 'participant-a';
const Q = 'participant-b';
const RUN = 'run-0001';
const NOW = '2027-01-10T09:00:00.000Z';

function rated(participantId: string, question: (typeof SHADOW_STUDY_QUESTIONS)[number], rating: number, runId: string | null = RUN): ShadowStudyResponse {
  return { status: 'rated', participantId, runId, question, rating, respondedAt: NOW };
}

function declined(participantId: string, question: (typeof SHADOW_STUDY_QUESTIONS)[number], runId: string | null = RUN): ShadowStudyResponse {
  return { status: 'declined', participantId, runId, question, rating: null, respondedAt: NOW };
}

/* ── The scale's constants are pinned, then derived from ─────────── */

test('the rating scale is the one this study was designed around', () => {
  assert.equal(SHADOW_STUDY_RATING_SCALE.minimum, 1);
  assert.equal(SHADOW_STUDY_RATING_SCALE.maximum, 5);
});

test('each bound of the scale is probed one site at a time, from the constant', () => {
  const store = createInMemoryShadowStudyResponseStore();
  const cases: [number, 'recorded' | 'rejected'][] = [
    [SHADOW_STUDY_RATING_SCALE.minimum - 1, 'rejected'],
    [SHADOW_STUDY_RATING_SCALE.minimum, 'recorded'],
    [SHADOW_STUDY_RATING_SCALE.maximum, 'recorded'],
    [SHADOW_STUDY_RATING_SCALE.maximum + 1, 'rejected'],
  ];
  for (const [rating, expected] of cases) {
    const result = store.record(rated(P, 'helpfulness', rating, `run-${rating + 10}`));
    assert.equal(result.status, expected, `a rating of ${rating} was ${result.status}`);
  }
});

test('a fractional rating is not a rating', () => {
  const store = createInMemoryShadowStudyResponseStore();
  const midpoint = (SHADOW_STUDY_RATING_SCALE.minimum + SHADOW_STUDY_RATING_SCALE.maximum) / 2;
  const result = store.record(rated(P, 'helpfulness', midpoint + 0.5));
  assert.equal(result.status, 'rejected');
});

/* ── Both variants are first-class ───────────────────────────────── */

for (const flavour of ['memory', 'file'] as const) {
  test(`[${flavour}] a declined answer is stored, listed and counted like a rated one`, () => {
    const dir = flavour === 'file' ? mkdtempSync(path.join(tmpdir(), 'ms-study-responses-')) : null;
    const store: ShadowStudyResponseStore =
      dir === null
        ? createInMemoryShadowStudyResponseStore()
        : createFileShadowStudyResponseStore({ dataDir: dir });
    try {
      assert.equal(store.record(rated(P, 'helpfulness', SHADOW_STUDY_RATING_SCALE.maximum)).status, 'recorded');
      assert.equal(store.record(declined(P, 'intrusiveness')).status, 'recorded');

      const listed = store.list(P);
      assert.equal(listed.length, 2, 'a declined answer was folded into a gap');
      // (question, status) pairs, not a set of statuses.
      assert.equal(listed.filter((r) => r.question === 'helpfulness' && r.status === 'rated').length, 1);
      assert.equal(listed.filter((r) => r.question === 'intrusiveness' && r.status === 'declined').length, 1);
      const [, declinedBack] = listed;
      assert.equal(declinedBack.rating, null, 'a declined answer leaked a number');
      assert.equal(store.countFor(P), 2);
    } finally {
      if (dir !== null) rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('answering the same question about the same run again supersedes rather than double-counts', () => {
  const store = createInMemoryShadowStudyResponseStore();
  store.record(rated(P, 'trust', SHADOW_STUDY_RATING_SCALE.minimum));
  store.record(rated(P, 'trust', SHADOW_STUDY_RATING_SCALE.maximum));
  assert.equal(store.countFor(P), 1, 'one person answered one question twice and was counted twice');
  assert.equal(store.list(P)[0].rating, SHADOW_STUDY_RATING_SCALE.maximum);
});

test('the same question about a different run is a different answer', () => {
  const store = createInMemoryShadowStudyResponseStore();
  store.record(rated(P, 'trust', SHADOW_STUDY_RATING_SCALE.minimum, 'run-0001'));
  store.record(rated(P, 'trust', SHADOW_STUDY_RATING_SCALE.maximum, 'run-0002'));
  store.record(rated(P, 'trust', SHADOW_STUDY_RATING_SCALE.minimum, null));
  assert.equal(store.countFor(P), 3);
});

test('one participant deleting their responses leaves the others intact, proven by re-listing', () => {
  const store = createInMemoryShadowStudyResponseStore();
  store.record(rated(P, 'trust', SHADOW_STUDY_RATING_SCALE.maximum));
  store.record(declined(P, 'accuracy'));
  store.record(rated(Q, 'trust', SHADOW_STUDY_RATING_SCALE.maximum));

  assert.equal(store.deleteParticipant(P), 2);
  assert.equal(store.countFor(P), 0, 'a response survived its own deletion');
  assert.deepEqual(store.list(P), []);
  assert.equal(store.countFor(Q), 1, 'one participant deleted another');
  assert.equal(store.listAll().length, 1);
});

test('every rejection reason is reachable, and recording never throws', () => {
  const store = createInMemoryShadowStudyResponseStore();
  const seen = new Set<string>();
  const refuse = (response: unknown): void => {
    const result = store.record(response as ShadowStudyResponse);
    assert.equal(result.status, 'rejected', `a malformed response was recorded: ${JSON.stringify(response)}`);
    if (result.status === 'rejected') seen.add(result.reason);
  };

  refuse({ ...rated(P, 'helpfulness', 3), participantId: 'Participant A' });
  refuse({ ...rated(P, 'helpfulness', 3), question: 'vibes' });
  refuse({ ...rated(P, 'helpfulness', 3), rating: SHADOW_STUDY_RATING_SCALE.maximum + 1 });
  refuse({ ...rated(P, 'helpfulness', 3), respondedAt: 'yesterday' });
  refuse({ ...rated(P, 'helpfulness', 3), runId: 'RUN ONE' });
  refuse({ ...rated(P, 'helpfulness', 3), status: 'shrugged' });
  refuse({ ...declined(P, 'helpfulness'), rating: 4 });

  assert.deepEqual(
    SHADOW_STUDY_RECORD_REJECTIONS.filter((reason) => !seen.has(reason)),
    [],
    'a declared rejection reason has no test reaching it',
  );
});

/* ── Parsing at the untyped boundary ─────────────────────────────── */

test('a well-formed body parses into the variant it names', () => {
  const parsedRated = parseStudyResponse({
    participantId: P,
    runId: RUN,
    question: 'helpfulness',
    status: 'rated',
    rating: SHADOW_STUDY_RATING_SCALE.maximum,
  }, NOW);
  assert.equal(parsedRated.status, 'parsed');
  if (parsedRated.status === 'parsed') {
    assert.equal(parsedRated.response.status, 'rated');
    assert.equal(parsedRated.response.rating, SHADOW_STUDY_RATING_SCALE.maximum);
    assert.equal(parsedRated.response.respondedAt, NOW);
  }

  const parsedDeclined = parseStudyResponse({
    participantId: P,
    runId: null,
    question: 'intrusiveness',
    status: 'declined',
  }, NOW);
  assert.equal(parsedDeclined.status, 'parsed');
  if (parsedDeclined.status === 'parsed') {
    assert.equal(parsedDeclined.response.status, 'declined');
    assert.equal(parsedDeclined.response.rating, null);
    assert.equal(parsedDeclined.response.runId, null);
  }
});

test('a declined body that carries a rating is refused rather than quietly stripped', () => {
  const result = parseStudyResponse(
    { participantId: P, runId: RUN, question: 'trust', status: 'declined', rating: 5 },
    NOW,
  );
  assert.equal(result.status, 'rejected');
});

test('a rated body with no rating is refused rather than read as declined', () => {
  const result = parseStudyResponse({ participantId: P, runId: RUN, question: 'trust', status: 'rated' }, NOW);
  assert.equal(result.status, 'rejected');
});

/* ── Summary: a decline is a datum ───────────────────────────────── */

test('the summary is total over the question set, in declaration order', () => {
  const summary = summarizeStudyResponses([rated(P, 'helpfulness', 4)]);
  assert.deepEqual(
    summary.questions.map((entry) => entry.question),
    [...SHADOW_STUDY_QUESTIONS],
  );
});

test('a question only ever declined has no mean, and says so as null rather than as zero', () => {
  const summary = summarizeStudyResponses([
    declined(P, 'intrusiveness'),
    declined(Q, 'intrusiveness'),
    rated(P, 'helpfulness', SHADOW_STUDY_RATING_SCALE.maximum),
  ]);
  const intrusiveness = summary.questions.find((entry) => entry.question === 'intrusiveness');
  assert.ok(intrusiveness);
  assert.equal(intrusiveness.declinedCount, 2);
  assert.equal(intrusiveness.ratedCount, 0);
  assert.equal(intrusiveness.meanRating, null, 'a mean was invented for a question nobody rated');
  assert.equal(intrusiveness.respondentCount, 2, 'two people answered and the summary counted nobody');

  const helpfulness = summary.questions.find((entry) => entry.question === 'helpfulness');
  assert.ok(helpfulness);
  assert.equal(helpfulness.meanRating, SHADOW_STUDY_RATING_SCALE.maximum);
});

test('the mean is over rated answers only; a decline never enters the arithmetic', () => {
  const withDecline = summarizeStudyResponses([
    rated(P, 'trust', SHADOW_STUDY_RATING_SCALE.maximum),
    declined(Q, 'trust'),
  ]);
  const withoutDecline = summarizeStudyResponses([rated(P, 'trust', SHADOW_STUDY_RATING_SCALE.maximum)]);
  const readMean = (summary: typeof withDecline): number | null =>
    summary.questions.find((entry) => entry.question === 'trust')?.meanRating ?? null;
  assert.equal(readMean(withDecline), readMean(withoutDecline));
  assert.equal(readMean(withDecline), SHADOW_STUDY_RATING_SCALE.maximum);
});

test('respondents are counted per person per question, not per response', () => {
  const summary = summarizeStudyResponses([
    rated(P, 'trust', 4, 'run-0001'),
    rated(P, 'trust', 5, 'run-0002'),
    rated(Q, 'trust', 3, 'run-0001'),
  ]);
  const trust = summary.questions.find((entry) => entry.question === 'trust');
  assert.ok(trust);
  assert.equal(trust.ratedCount, 3, 'a per-run answer was dropped');
  assert.equal(trust.respondentCount, 2, 'one person answering twice was counted as two people');
  assert.equal(summary.respondentCount, 2);
  assert.equal(summary.responseCount, 3);
});

test('an empty study summarises to nothing rather than to zeroes that look like findings', () => {
  const summary = summarizeStudyResponses([]);
  assert.equal(summary.responseCount, 0);
  assert.equal(summary.respondentCount, 0);
  for (const entry of summary.questions) {
    assert.equal(entry.meanRating, null, `${entry.question} invented a mean from no data`);
    assert.equal(entry.ratedCount, 0);
    assert.equal(entry.declinedCount, 0);
  }
});

test('the parser probes each bound of the scale on its own, from the constant', () => {
  const cases: [number, 'parsed' | 'rejected'][] = [
    [SHADOW_STUDY_RATING_SCALE.minimum - 1, 'rejected'],
    [SHADOW_STUDY_RATING_SCALE.minimum, 'parsed'],
    [SHADOW_STUDY_RATING_SCALE.maximum, 'parsed'],
    [SHADOW_STUDY_RATING_SCALE.maximum + 1, 'rejected'],
  ];
  for (const [rating, expected] of cases) {
    const result = parseStudyResponse(
      { participantId: P, runId: RUN, question: 'trust', status: 'rated', rating },
      NOW,
    );
    assert.equal(result.status, expected, `the parser ${result.status} a rating of ${rating}`);
  }
});

test('the parser refuses a fractional rating and a rating that is not a number', () => {
  for (const rating of [3.5, '4', true, {}]) {
    const result = parseStudyResponse(
      { participantId: P, runId: RUN, question: 'trust', status: 'rated', rating },
      NOW,
    );
    assert.equal(result.status, 'rejected', `the parser accepted ${JSON.stringify(rating)}`);
  }
});
