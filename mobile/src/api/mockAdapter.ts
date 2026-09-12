/**
 * Serving the committed contract fixtures instead of the server
 * (UC-1.R4 #157 step 10).
 *
 * For working on a screen before a backend is reachable. The fixtures are the
 * ones `tests/mobile/exportMobileApiFixtures.test.ts` generated **from the
 * real route handlers**, so what a screen renders here is what the server
 * actually sends — not a hand-written approximation that drifts.
 *
 * ── It cannot ship ───────────────────────────────────────────────
 *
 * Three independent stops, because a tester confirming commitments into
 * fixtures would believe they were saved:
 *
 *  1. `releaseConfigProblems` refuses to *configure* a staging or production
 *     build that sets `EXPO_PUBLIC_API_MODE=mock` — the binary cannot be made;
 *  2. `apiMode()` ignores the variable outside a development bundle;
 *  3. this module answers nothing unless `apiMode() === 'mock'`.
 *
 * ── Mutations are refused, not faked ─────────────────────────────
 *
 * A read is served. A write answers the fixture for its own route so the UI
 * can be driven, but **nothing accumulates**: there is no in-memory store
 * pretending to be a database. The retired Flutter client's mock mode
 * persisted the user's edits to `shared_preferences`, which is exactly how a
 * developer comes to trust a fake — and #148 forbids that pattern here.
 */
import { apiMode } from '../config/env';

import alphaFeedbackFlag from './__fixtures__/alphaFeedback.flag.json';
import analyticsAck from './__fixtures__/analytics.ack.json';
import captureConfirmation from './__fixtures__/capture.confirmation.json';
import captureProposal from './__fixtures__/capture.proposal.json';
import commitmentsAction from './__fixtures__/commitments.action.json';
import commitmentsDeleted from './__fixtures__/commitments.deleted.json';
import commitmentsOne from './__fixtures__/commitments.one.json';
import commitmentsPatched from './__fixtures__/commitments.patched.json';
import commitmentsToday from './__fixtures__/commitments.today.json';
import commitmentsUpcoming from './__fixtures__/commitments.upcoming.json';
import feedbackHistory from './__fixtures__/feedback.history.json';
import feedbackRevoked from './__fixtures__/feedback.revoked.json';
import nextStepDecision from './__fixtures__/nextStep.decision.json';
import nextStepRecommendation from './__fixtures__/nextStep.recommendation.json';
import trustState from './__fixtures__/trust.state.json';
import trustUpdated from './__fixtures__/trust.updated.json';

export interface MockResponse {
  status: number;
  body: unknown;
}

/**
 * `[method, path pattern, response]`. Order matters: the first match wins, so
 * the more specific pattern comes first.
 */
const ROUTES: [string, RegExp, MockResponse][] = [
  ['POST', /^\/api\/mobile\/capture\/confirm$/, { status: 200, body: captureConfirmation }],
  ['POST', /^\/api\/mobile\/capture$/, { status: 200, body: captureProposal }],

  ['GET', /^\/api\/mobile\/commitments\/today$/, { status: 200, body: commitmentsToday }],
  ['GET', /^\/api\/mobile\/commitments\/upcoming$/, { status: 200, body: commitmentsUpcoming }],
  ['POST', /^\/api\/mobile\/commitments\/[^/]+\/actions$/, { status: 200, body: commitmentsAction }],
  ['GET', /^\/api\/mobile\/commitments\/[^/]+$/, { status: 200, body: commitmentsOne }],
  ['PATCH', /^\/api\/mobile\/commitments\/[^/]+$/, { status: 200, body: commitmentsPatched }],
  ['DELETE', /^\/api\/mobile\/commitments\/[^/]+$/, { status: 200, body: commitmentsDeleted }],

  ['GET', /^\/api\/mobile\/recommendations\/next-step$/, { status: 200, body: nextStepRecommendation }],
  ['POST', /^\/api\/mobile\/recommendations\/next-step\/actions$/, { status: 200, body: nextStepDecision }],

  ['GET', /^\/api\/mobile\/pilot\/trust$/, { status: 200, body: trustState }],
  ['POST', /^\/api\/mobile\/pilot\/trust$/, { status: 200, body: trustUpdated }],

  ['GET', /^\/api\/mobile\/feedback\/history$/, { status: 200, body: feedbackHistory }],
  ['POST', /^\/api\/mobile\/feedback\/[^/]+\/revoke$/, { status: 200, body: feedbackRevoked }],
  ['POST', /^\/api\/mobile\/alpha\/feedback$/, { status: 201, body: alphaFeedbackFlag }],
  ['POST', /^\/api\/mobile\/analytics$/, { status: 200, body: analyticsAck }],
];

/** True when this build is serving fixtures. Always false in a release. */
export function mockModeActive(): boolean {
  return apiMode() === 'mock';
}

/**
 * The fixture for a request, or null to let it go to the network.
 *
 * `DELETE /api/mobile/account` is deliberately **not** here. Faking a
 * deletion would hand back a receipt for an account that still exists, which
 * is the one lie in this product with no recoverable version.
 */
export function mockResponseFor(method: string, path: string): MockResponse | null {
  if (!mockModeActive()) return null;
  for (const [routeMethod, pattern, response] of ROUTES) {
    if (routeMethod === method && pattern.test(path)) return response;
  }
  // An unmapped route in mock mode is a 501, not a silent fall-through to a
  // network the developer has told us not to use. A screen hitting something
  // unmapped should say so loudly while it is cheap to fix.
  return { status: 501, body: { success: false, error: `no fixture for ${method} ${path}`, reason: 'not_mocked' } };
}
