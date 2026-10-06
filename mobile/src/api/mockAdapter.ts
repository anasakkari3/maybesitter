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
import backgroundActivityFootballRetrying from './__fixtures__/backgroundActivity.footballRetrying.json';
import backgroundActivityHistory from './__fixtures__/backgroundActivity.history.json';
import captureChatProposal from './__fixtures__/capture.chatProposal.json';
import captureChatCorrection from './__fixtures__/capture.chatCorrection.json';
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
import planOpened from './__fixtures__/plan.opened.json';
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
import financialConnected from './__fixtures__/financial.connected.json';
import financialContext from './__fixtures__/financial.context.json';
import financialManual from './__fixtures__/financial.manual.json';
import financialManualSaved from './__fixtures__/financial.manualSaved.json';
import readinessCurrent from './__fixtures__/readiness.current.json';
import readinessSaved from './__fixtures__/readiness.saved.json';
import remindersSettingsDefault from './__fixtures__/reminders.settingsDefault.json';
import remindersSettingsSaved from './__fixtures__/reminders.settingsSaved.json';
import trustState from './__fixtures__/trust.state.json';
import trustUpdated from './__fixtures__/trust.updated.json';
import weeklyBlocksCreated from './__fixtures__/weeklyBlocks.created.json';
import weeklyBlocksDeleted from './__fixtures__/weeklyBlocks.deleted.json';
import weeklyBlocksList from './__fixtures__/weeklyBlocks.list.json';
import weeklyBlocksOccurrences from './__fixtures__/weeklyBlocks.occurrences.json';
import weeklyBlocksPaused from './__fixtures__/weeklyBlocks.paused.json';
import intelligenceAnalyzed from './__fixtures__/intelligence.analyzed.json';
import intelligenceGenerated from './__fixtures__/intelligence.generated.json';
import intelligenceGmailMonitor from './__fixtures__/intelligence.gmailMonitor.json';
import intelligenceGmailMonitorSet from './__fixtures__/intelligence.gmailMonitorSet.json';
import intelligenceGmailScanComplete from './__fixtures__/intelligence.gmailScanComplete.json';
import intelligenceInbox from './__fixtures__/intelligence.inbox.json';
import intelligenceObservationReviewed from './__fixtures__/intelligence.observationReviewed.json';

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
  // The capture chat «احكيها»: every composer send goes here.
  ['POST', /^\/api\/mobile\/capture\/chat$/, { status: 200, body: captureChatProposal }],
  ['POST', /^\/api\/mobile\/capture\/share$/, { status: 200, body: captureShareProposal }],
  ['POST', /^\/api\/mobile\/capture$/, { status: 200, body: captureProposal }],

  ['GET', /^\/api\/mobile\/commitments\/today$/, { status: 200, body: commitmentsToday }],
  ['GET', /^\/api\/mobile\/commitments\/upcoming$/, { status: 200, body: commitmentsUpcoming }],
  ['POST', /^\/api\/mobile\/commitments\/[^/]+\/actions$/, { status: 200, body: commitmentsAction }],
  ['GET', /^\/api\/mobile\/commitments\/[^/]+$/, { status: 200, body: commitmentsOne }],
  ['PATCH', /^\/api\/mobile\/commitments\/[^/]+$/, { status: 200, body: commitmentsPatched }],
  ['DELETE', /^\/api\/mobile\/commitments\/[^/]+$/, { status: 200, body: commitmentsDeleted }],

  // Weekly fixed blocks («ثابت أسبوعي»). A PATCH answers the paused fixture
  // whatever it changed — nothing accumulates here.
  ['GET', /^\/api\/mobile\/weekly-blocks\/occurrences$/, { status: 200, body: weeklyBlocksOccurrences }],
  ['GET', /^\/api\/mobile\/weekly-blocks$/, { status: 200, body: weeklyBlocksList }],
  ['POST', /^\/api\/mobile\/weekly-blocks$/, { status: 201, body: weeklyBlocksCreated }],
  ['PATCH', /^\/api\/mobile\/weekly-blocks\/[^/]+$/, { status: 200, body: weeklyBlocksPaused }],
  ['DELETE', /^\/api\/mobile\/weekly-blocks\/[^/]+$/, { status: 200, body: weeklyBlocksDeleted }],

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
  // "The plan was put on screen" (#533): the acknowledgement is all the route
  // answers, and mock mode drives the screen the same way without a ledger.
  ['POST', /^\/api\/mobile\/plans\/[^/]+\/opened$/, { status: 200, body: planOpened }],
  ['GET', /^\/api\/mobile\/settings\/plan$/, { status: 200, body: planSettingsSaved }],
  ['PUT', /^\/api\/mobile\/settings\/plan$/, { status: 200, body: planSettingsSaved }],

  ['GET', /^\/api\/mobile\/pilot\/trust$/, { status: 200, body: trustState }],
  ['POST', /^\/api\/mobile\/pilot\/trust$/, { status: 200, body: trustUpdated }],

  // Task B settings screens: fixture-backed reminders and background activity.
  ['GET', /^\/api\/mobile\/settings\/reminders$/, { status: 200, body: remindersSettingsDefault }],
  ['PUT', /^\/api\/mobile\/settings\/reminders$/, { status: 200, body: remindersSettingsSaved }],
  ['GET', /^\/api\/mobile\/trust\/background-activity\/history$/, { status: 200, body: backgroundActivityHistory }],
  ['GET', /^\/api\/mobile\/trust\/background-activity$/, { status: 200, body: backgroundActivityFootballRetrying }],
  ['PATCH', /^\/api\/mobile\/trust\/background-activity$/, { status: 200, body: backgroundActivityFootballRetrying }],

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
  ['GET', /^\/api\/mobile\/financial\/context$/, { status: 200, body: financialContext }],
  ['GET', /^\/api\/mobile\/financial\/manual$/, { status: 200, body: financialManual }],
  ['PUT', /^\/api\/mobile\/financial\/manual$/, { status: 200, body: financialManualSaved }],
  ['DELETE', /^\/api\/mobile\/financial\/manual/, { status: 200, body: { success: true } }],
  // The connected fixture, not the disconnected one: mock mode exists to work
  // on a screen, and the screen worth seeing is the populated one. The
  // disconnected shape is covered by its own fixture in the Jest suite.
  ['GET', /^\/api\/mobile\/financial\/connection$/, { status: 200, body: financialConnected }],
  ['POST', /^\/api\/mobile\/financial\/connection$/, { status: 201, body: financialConnected }],
  ['DELETE', /^\/api\/mobile\/financial\/connection$/, { status: 200, body: { success: true } }],
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
  // The proactive loop (Goals and Watching panels). The week scan is served at
  // its terminal page, because the app keeps asking until it is `complete`.
  ['GET', /^\/api\/mobile\/intelligence$/, { status: 200, body: intelligenceInbox }],
  ['POST', /^\/api\/mobile\/intelligence$/, { status: 201, body: intelligenceAnalyzed }],
  ['POST', /^\/api\/mobile\/intelligence\/observations\/[^/]+$/, { status: 200, body: intelligenceObservationReviewed }],
  ['POST', /^\/api\/mobile\/intelligence\/generate$/, { status: 200, body: intelligenceGenerated }],
  ['GET', /^\/api\/mobile\/intelligence\/sources\/gmail\/monitor$/, { status: 200, body: intelligenceGmailMonitor }],
  ['POST', /^\/api\/mobile\/intelligence\/sources\/gmail\/monitor$/, { status: 200, body: intelligenceGmailMonitorSet }],
  ['POST', /^\/api\/mobile\/intelligence\/sources\/gmail\/scan$/, { status: 200, body: intelligenceGmailScanComplete }],
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
/**
 * The fixture for a request. `body` is the parsed request body, for routes
 * whose answer depends on what was asked (the capture chat's structured
 * edits, M2b); every other route ignores it. Nothing is remembered between
 * calls: mock mode never pretends to persist.
 */
export function mockResponseFor(method: string, path: string, body?: unknown): MockResponse | null {
  if (!mockModeActive()) return null;
  if (method === 'POST' && path === '/api/mobile/capture/chat') return mockChat(body);
  for (const [routeMethod, pattern, response] of ROUTES) {
    if (routeMethod === method && pattern.test(path)) return response;
  }
  // An unmapped route in mock mode is a 501, not a silent fall-through to a
  // network the developer has told us not to use. A screen hitting something
  // unmapped should say so loudly while it is cheap to fix.
  return { status: 501, body: { success: false, error: `no fixture for ${method} ${path}`, reason: 'not_mocked' } };
}

/* ── The capture chat, request-aware (M2b) ─────────────────────────── */

/** Mock mode's proposals start at revision 1; an edit naming an older one is stale. */
const MOCK_BASE_REVISION = 1;
const SEED_KINDS = new Set(['possible_goal', 'consideration', 'idea', 'waiting_for']);

type MockProposal = {
  revision?: number;
  items: Record<string, unknown>[];
  seeds: Record<string, unknown>[];
  understood?: Record<string, unknown>[];
} & Record<string, unknown>;
type MockAnswer = { proposal: MockProposal | null; turns: unknown[] } & Record<string, unknown>;
type MockEdit = {
  revision?: number;
  target?: { itemId?: string; seedItemId?: string };
  change?: { kind?: string; text?: string; time?: { at: string | null }; rejectCorrectionIds?: string[] };
};

function baseAnswer(source: unknown = captureChatProposal): MockAnswer {
  const answer = JSON.parse(JSON.stringify(source)) as MockAnswer;
  if (answer.proposal) answer.proposal.revision = Math.max(answer.proposal.revision ?? 0, MOCK_BASE_REVISION);
  return answer;
}

/**
 * A message gets the chat fixture at the base revision. A structured edit gets
 * that same fixture with the requested change applied — deterministically, from
 * the request alone, at the next revision — so every edit path can be driven on
 * a phone with no backend. Nothing is remembered between calls.
 */
function mockChat(body: unknown): MockResponse {
  const request = body as { edit?: MockEdit; spoken?: boolean; locale?: string } | undefined;
  const edit = request?.edit;
  // A dictated message gets the route's own answer to one: «فهمت "الطلع" إنها "اطلع"».
  if (!edit) return { status: 200, body: baseAnswer(request?.spoken ? captureChatCorrection : captureChatProposal) };
  const current = baseAnswer();
  if ((edit.revision ?? 0) < MOCK_BASE_REVISION) {
    return { status: 409, body: { reason: 'proposal_changed', answer: current } };
  }
  // Undoing a correction edits the corrected answer, the only one that has one.
  const answer = baseAnswer(edit.change?.rejectCorrectionIds ? captureChatCorrection : captureChatProposal);
  const proposal = answer.proposal!;
  proposal.revision = (edit.revision ?? MOCK_BASE_REVISION) + 1;
  const change = edit.change ?? {};
  const itemId = edit.target?.itemId;
  const seedId = edit.target?.seedItemId;
  const item = proposal.items.find((candidate) => candidate.itemId === itemId);
  const seed = proposal.seeds.find((candidate) => candidate.seedItemId === seedId);
  // What the server refuses, refused here too: an unknown point, a time on a
  // seed that stays a seed, words with a correction undo in one patch.
  const invalid = (!item && !seed)
    || (seed && change.time && change.kind !== 'commitment')
    || (change.text !== undefined && change.rejectCorrectionIds !== undefined);
  if (invalid) return { status: 400, body: { reason: 'edit_invalid' } };
  const point = (proposal.understood ?? []).find((candidate) =>
    (item && candidate.itemId === item.itemId) || (seed && candidate.seedItemId === seed.seedItemId));
  const before = String(point?.text ?? item?.title ?? seed?.summary ?? '');
  if (change.text !== undefined) {
    if (item) item.title = change.text;
    if (seed) seed.summary = change.text;
    if (point) point.text = change.text;
  }
  if (change.time && item) {
    item.resolvedTime = change.time.at;
    delete item.endTime;
    item.needsClarification = false;
    item.clarification = null;
  }
  if (change.rejectCorrectionIds) {
    const all = (item && Array.isArray(item.corrections) ? item.corrections : []) as { id: string; from: string; to: string }[];
    const rejected = all.filter((correction) => change.rejectCorrectionIds!.includes(correction.id));
    // The heard word goes back where the correction put the other one.
    for (const correction of rejected) {
      item!.title = String(item!.title).replace(correction.to, correction.from);
      if (point) point.text = String(point.text).replace(correction.to, correction.from);
    }
    if (item) {
      item.corrections = all.filter((correction) => !rejected.includes(correction));
      if ((item.corrections as unknown[]).length === 0) delete item.corrections;
    }
  }
  if (change.kind && SEED_KINDS.has(change.kind) && item) {
    // The item becomes a seed of that kind, keeping its id and its place.
    proposal.items = proposal.items.filter((candidate) => candidate !== item);
    proposal.seeds = [...proposal.seeds, { seedItemId: item.itemId, kind: change.kind, summary: String(item.title) }];
    if (point) Object.assign(point, { kind: change.kind, seedItemId: item.itemId, itemId: undefined });
    if (point) delete point.itemId;
  }
  if (change.kind === 'commitment' && seed) {
    proposal.seeds = proposal.seeds.filter((candidate) => candidate !== seed);
    proposal.items = [...proposal.items, {
      itemId: seed.seedItemId, title: seed.summary, resolvedTime: change.time?.at ?? null, needsClarification: !change.time?.at,
    }];
    if (point) { Object.assign(point, { kind: 'commitment', itemId: seed.seedItemId }); delete point.seedItemId; }
  }
  // The route records the edit as two turns (`structuredEdit.ts`, `editTurns`).
  const turns = editTurns(change, before, request?.locale);
  answer.reply = turns.reply;
  answer.turns = [...(answer.turns ?? []), { role: 'user', text: turns.user }, { role: 'assistant', text: turns.reply }];
  return { status: 200, body: answer };
}

/** The route's own words for an edit, in the request's language. */
function editTurns(change: NonNullable<MockEdit['change']>, before: string, locale: string | undefined): { user: string; reply: string } {
  const after = change.text ?? '';
  const user = change.text !== undefined
    ? (locale === 'en' ? `Change \u201C${before}\u201D to \u201C${after}\u201D.` : locale === 'he' ? `\u05DC\u05E9\u05E0\u05D5\u05EA \u05D0\u05EA \u201E${before}\u201D \u05DC\u201E${after}\u201D.` : `\u063A\u064A\u0651\u0631 \u00AB${before}\u00BB \u0644\u0640 \u00AB${after}\u00BB.`)
    : change.kind !== undefined
      ? (locale === 'en' ? `Change \u201C${before}\u201D to ${change.kind}.` : locale === 'he' ? `\u05DC\u05E9\u05E0\u05D5\u05EA \u05D0\u05EA \u05D4\u05E1\u05D5\u05D2 \u05E9\u05DC \u201E${before}\u201D.` : `\u063A\u064A\u0651\u0631 \u0646\u0648\u0639 \u00AB${before}\u00BB.`)
      : (locale === 'en' ? `Update \u201C${before}\u201D.` : locale === 'he' ? `\u05DC\u05E2\u05D3\u05DB\u05DF \u05D0\u05EA \u201E${before}\u201D.` : `\u0639\u062F\u0651\u0644 \u00AB${before}\u00BB.`);
  const reply = locale === 'en' ? 'Updated. Review the list and confirm below.'
    : locale === 'he' ? '\u05E2\u05D5\u05D3\u05DB\u05DF. \u05D0\u05E4\u05E9\u05E8 \u05DC\u05D1\u05D3\u05D5\u05E7 \u05D0\u05EA \u05D4\u05E8\u05E9\u05D9\u05DE\u05D4 \u05D5\u05DC\u05D0\u05E9\u05E8 \u05DC\u05DE\u05D8\u05D4.'
      : '\u062A\u0645\u0627\u0645\u060C \u0639\u062F\u0651\u0644\u062A\u0647\u0627. \u0631\u0627\u062C\u0639 \u0627\u0644\u0642\u0627\u0626\u0645\u0629 \u0648\u0623\u0643\u0651\u062F \u0645\u0646 \u062A\u062D\u062A.';
  return { user, reply };
}
