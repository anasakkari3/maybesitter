/**
 * The personalization control centre endpoint.
 *
 * Thin on purpose: parse JSON, hand the value to `handleControlsRequest`, return
 * what it says. Every decision — including every rejection — is in the library
 * so it is reachable from a test that binds no port. `api/recommendation/review`
 * is the same shape.
 *
 * `deleteScope` is absent until #41's `deletePersonalizationScope` merges. The
 * handler answers a delete request with 501 and a named code rather than
 * pretending; a control centre that reports a deletion it did not perform is
 * worse than one that admits it cannot yet.
 */
import {
  createFileFeedbackEventStore,
} from '../../../../lib/feedback/feedbackEventStore';
import { createFileRuntimeMemoryStore } from '../../../../lib/runtimeMemory/runtimeMemoryStore';
import { createFilePersonalizationConsentStore } from '../../../../lib/personalizationControls/consentStore';
import { handleControlsRequest } from '../../../../lib/personalizationControls/handler';
import type { PersonalizationControlsPort } from '../../../../lib/personalizationControls/controlsPort';

export const dynamic = 'force-dynamic';

function port(): PersonalizationControlsPort {
  return {
    feedback: createFileFeedbackEventStore(),
    memory: createFileRuntimeMemoryStore(),
    consent: createFilePersonalizationConsentStore(),
    // #41's deriver is not on this branch. `deriver_unavailable` is the honest
    // answer and the inventory says so in words rather than showing an empty
    // preference list that reads as "we have learned nothing about you".
    deriver: null,
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

  const outcome = handleControlsRequest({ port: port() }, body);
  return Response.json(outcome.response, { status: outcome.status });
}
