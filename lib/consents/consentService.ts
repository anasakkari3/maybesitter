/**
 * One implementation of consent, for every question we ask (UC-2.1 #161,
 * UC-2.9 #170).
 *
 * The rules below were written for AI processing and are now shared with the
 * recommendation consent, parametrised by `ConsentKindContract` rather than
 * copied. That is not tidiness. A second hand-written copy of "missing means
 * declined" is how the two would eventually come to differ, and the direction
 * nobody notices is the permissive one — the copy that treats an absent record
 * as a yes. There is one place to read, and it is this file.
 *
 * ── Missing means declined ───────────────────────────────────────
 *
 * The single most important line here. A user who has never been asked has not
 * agreed. There is no default-on path, no "unset means allowed", and no way to
 * write `granted` except through `setConsent` with a version this server
 * recognises.
 *
 * ── Never cached ─────────────────────────────────────────────────
 *
 * Consent is read per request, from storage, every time. A cache — even a
 * one-minute one — means revocation does not take effect until it expires, and
 * "I turned it off" has to be true on the next request rather than soon.
 *
 * ── The audit trail is the existing one ──────────────────────────
 *
 * Every change appends a pilot audit event with `eventType: 'consent_changed'`.
 * The alternative — the domain event log — is replayed to rebuild commitments,
 * and a consent record has no business in that stream.
 */
import {
  CONSENT_KINDS,
  type ConsentKindContract,
  type ConsentLocale,
  type ConsentPlatform,
  type ConsentRecord,
  type ConsentState,
} from '../../src/contracts/v1/consentContracts';
import { createPilotAuditEvent } from '../pilot/closedPilotControls';
import { appendAudit } from '../pilot/pilotTrustStore';
import { getStorage, requireUserId, userDoc, type StorageAdapter } from '../storage';

/** The user document's consent map, as this service reads and writes it. */
type ConsentBearingUser = {
  consents?: Partial<Record<ConsentKindContract['key'], ConsentRecord>>;
};

export class UnsupportedConsentVersionError extends Error {
  constructor(readonly version: unknown) {
    super('unsupported consent version');
    this.name = 'UnsupportedConsentVersionError';
  }
}

export interface ConsentOptions {
  storage?: StorageAdapter;
}

/**
 * The stored record, or null when there has never been one.
 *
 * Separate from `getConsent` because the API needs to tell "declined" from
 * "never asked" — that difference is what decides whether the app shows the
 * consent card — while every enforcement path only needs the yes/no.
 */
export async function readConsent(
  kind: ConsentKindContract,
  uid: string,
  options: ConsentOptions = {},
): Promise<ConsentRecord | null> {
  requireUserId(uid);
  const storage = options.storage ?? getStorage();
  const user = await storage.get<ConsentBearingUser>(userDoc(uid));
  const record = user?.consents?.[kind.key];
  if (!record || typeof record.state !== 'string') return null;
  // A record written against a version this server no longer recognises is not
  // consent to what it asks today. It reads as declined until re-asked.
  if (!kind.isSupportedVersion(record.version)) return { ...record, state: 'declined' };
  return record;
}

/** Granted, or declined. There is no third answer and no default-on. */
export async function getConsent(
  kind: ConsentKindContract,
  uid: string,
  options: ConsentOptions = {},
): Promise<ConsentState> {
  const record = await readConsent(kind, uid, options);
  return record?.state === 'granted' ? 'granted' : 'declined';
}

export interface SetConsentInput {
  state: ConsentState;
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
export async function setConsent(
  kind: ConsentKindContract,
  uid: string,
  input: SetConsentInput,
  options: ConsentOptions = {},
): Promise<ConsentRecord> {
  requireUserId(uid);
  if (input.state !== 'granted' && input.state !== 'declined') {
    throw new Error('consent state must be granted or declined');
  }
  // Unknown versions are refused rather than silently upgraded: accepting one
  // would record agreement to words this server cannot show anyone.
  if (!kind.isSupportedVersion(input.version)) throw new UnsupportedConsentVersionError(input.version);

  const storage = options.storage ?? getStorage();
  const at = (input.at ?? new Date()).toISOString();
  const record: ConsentRecord = {
    state: input.state,
    version: input.version,
    changedAt: at,
    ...(input.locale ? { locale: input.locale } : {}),
    ...(input.platform ? { platform: input.platform } : {}),
  };

  await storage.runTransaction(async (tx) => {
    const current = await tx.get<ConsentBearingUser>(userDoc(uid));
    // Merged into the existing map, never replacing it: answering one question
    // must not erase the answer to the other.
    tx.merge<ConsentBearingUser>(userDoc(uid), {
      consents: { ...(current?.consents ?? {}), [kind.key]: record },
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
    reasonCode: `${kind.auditCode}_${input.state}`,
  }));

  return record;
}

export type ConsentView = ConsentRecord & { asked: boolean };

/** One question's view: the record, plus whether it has ever been answered. */
export async function consentViewFor(
  kind: ConsentKindContract,
  uid: string,
  options: ConsentOptions = {},
): Promise<ConsentView> {
  const record = await readConsent(kind, uid, options);
  return record
    ? { ...record, asked: true }
    // Never asked: declined, and the client needs to know it is allowed to ask
    // rather than treating this as a decision the user made.
    : { state: 'declined', version: kind.currentVersion, changedAt: '', asked: false };
}

/** What `GET /api/mobile/consents` answers with: every question, at once. */
export async function allConsentsView(uid: string, options: ConsentOptions = {}): Promise<{
  aiProcessing: ConsentView;
  recommendations: ConsentView;
  currentVersions: Record<ConsentKindContract['key'], string>;
}> {
  const [aiProcessing, recommendations] = await Promise.all(
    CONSENT_KINDS.map((kind) => consentViewFor(kind, uid, options)),
  );
  const currentVersions = {} as Record<ConsentKindContract['key'], string>;
  for (const kind of CONSENT_KINDS) currentVersions[kind.key] = kind.currentVersion;
  return { aiProcessing: aiProcessing!, recommendations: recommendations!, currentVersions };
}
