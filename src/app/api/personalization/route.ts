/**
 * The personalization control centre endpoint.
 *
 * Thin on purpose: parse JSON, hand the value to `handleControlsRequest`, return
 * what it says. Every decision — including every rejection — is in the library
 * so it is reachable from a test that binds no port. `api/recommendation/review`
 * is the same shape.
 *
 * Both seams #42 was built against are filled at integration: `deriver` is
 * #41's real `derivePersonalizationProfile` and `deleteScope` is its
 * `deletePersonalizationScope`. They were injected rather than imported so this
 * file could exist — and be tested — before #41 merged, and the handler's
 * refusal paths for a missing deriver and a missing deleter are still reachable
 * and still tested, because a build that loses one of them should say so rather
 * than crash.
 */
import {
  createFileFeedbackEventStore,
} from '../../../../lib/feedback/feedbackEventStore';
import { createFileRuntimeMemoryStore } from '../../../../lib/runtimeMemory/runtimeMemoryStore';
import { createFilePersonalizationConsentStore } from '../../../../lib/personalizationControls/consentStore';
import { handleControlsRequest } from '../../../../lib/personalizationControls/handler';
import { derivePersonalizationProfile } from '../../../../lib/personalization/derive';
import { deletePersonalizationScope } from '../../../../lib/personalization/deletion';
import type { PersonalizationControlsPort } from '../../../../lib/personalizationControls/controlsPort';

export const dynamic = 'force-dynamic';

function port(): PersonalizationControlsPort {
  return {
    feedback: createFileFeedbackEventStore(),
    memory: createFileRuntimeMemoryStore(),
    consent: createFilePersonalizationConsentStore(),
    deriver: derivePersonalizationProfile,
    // No ambient state: the adaptive signals a real request should carry come
    // from the caller's session, and until the control centre has a session to
    // read this reports the unclassified default rather than another user's.
    readAdaptiveSignals: () => ({}),
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

  const active = port();
  const outcome = handleControlsRequest(
    {
      port: active,
      // The stores are read from the same `port()` the rest of the request uses,
      // so a delete and the inventory rebuilt after it cannot disagree about
      // which stores they were talking to.
      deleteScope: (scopeId, now) =>
        deletePersonalizationScope({
          scopeId,
          now,
          feedbackEvents: active.feedback,
          runtimeMemory: active.memory,
        }),
    },
    body,
  );
  return Response.json(outcome.response, { status: outcome.status });
}
