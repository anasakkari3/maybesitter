import {
  validateFlagInput,
  type AlphaFeedbackFlag,
} from '../../../../../../src/contracts/v1/feedbackFlagContracts';
import { mobilePilotErrorResponse } from '../../../../../../lib/services/mobile/pilotService';
import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import {
  createStorageAlphaFeedbackStore,
  type AlphaFeedbackStore,
} from '../../../../../../lib/alphaFeedback/alphaFeedbackStore';
import { recordTraceStage, stage } from '../../../../../../lib/alphaTrace/traceRecorder';

export const dynamic = 'force-dynamic';

let _store: AlphaFeedbackStore | null = null;

function getStore(): AlphaFeedbackStore {
  if (!_store) _store = createStorageAlphaFeedbackStore();
  return _store;
}

export async function POST(request: Request) {
  if (!process.env.MAYBESITTER_ALPHA_FEEDBACK_ENABLED) {
    return mobilePilotErrorResponse(new Error('feature_disabled'));
  }
  let user;
  try {
    user = await requireMobileUser(request);
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
    participantId: user.uid,
  };

  try {
    validateFlagInput(input);
  } catch (error) {
    return mobilePilotErrorResponse(error);
  }

  const store = getStore();
  const flag: AlphaFeedbackFlag = await store.record(input as Parameters<typeof store.record>[0]);

  // Link the flag into the reviewable trace (no-op unless tracing is enabled).
  try {
    await recordTraceStage(
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
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  // A `?participantId=` override used to be honoured here, which let any
  // authenticated caller read anyone else's flags. The scope is the uid.
  const store = getStore();
  const flags = await store.list({ participantId: user.uid });

  return Response.json({ flags, count: flags.length });
}
