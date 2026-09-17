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

import activityList from './__fixtures__/activity.list.json';
import activitySummary from './__fixtures__/activity.summary.json';
import alphaFeedbackFlag from './__fixtures__/alphaFeedback.flag.json';
import analyticsAck from './__fixtures__/analytics.ack.json';
import captureConfirmation from './__fixtures__/capture.confirmation.json';
import captureProposal from './__fixtures__/capture.proposal.json';
import captureShareProposal from './__fixtures__/capture.shareProposal.json';
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
import planToday from './__fixtures__/plan.today.json';
import planAccepted from './__fixtures__/plan.accepted.json';
import planRegenerated from './__fixtures__/plan.regenerated.json';
import planBuilt from './__fixtures__/plan.built.json';
import planSettingsSaved from './__fixtures__/plan.settingsSaved.json';
import consentsAnswered from './__fixtures__/consents.answered.json';
import consentsAiRecorded from './__fixtures__/consents.aiRecorded.json';
import consentsPersonalizationRecorded from './__fixtures__/consents.personalizationRecorded.json';
import consentsRecommendationsRecorded from './__fixtures__/consents.recommendationsRecorded.json';
import memoryCreated from './__fixtures__/memory.created.json';
import memoryDeleted from './__fixtures__/memory.deleted.json';
import memoryList from './__fixtures__/memory.list.json';
import memorySuggestionKept from './__fixtures__/memory.suggestionKept.json';
import profileOne from './__fixtures__/profile.one.json';
import profileSaved from './__fixtures__/profile.saved.json';
import readinessCurrent from './__fixtures__/readiness.current.json';
import readinessSaved from './__fixtures__/readiness.saved.json';
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
  // The share route (UC-3.0, #183). `apiUpload` consults this table too, so a
  // share screen can be driven on fixtures with no backend and no share sheet.
  ['POST', /^\/api\/mobile\/capture\/share$/, { status: 200, body: captureShareProposal }],
  ['POST', /^\/api\/mobile\/capture$/, { status: 200, body: captureProposal }],

  ['GET', /^\/api\/mobile\/commitments\/today$/, { status: 200, body: commitmentsToday }],
  ['GET', /^\/api\/mobile\/commitments\/upcoming$/, { status: 200, body: commitmentsUpcoming }],
  ['POST', /^\/api\/mobile\/commitments\/[^/]+\/actions$/, { status: 200, body: commitmentsAction }],
  ['GET', /^\/api\/mobile\/commitments\/[^/]+$/, { status: 200, body: commitmentsOne }],
  ['PATCH', /^\/api\/mobile\/commitments\/[^/]+$/, { status: 200, body: commitmentsPatched }],
  ['DELETE', /^\/api\/mobile\/commitments\/[^/]+$/, { status: 200, body: commitmentsDeleted }],

  ['GET', /^\/api\/mobile\/recommendations\/next-step$/, { status: 200, body: nextStepRecommendation }],
  ['POST', /^\/api\/mobile\/recommendations\/next-step\/actions$/, { status: 200, body: nextStepDecision }],

  /*
   * The activity fixtures answer `nextCursor: null` (#201). That is not an
   * accident of the data: this adapter serves the same body for every request,
   * so a fixture that named a cursor would make the infinite scroll ask for
   * the next page forever.
   */
  ['GET', /^\/api\/mobile\/activity\/summary$/, { status: 200, body: activitySummary }],
  ['GET', /^\/api\/mobile\/activity$/, { status: 200, body: activityList }],

  /*
   * The daily plan (#194, rendered by #195).
   *
   * The action route answers `plan.accepted` whatever action was sent. That is
   * the same bargain the rest of this adapter makes — nothing accumulates, so
   * an edit or a dismiss comes back as an accepted plan rather than as the
   * state it asked for. Mock mode is for driving a screen before a backend is
   * reachable, not for believing it.
   */
  ['GET', /^\/api\/mobile\/plans\/[^/]+$/, { status: 200, body: planToday }],
  ['POST', /^\/api\/mobile\/plans\/[^/]+\/actions$/, { status: 200, body: planAccepted }],
  ['POST', /^\/api\/mobile\/plans\/[^/]+\/regenerate$/, { status: 200, body: planRegenerated }],
  ['POST', /^\/api\/mobile\/plans\/[^/]+\/build$/, { status: 200, body: planBuilt }],
  ['GET', /^\/api\/mobile\/settings\/plan$/, { status: 200, body: planSettingsSaved }],
  ['PUT', /^\/api\/mobile\/settings\/plan$/, { status: 200, body: planSettingsSaved }],

  ['GET', /^\/api\/mobile\/pilot\/trust$/, { status: 200, body: trustState }],
  ['POST', /^\/api\/mobile\/pilot\/trust$/, { status: 200, body: trustUpdated }],

  ['GET', /^\/api\/mobile\/feedback\/history$/, { status: 200, body: feedbackHistory }],
  ['POST', /^\/api\/mobile\/feedback\/[^/]+\/revoke$/, { status: 200, body: feedbackRevoked }],
  ['POST', /^\/api\/mobile\/alpha\/feedback$/, { status: 201, body: alphaFeedbackFlag }],
  ['POST', /^\/api\/mobile\/analytics$/, { status: 200, body: analyticsAck }],

  ['GET', /^\/api\/mobile\/consents$/, { status: 200, body: consentsAnswered }],
  ['PUT', /^\/api\/mobile\/consents\/ai-processing$/, { status: 200, body: consentsAiRecorded }],
  ['PUT', /^\/api\/mobile\/consents\/recommendations$/, { status: 200, body: consentsRecommendationsRecorded }],
  ['PUT', /^\/api\/mobile\/consents\/personalization$/, { status: 200, body: consentsPersonalizationRecorded }],

  ['GET', /^\/api\/mobile\/profile$/, { status: 200, body: profileOne }],
  ['PUT', /^\/api\/mobile\/profile\/routine$/, { status: 200, body: profileSaved }],
  ['GET', /^\/api\/mobile\/readiness$/, { status: 200, body: readinessCurrent }],
  ['PUT', /^\/api\/mobile\/readiness$/, { status: 200, body: readinessSaved }],
  ['GET', /^\/api\/mobile\/memory$/, { status: 200, body: memoryList }],
  ['POST', /^\/api\/mobile\/memory$/, { status: 201, body: memoryCreated }],
  ['PATCH', /^\/api\/mobile\/memory\/[^/]+$/, { status: 200, body: memoryCreated }],
  ['DELETE', /^\/api\/mobile\/memory\/[^/]+$/, { status: 200, body: memoryDeleted }],
  ['DELETE', /^\/api\/mobile\/memory$/, { status: 200, body: memoryDeleted }],
  // Keep and dismiss share a route and the same bargain as the plan actions:
  // whatever was decided, the kept answer comes back, and nothing accumulates.
  ['POST', /^\/api\/mobile\/memory\/suggestions\/[^/]+$/, { status: 201, body: memorySuggestionKept }],
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
