import { parseAndValidatePilotToken } from '../../pilot/pilotTokenService';
import {
  pilotModeEnabled,
  PilotRuntimeConfigurationError,
  validatePilotRuntimeConfiguration,
} from './pilotRuntimeConfig';

export interface MobilePilotAuthContext {
  participantId: string;
}

export class MobileAuthError extends Error {
  constructor(message: string, readonly status: 401 | 403 | 503, readonly reason: string) {
    super(message);
  }
}

export function pilotAuthConfigured(): boolean {
  return pilotModeEnabled() || Boolean(process.env.MAYBESITTER_PILOT_TOKEN_SECRET || process.env.MAYBESITTER_CLOSED_PILOT_IDS);
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
  if (error instanceof PilotRuntimeConfigurationError) {
    return Response.json(
      { success: false, error: error.message, reason: error.reason },
      { status: 503 },
    );
  }
  return Response.json({ success: false, error: 'unauthorized', reason: 'unauthorized' }, { status: 401 });
}

export function requireMobilePilotAuth(request: Request): MobilePilotAuthContext {
  validatePilotRuntimeConfiguration();
  const validation = parseAndValidatePilotToken(request.headers.get('authorization'));
  if (!validation.valid || !validation.participantId) {
    const reason = validation.reason || 'unauthorized';
    throw new MobileAuthError(reason, statusForReason(reason), reason);
  }
  return { participantId: validation.participantId };
}

export function optionalMobilePilotAuth(request: Request): MobilePilotAuthContext | null {
  if (pilotModeEnabled()) {
    validatePilotRuntimeConfiguration();
    return requireMobilePilotAuth(request);
  }
  if (!pilotAuthConfigured() && !request.headers.get('authorization')) return null;
  return requireMobilePilotAuth(request);
}
