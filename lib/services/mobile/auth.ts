import { parseAndValidatePilotToken } from '../../pilot/pilotTokenService';

export interface MobilePilotAuthContext {
  participantId: string;
}

export class MobileAuthError extends Error {
  constructor(message: string, readonly status: 401 | 403, readonly reason: string) {
    super(message);
  }
}

export function pilotAuthConfigured(): boolean {
  return Boolean(process.env.MAYBESITTER_PILOT_TOKEN_SECRET || process.env.MAYBESITTER_CLOSED_PILOT_IDS);
}

function statusForReason(reason: string): 401 | 403 {
  return ['not_allowlisted', 'revoked', 'deleted'].includes(reason) ? 403 : 401;
}

export function mobileAuthErrorResponse(error: unknown): Response {
  if (error instanceof MobileAuthError) {
    return Response.json(
      { success: false, error: error.message, reason: error.reason },
      { status: error.status },
    );
  }
  return Response.json({ success: false, error: 'unauthorized', reason: 'unauthorized' }, { status: 401 });
}

export function requireMobilePilotAuth(request: Request): MobilePilotAuthContext {
  const validation = parseAndValidatePilotToken(request.headers.get('authorization'));
  if (!validation.valid || !validation.participantId) {
    const reason = validation.reason || 'unauthorized';
    throw new MobileAuthError(reason, statusForReason(reason), reason);
  }
  return { participantId: validation.participantId };
}

export function optionalMobilePilotAuth(request: Request): MobilePilotAuthContext | null {
  if (!pilotAuthConfigured() && !request.headers.get('authorization')) return null;
  return requireMobilePilotAuth(request);
}
