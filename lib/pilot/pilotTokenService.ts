import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { requirePilotParticipantId } from './closedPilotControls';
import { resolvePilotAccess } from './pilotAccess';

export interface PilotTokenPayload {
  version: 'v1';
  participantId: string;
  issuedAt: string;
}

export function getRequiredTokenSecret(overrideSecret?: string): string {
  const secret = overrideSecret || process.env.MAYBESITTER_PILOT_TOKEN_SECRET;
  if (!secret || typeof secret !== 'string' || secret.trim().length < 16) {
    throw new Error('MAYBESITTER_PILOT_TOKEN_SECRET environment variable is required and must be at least 16 characters');
  }
  return secret.trim();
}

export function generatePilotToken(participantId: string, secretOverride?: string): string {
  requirePilotParticipantId(participantId);
  const secret = getRequiredTokenSecret(secretOverride);
  const nonce = randomBytes(16).toString('hex');
  const payloadStr = `v1:${participantId}:${nonce}`;
  const signature = createHmac('sha256', secret).update(payloadStr).digest('hex');
  return `p-token.${participantId}.${nonce}.${signature}`;
}

export function parseAndValidatePilotToken(
  token: string | null | undefined,
  secretOverride?: string
): { valid: boolean; participantId?: string; reason?: string } {
  if (!token || typeof token !== 'string') {
    return { valid: false, reason: 'missing_token' };
  }

  const clean = token.replace(/^Bearer\s+/i, '').trim();
  const parts = clean.split('.');
  if (parts.length !== 4 || parts[0] !== 'p-token') {
    return { valid: false, reason: 'malformed_token' };
  }

  const [, participantId, nonce, signature] = parts;
  try {
    requirePilotParticipantId(participantId);
  } catch {
    return { valid: false, reason: 'invalid_participant_id' };
  }

  let secret: string;
  try {
    secret = getRequiredTokenSecret(secretOverride);
  } catch (err) {
    return { valid: false, participantId, reason: err instanceof Error ? err.message : 'missing_secret' };
  }

  const payloadStr = `v1:${participantId}:${nonce}`;
  const expectedSig = createHmac('sha256', secret).update(payloadStr).digest('hex');

  const sigBuffer = Buffer.from(signature, 'hex');
  const expectedBuffer = Buffer.from(expectedSig, 'hex');

  if (sigBuffer.length !== expectedBuffer.length || !timingSafeEqual(sigBuffer, expectedBuffer)) {
    return { valid: false, participantId, reason: 'invalid_signature' };
  }

  // Validate trust state & allowlist
  try {
    const access = resolvePilotAccess(participantId, new Date().toISOString(), false);
    if (!access.trust) {
      return { valid: false, participantId, reason: access.decision.reason };
    }
    if (access.trust.revokedAt) {
      return { valid: false, participantId, reason: 'revoked' };
    }
    if (access.trust.deletedAt) {
      return { valid: false, participantId, reason: 'deleted' };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('not allowlisted') || msg.includes('not admitted')) {
      return { valid: false, participantId, reason: 'not_allowlisted' };
    }
  }

  return { valid: true, participantId };
}
