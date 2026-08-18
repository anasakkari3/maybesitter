import {
  validateFlagInput,
  type AlphaFeedbackFlag,
} from '../../../../../../src/contracts/v1/feedbackFlagContracts';
import { mobilePilotErrorResponse } from '../../../../../../lib/services/mobile/pilotService';
import { mobileAuthErrorResponse, requireMobilePilotAuth } from '../../../../../../lib/services/mobile/auth';
import {
  createFileAlphaFeedbackStore,
  type AlphaFeedbackStore,
} from '../../../../../../lib/alphaFeedback/alphaFeedbackStore';
import { recordTraceStage, stage } from '../../../../../../lib/alphaTrace/traceRecorder';

export const dynamic = 'force-dynamic';

let _store: AlphaFeedbackStore | null = null;

function getStore(): AlphaFeedbackStore {
  if (!_store) _store = createFileAlphaFeedbackStore();
  return _store;
}

export async function POST(request: Request) {
  if (!process.env.MAYBESITTER_ALPHA_FEEDBACK_ENABLED) {
    return mobilePilotErrorResponse(new Error('feature_disabled'));
  }
  let auth;
  try {
    auth = requireMobilePilotAuth(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return mobilePilotErrorResponse(new Error('invalid_json'));
  }

  const input = {
    ...(body as Record<string, unknown>),
    participantId: auth.participantId,
  };

  try {
    validateFlagInput(input);
  } catch (error) {
    return mobilePilotErrorResponse(error);
  }

  const store = getStore();
  const flag: AlphaFeedbackFlag = store.record(input as Parameters<typeof store.record>[0]);

  // Link the flag into the reviewable trace (no-op unless tracing is enabled).
  try {
    recordTraceStage(
      flag.sessionId,
      flag.participantId,
      stage('feedback_flagged', {
        flagId: flag.flagId,
        category: flag.category,
        proposalId: flag.proposalId,
        note: flag.note,
      }),
    );
  } catch {
    // trace recording must never break the flag path
  }

  return Response.json({ flagId: flag.flagId, category: flag.category }, { status: 201 });
}

export async function GET(request: Request) {
  if (!process.env.MAYBESITTER_ALPHA_FEEDBACK_ENABLED) {
    return mobilePilotErrorResponse(new Error('feature_disabled'));
  }
  let auth;
  try {
    auth = requireMobilePilotAuth(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const url = new URL(request.url);
  const participantId = url.searchParams.get('participantId') || auth.participantId;

  const store = getStore();
  const flags = store.list({ participantId });

  return Response.json({ flags, count: flags.length });
}
