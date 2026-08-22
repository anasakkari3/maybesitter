/**
 * The feedback study's model: parsing one answer out of an untyped body, and
 * summarising a set of them without losing the declines.
 *
 * ── The summary is total over the question set ───────────────────
 *
 * `questions` carries one entry per `ShadowStudyQuestionId`, in the
 * vocabulary's declaration order, whether or not anybody answered it. A summary
 * that omitted unanswered questions would make "nobody was asked about
 * intrusiveness" indistinguishable from "we did not put it in the report", and
 * `intrusiveness` is in the question set precisely because a study without a
 * cost question measures only the benefit side of a trade.
 *
 * ── `meanRating: null` is not zero ───────────────────────────────
 *
 * A question that only ever got declines has no mean. Rendering that as `0`
 * puts the worst possible score on the exact question people would not answer,
 * which is the opposite of what the data says. It is the same discipline as
 * `ShadowInconclusiveSloReading.value: null` and Sprint 10's inconclusive
 * readings: "we cannot tell" is a variant, not a number.
 *
 * ── Respondents are counted per (participant, question) pair ─────
 *
 * `ratedCount` counts answers and `respondentCount` counts people, because one
 * participant answering about six runs is six answers and one person. A report
 * that quoted the first number as the second would describe a six-person study
 * that had one participant in it.
 */
import {
  SHADOW_SAFE_CODE,
  SHADOW_STUDY_QUESTIONS,
  SHADOW_STUDY_RATING_SCALE,
  isInstant,
  type Instant,
  type ShadowStudyQuestionId,
  type ShadowStudyResponse,
} from '../../src/contracts/v1/shadowPipelineContracts';

export const SHADOW_STUDY_PARSE_REJECTIONS = Object.freeze([
  'malformed_body',
  'unsafe_participant',
  'unknown_question',
  'unknown_status',
  'unsafe_run',
  'rating_out_of_scale',
  'rating_missing',
  'declined_carries_rating',
] as const);

export type ShadowStudyParseRejection = (typeof SHADOW_STUDY_PARSE_REJECTIONS)[number];

export type ShadowStudyParseResult =
  | { readonly status: 'parsed'; readonly response: ShadowStudyResponse }
  | { readonly status: 'rejected'; readonly reason: ShadowStudyParseRejection; readonly detail: string };

function reject(reason: ShadowStudyParseRejection, detail: string): ShadowStudyParseResult {
  return { status: 'rejected', reason, detail };
}

function isSafeCode(value: unknown): value is string {
  return typeof value === 'string' && SHADOW_SAFE_CODE.test(value);
}

/**
 * Reads one response out of a caller-supplied object.
 *
 * `respondedAt` is the caller's `now`, passed in rather than read from the
 * body: a participant's client could otherwise date its own answer, and a study
 * whose timestamps the respondent chooses cannot be ordered against the runs it
 * is about. This module reads no clock either — the instant comes from the
 * handler, which got it from the request.
 */
export function parseStudyResponse(body: unknown, respondedAt: Instant): ShadowStudyParseResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return reject('malformed_body', 'the response is not an object');
  }
  if (!isInstant(respondedAt)) {
    return reject('malformed_body', `respondedAt is not an ISO instant with an explicit offset: ${String(respondedAt)}`);
  }
  const raw = body as Record<string, unknown>;

  if (!isSafeCode(raw.participantId)) {
    return reject('unsafe_participant', `participantId is outside the safe-code pattern: ${String(raw.participantId)}`);
  }
  if (!(SHADOW_STUDY_QUESTIONS as readonly unknown[]).includes(raw.question)) {
    return reject('unknown_question', `not a study question: ${String(raw.question)}`);
  }
  const question = raw.question as ShadowStudyQuestionId;

  // Required-and-nullable, as everywhere in this contract: a body that omits
  // `runId` has not said "about the study in general", it has forgotten to say.
  if (!('runId' in raw)) {
    return reject('unsafe_run', 'runId is required; use null for an answer about the study rather than about a run');
  }
  if (raw.runId !== null && !isSafeCode(raw.runId)) {
    return reject('unsafe_run', `runId must be null or a safe code: ${String(raw.runId)}`);
  }
  const runId = raw.runId === null ? null : (raw.runId as string);

  if (raw.status === 'declined') {
    if (raw.rating !== undefined && raw.rating !== null) {
      return reject('declined_carries_rating', 'a declined answer cannot carry a rating');
    }
    return { status: 'parsed', response: { status: 'declined', participantId: raw.participantId, runId, question, rating: null, respondedAt } };
  }

  if (raw.status === 'rated') {
    if (raw.rating === undefined || raw.rating === null) {
      // Not read as a decline: a client that meant "declined" says so, and
      // guessing turns a dropped field into a datum nobody produced.
      return reject('rating_missing', 'a rated answer must carry a rating; say status "declined" to decline');
    }
    if (
      typeof raw.rating !== 'number'
      || !Number.isInteger(raw.rating)
      || raw.rating < SHADOW_STUDY_RATING_SCALE.minimum
      || raw.rating > SHADOW_STUDY_RATING_SCALE.maximum
    ) {
      return reject(
        'rating_out_of_scale',
        `a rating must be a whole number in ${SHADOW_STUDY_RATING_SCALE.minimum}–${SHADOW_STUDY_RATING_SCALE.maximum}: ${String(raw.rating)}`,
      );
    }
    return { status: 'parsed', response: { status: 'rated', participantId: raw.participantId, runId, question, rating: raw.rating, respondedAt } };
  }

  return reject('unknown_status', `not a study response status: ${String(raw.status)}`);
}

/* ── The summary ─────────────────────────────────────────────────── */

export interface ShadowStudyQuestionSummary {
  readonly question: ShadowStudyQuestionId;
  readonly ratedCount: number;
  readonly declinedCount: number;
  readonly ratingTotal: number;
  /** Null when nobody rated it. Never zero-for-absent. See the header. */
  readonly meanRating: number | null;
  /** Distinct participants who answered this question either way. */
  readonly respondentCount: number;
}

export interface ShadowStudySummary {
  readonly responseCount: number;
  readonly ratedCount: number;
  readonly declinedCount: number;
  /** Distinct participants who answered anything at all. */
  readonly respondentCount: number;
  readonly questions: readonly ShadowStudyQuestionSummary[];
}

/**
 * Summarises a set of responses.
 *
 * Pure and order-independent in its numbers; the entry order is the question
 * vocabulary's declaration order, which is deterministic without a comparator
 * (this repo forbids `localeCompare`, and nothing here needs a sort).
 */
export function summarizeStudyResponses(
  responses: readonly ShadowStudyResponse[],
): ShadowStudySummary {
  const perQuestion = new Map<ShadowStudyQuestionId, { rated: number; declined: number; total: number; people: Set<string> }>();
  for (const question of SHADOW_STUDY_QUESTIONS) {
    perQuestion.set(question, { rated: 0, declined: 0, total: 0, people: new Set<string>() });
  }

  const respondents = new Set<string>();
  let ratedCount = 0;
  let declinedCount = 0;

  for (const response of responses) {
    const bucket = perQuestion.get(response.question);
    if (bucket === undefined) continue;
    respondents.add(response.participantId);
    bucket.people.add(response.participantId);
    if (response.status === 'rated') {
      bucket.rated += 1;
      bucket.total += response.rating;
      ratedCount += 1;
    } else {
      bucket.declined += 1;
      declinedCount += 1;
    }
  }

  return {
    responseCount: ratedCount + declinedCount,
    ratedCount,
    declinedCount,
    respondentCount: respondents.size,
    questions: SHADOW_STUDY_QUESTIONS.map((question) => {
      const bucket = perQuestion.get(question) ?? { rated: 0, declined: 0, total: 0, people: new Set<string>() };
      return {
        question,
        ratedCount: bucket.rated,
        declinedCount: bucket.declined,
        ratingTotal: bucket.total,
        meanRating: bucket.rated === 0 ? null : bucket.total / bucket.rated,
        respondentCount: bucket.people.size,
      };
    }),
  };
}
