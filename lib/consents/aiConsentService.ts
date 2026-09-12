/**
 * Whether this account has agreed to AI processing (UC-2.1, #161).
 *
 * ── Missing means declined ───────────────────────────────────────
 *
 * The single most important line in this file. A user who has never been asked
 * has not agreed, and the failure mode of getting that backwards is sending
 * somebody's sentences to Google without their knowledge. So there is no
 * default-on path, no "unset means allowed", and no way to write `granted`
 * except through `setAiConsent` with a version this server recognises.
 *
 * ── Never cached ─────────────────────────────────────────────────
 *
 * Consent is read per request, from storage, every time. A cache — even a
 * one-minute one — means revocation does not take effect until it expires, and
 * "I turned it off" has to be true on the next request rather than soon. It is
 * one document read on a path that already does several.
 *
 * ── The audit trail is the existing one ──────────────────────────
 *
 * Every change appends a pilot audit event with `eventType: 'consent_changed'`,
 * which already exists, is already validated, and is already deleted with the
 * account. The alternative — the domain event log — is replayed to rebuild
 * commitments, and a consent record has no business in that stream.
 */
import {
  AI_CONSENT_VERSION,
  isSupportedAiConsentVersion,
  type AiConsentRecord,
  type AiConsentState,
  type ConsentLocale,
  type ConsentPlatform,
} from '../../src/contracts/v1/consentContracts';
import { createPilotAuditEvent } from '../pilot/closedPilotControls';
import { appendAudit } from '../pilot/pilotTrustStore';
import { getStorage, requireUserId, userDoc, type StorageAdapter } from '../storage';

/** The user document's consent map, as this service reads and writes it. */
interface ConsentBearingUser {
  consents?: {
    aiProcessing?: AiConsentRecord;
  };
}

export class UnsupportedConsentVersionError extends Error {
  constructor(readonly version: unknown) {
    super('unsupported consent version');
    this.name = 'UnsupportedConsentVersionError';
  }
}

export interface AiConsentOptions {
  storage?: StorageAdapter;
}

/**
 * The stored record, or null when there has never been one.
 *
 * Separate from `getAiConsent` because the API needs to tell "declined" from
 * "never asked" — that difference is what decides whether the app shows the
 * consent card — while every enforcement path only needs the yes/no.
 */
export async function readAiConsent(
  uid: string,
  options: AiConsentOptions = {},
): Promise<AiConsentRecord | null> {
  requireUserId(uid);
  const storage = options.storage ?? getStorage();
  const user = await storage.get<ConsentBearingUser>(userDoc(uid));
  const record = user?.consents?.aiProcessing;
  if (!record || typeof record.state !== 'string') return null;
  // A record written against a version this server no longer recognises is not
  // consent to what it asks today. It reads as declined until re-asked.
  if (!isSupportedAiConsentVersion(record.version)) return { ...record, state: 'declined' };
  return record;
}

/**
 * Granted, or declined. There is no third answer and no default-on.
 */
export async function getAiConsent(uid: string, options: AiConsentOptions = {}): Promise<AiConsentState> {
  const record = await readAiConsent(uid, options);
  return record?.state === 'granted' ? 'granted' : 'declined';
}

export interface SetAiConsentInput {
  state: AiConsentState;
  version: string;
  locale?: ConsentLocale;
  platform?: ConsentPlatform;
  at?: Date;
}

/**
 * Records an answer, and the fact that it was given.
 *
 * The uid is the caller's own, taken from a verified token by the route. This
 * function never accepts one from a request body.
 */
export async function setAiConsent(
  uid: string,
  input: SetAiConsentInput,
  options: AiConsentOptions = {},
): Promise<AiConsentRecord> {
  requireUserId(uid);
  if (input.state !== 'granted' && input.state !== 'declined') {
    throw new Error('consent state must be granted or declined');
  }
  // Unknown versions are refused rather than silently upgraded: accepting one
  // would record agreement to words this server cannot show anyone.
  if (!isSupportedAiConsentVersion(input.version)) throw new UnsupportedConsentVersionError(input.version);

  const storage = options.storage ?? getStorage();
  const at = (input.at ?? new Date()).toISOString();
  const record: AiConsentRecord = {
    state: input.state,
    version: input.version,
    changedAt: at,
    ...(input.locale ? { locale: input.locale } : {}),
    ...(input.platform ? { platform: input.platform } : {}),
  };

  await storage.runTransaction(async (tx) => {
    const current = await tx.get<ConsentBearingUser>(userDoc(uid));
    tx.merge<ConsentBearingUser>(userDoc(uid), {
      consents: { ...(current?.consents ?? {}), aiProcessing: record },
    });
  });

  // Appended after the write commits: an audit line for a change that did not
  // happen would be worse than a missing one.
  await appendAudit(createPilotAuditEvent({
    version: 'v1',
    eventType: 'consent_changed',
    participantId: uid,
    occurredAt: at,
    outcome: 'recorded',
    reasonCode: `ai_processing_${input.state}`,
  }));

  return record;
}

/** What `GET /api/mobile/consents` answers with. */
export async function aiConsentView(uid: string, options: AiConsentOptions = {}): Promise<{
  aiProcessing: AiConsentRecord & { asked: boolean };
  currentVersion: string;
}> {
  const record = await readAiConsent(uid, options);
  return {
    aiProcessing: record
      ? { ...record, asked: true }
      // Never asked: declined, and the client needs to know it is allowed to
      // ask rather than treating this as a decision the user made.
      : { state: 'declined', version: AI_CONSENT_VERSION, changedAt: '', asked: false },
    currentVersion: AI_CONSENT_VERSION,
  };
}
