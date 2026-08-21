/**
 * The controlled internal release endpoint (Sprint 11, issue #47).
 *
 * Thin on purpose: parse JSON, hand the value to `handleReleaseRequest`, return
 * what it says. Every decision — including every rejection — lives in
 * `lib/release` so it is reachable from a test that binds no port.
 * `api/personalization` is the same shape.
 *
 * ── What is wired, and what honestly is not ──────────────────────
 *
 * `consent`, `responses`, the staged exposure gate and the study collection API
 * are fully wired against real file-backed stores and the shipped pilot gate.
 *
 * Three seams are **deliberately left saying "not available"** rather than
 * stubbed to a reassuring value:
 *
 *   - `traces` / `replayBundles` are `notWiredArchive(...)` until #45's
 *     orchestrator lands. A stub answering `0` would let a deletion receipt
 *     claim zero traces remain — a claim nobody checked. Instead a delete
 *     returns `deleted_unproven` naming exactly which store could not give a
 *     proof, and the deletion itself still happens.
 *   - The safety and reliability evidence pillars are
 *     `unavailablePillarSource(...)`, so an assembled package says which input
 *     is missing instead of quietly resting on two pillars.
 *
 * Integration is one line each: `wiredArchive(#45's store)` and #46's readings
 * through `reliabilityPillarFromSloReadings`.
 *
 * The quality pillar *is* wired, to this sprint's own study responses. With no
 * responses recorded it reads inconclusive on every question, which is the
 * truthful answer for a build where nobody has been exposed yet — and it
 * becomes a real reading the day real answers arrive, with no code change.
 *
 * ── The default stage exposes nobody ─────────────────────────────
 *
 * `readStageConfiguration` is fail-closed: an unset or unrecognised
 * `MAYBESITTER_SHADOW_STAGE` is `shadow_only`, the stage this sprint ships in
 * and the one whose cap is zero. No general-release stage exists to configure.
 */
import { createFileFeedbackEventStore } from '../../../../lib/feedback/feedbackEventStore';
import { createFileRuntimeMemoryStore } from '../../../../lib/runtimeMemory/runtimeMemoryStore';
import { deletePersonalizationScope } from '../../../../lib/personalization/deletion';
import { createFileShadowStudyConsentStore } from '../../../../lib/release/consentStore';
import { createFileShadowStudyResponseStore } from '../../../../lib/release/studyStore';
import { notWiredArchive } from '../../../../lib/release/deletion';
import {
  qualityPillarFromStudy,
  unavailablePillarSource,
} from '../../../../lib/release/evidence';
import { createPilotAccessResolver, readStageConfiguration } from '../../../../lib/release/exposure';
import { summarizeStudyResponses } from '../../../../lib/release/study';
import { handleReleaseRequest, type ReleaseHandlerDeps } from '../../../../lib/release/handler';

export const dynamic = 'force-dynamic';

function wiring(): ReleaseHandlerDeps {
  const consent = createFileShadowStudyConsentStore();
  const responses = createFileShadowStudyResponseStore();
  const feedbackEvents = createFileFeedbackEventStore();
  const runtimeMemory = createFileRuntimeMemoryStore();

  return {
    consent,
    responses,
    configuration: readStageConfiguration(),
    resolvePilot: createPilotAccessResolver(),
    traces: notWiredArchive('issue_45_shadow_trace_store'),
    replayBundles: notWiredArchive('issue_45_replay_bundle_store'),
    deletePersonalization: (scopeId, now) =>
      deletePersonalizationScope({ scopeId, now, feedbackEvents, runtimeMemory }),
    evidenceSources: () => ({
      // Real participant judgements, read fresh. Empty today; a reading the day
      // answers exist.
      quality: qualityPillarFromStudy(summarizeStudyResponses(responses.listAll()), 'real_exposure'),
      safety: unavailablePillarSource('issue_45_shadow_traces'),
      reliability: unavailablePillarSource('issue_46_slo_readings'),
    }),
  };
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      {
        kind: 'rejected',
        code: 'MALFORMED_REQUEST_BODY',
        detail: 'the request body could not be parsed as JSON',
      },
      { status: 400 },
    );
  }

  const outcome = handleReleaseRequest(wiring(), body);
  return Response.json(outcome.response, { status: outcome.status });
}
