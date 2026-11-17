/**
 * Calendar consent, re-checked inside every write transaction (review 2 of
 * QA wave B8, CA10.5).
 *
 * A route reads consent when the request arrives and writes later. In between,
 * «افصل وامسح» can turn consent off and empty the account; a write that then
 * lands would put busy time back on an account whose copy says it is gone.
 * So the request takes a stamp -- consent on, and the account's consent epoch
 * (`users/{uid}.calendarEpoch`, moved by every consent change) -- and each
 * transaction that writes re-reads the user document and refuses unless
 * consent is still on, the account still live and the epoch unchanged. Reading
 * the user document puts it in the transaction's read set, so a consent change
 * committed meanwhile makes the write retry and then refuse. A disconnect and
 * a reconnect in between still refuse: the epoch moved twice.
 */
import { assertLiveAccount } from '../account/accountLiveness';
import type { StorageReader } from '../storage';
import type { StorageTransaction } from '../storage/storageAdapter';
import { userDoc } from '../storage/paths';

export class CalendarConsentChangedError extends Error {
  constructor() {
    super('calendar_consent_required');
    this.name = 'CalendarConsentChangedError';
  }
}

export interface CalendarConsentStamp {
  readonly epoch: number;
}

interface ConsentUser {
  readonly calendarEpoch?: number;
  readonly trust?: { readonly calendarConsent?: unknown; readonly revokedAt?: unknown; readonly deletedAt?: unknown };
}

function consented(user: ConsentUser | null): boolean {
  const trust = user?.trust;
  return trust?.calendarConsent === true && !trust.revokedAt && !trust.deletedAt;
}

/** The stamp a request writes under, or null when calendar consent is off now. */
export async function readCalendarConsentStamp(reader: StorageReader, uid: string): Promise<CalendarConsentStamp | null> {
  const user = await reader.get<ConsentUser>(userDoc(uid));
  return consented(user) ? { epoch: user?.calendarEpoch ?? 0 } : null;
}

/** Throws unless the account is live and consent is what the stamp saw. */
export async function assertCalendarConsentUnchanged(tx: StorageTransaction, uid: string, stamp: CalendarConsentStamp): Promise<void> {
  const user = await tx.get<ConsentUser>(userDoc(uid));
  assertLiveAccount(user);
  if (!consented(user) || (user?.calendarEpoch ?? 0) !== stamp.epoch) throw new CalendarConsentChangedError();
}

/** The same check as a `transactionGuard` for `replaceBusyBlocks`. */
export function calendarConsentGuard(uid: string, stamp: CalendarConsentStamp) {
  return (tx: StorageTransaction) => assertCalendarConsentUnchanged(tx, uid, stamp);
}
