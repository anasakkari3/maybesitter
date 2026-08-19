/**
 * `POST /api/recommendation/review` — the review boundary for the
 * `recommendation` module (Sprint 08, issue #35).
 *
 * Shaped after `src/app/api/next-step/route.ts` and deliberately smaller than
 * it. Everything this route decides is decided by `handleReviewRequest` in
 * `lib/recommendation/review/present.ts`; the route parses a body, calls it, and
 * serialises the result. That split is what lets
 * `tests/recommendation/reviewApi.test.ts` assert the boundary's behaviour by
 * calling `POST` directly with a `Request`, the way
 * `tests/mobile/mobileApiRoutes.test.ts` does, and it leaves the route with no
 * behaviour of its own to drift from the tested one.
 *
 * ── This route writes nothing ────────────────────────────────────────────
 *
 * `RECOMMENDATION_PERSISTENCE_POLICY.recommendationCanPersist` is false and
 * `RECOMMENDATION_REVIEW_POLICY.reviewMayPersist` is false. This file imports no
 * store, no command service, no state gateway and no analytics sink, so the
 * property is enforced by the import graph rather than by review attention —
 * `tests/recommendation/reviewApi.test.ts` reads this file's imports and asserts
 * it. A confirmed decision produces a `ReviewPersistenceHandoff`, which is
 * *authority for an adapter*, not a record of a write; every response carries
 * `persisted: false` as a literal type.
 *
 * ── Why POST for a read ──────────────────────────────────────────────────
 *
 * `kind: 'present'` is a read, and it is a POST because its input is a whole
 * recommendation document — an evidence graph with an arbitrary number of nodes
 * — which does not fit a query string. The recommendation travels in the request
 * because #34's selector is not merged; a route that fetched one would have had
 * to ship a second selector, which is exactly the duplication Sprint 06's four
 * review rounds were spent on. When #34 lands, `present` gains a variant naming
 * a scope and this route resolves it; `decide` does not change, because it
 * re-validates whatever it is handed regardless of where it came from.
 *
 * ── No ambient clock ─────────────────────────────────────────────────────
 *
 * `now` is a required field of the request body and this file never calls
 * `new Date()`. The shipped pilot route does read the clock; that is a property
 * of a surface that recomputes on every request and never holds a proposal.
 * This module's output is meant to be held, which is why it has an expiry at
 * all, and an expiry check that reads the clock is unreplayable in an audit.
 * A missing `now` is reported as `MISSING_EVALUATION_INSTANT`, never defaulted.
 */

import { handleReviewRequest } from '../../../../../lib/recommendation/review/present';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    // The one malformed input `handleReviewRequest` cannot see, because it fails
    // in the parser before there is a value to inspect. Reported in the same
    // vocabulary as every other malformed input rather than as a 500: a client
    // that sent bad JSON can act on `MALFORMED_REQUEST_BODY` and can act on
    // nothing at all from a stack trace.
    return Response.json(
      {
        kind: 'rejected',
        persisted: false,
        findings: [
          {
            code: 'MALFORMED_REQUEST_BODY',
            field: null,
            position: null,
            detail: 'the request body could not be parsed as JSON',
          },
        ],
      },
      { status: 400 },
    );
  }

  const outcome = handleReviewRequest(body);
  return Response.json(outcome.response, { status: outcome.status });
}
