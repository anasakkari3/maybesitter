/**
 * Whether this account may be interrupted at all (UC-3.0b, #184).
 *
 * ── Why this exists, and why it is not optional ──────────────────
 *
 * `sendToUser` read the device's OS permission and the user's quiet hours and
 * called that the answer to "may we interrupt this person". It was a weaker
 * answer than the rest of the product gives. `resolveNextStepAccess` refuses a
 * next-step card outright for a deleted account, a revoked one and one in quiet
 * mode; push refused for none of them. So a user who revoked consent still got
 * pushed to — and `requireMobileUser` answers **403** for a revoked account, so
 * that same user could not call `DELETE /api/mobile/devices/{installationId}`
 * to stop it themselves. The one state where somebody has told us to stop was
 * the one state they could not act on.
 *
 * The gate belongs here rather than in each caller. UC-3.10a (#194) and
 * UC-3.12b (#198) are both still unwritten; a rule that each of them has to
 * remember is a rule one of them will not.
 *
 * ── What is deliberately *not* here ──────────────────────────────
 *
 * `resolveNextStepAccess` also refuses on the recommendation kill switch, the
 * recommendation feature flag and `users/{uid}.consents.recommendations`. None
 * of those belongs on this path, and copying them across "for consistency"
 * would be the more damaging mistake:
 *
 *  - the **recommendation consent** is about suggestions this product makes.
 *    A reminder for a commitment the user typed in themselves is not a
 *    suggestion, and gating it would mean somebody who declined recommendations
 *    silently stops being reminded of their own appointments.
 *  - the **kill switch and feature flag** are an operator's decision about the
 *    recommendation feature. Throwing it to stop a bad selector would also
 *    stop every Must reminder, which is a different blast radius than the
 *    operator asked for.
 *
 * What is shared is exactly the set that means "this person has told us to
 * stop, or to stop for now": `deletedAt`, `revokedAt`, `quietMode`.
 *
 * ── Read through the caller's storage, and never created ─────────
 *
 * The trust record lives on `users/{uid}.trust` — the same document
 * `readQuietHours` already reads for a timezone — so this takes the adapter it
 * was handed rather than reaching `getStorage()` the way `pilotTrustStore`
 * does. `getOrCreateTrust` would also *write* a record as a side effect of
 * sending a notification, which is the wrong thing for a read to do at all.
 */
import { getStorage, requireUserId, userDoc, type StorageAdapter } from '../storage';

export type PushAccessReason =
  | 'authorized'
  /** The account is gone. */
  | 'deleted'
  /** The user withdrew consent. They cannot delete their own device row either. */
  | 'revoked'
  /** The user's own "not now, for a while" — stronger than any schedule. */
  | 'quiet_mode'
  /** Something is stored under `trust` that this version cannot read. See below. */
  | 'unreadable';

export interface PushAccess {
  readonly allowed: boolean;
  readonly reason: PushAccessReason;
}

const ALLOWED: PushAccess = Object.freeze({ allowed: true, reason: 'authorized' as const });

function refuse(reason: PushAccessReason): PushAccess {
  return Object.freeze({ allowed: false, reason });
}

/**
 * Reads the three fields, structurally, without the full validator.
 *
 * `requirePilotTrustState` would refuse a record written by a future schema
 * outright, and "we added a field in v2" is not a reason to stop reminding
 * everybody. So each field is read on its own and a record that merely grew is
 * still read.
 *
 * A record that is *there but wrong* is refused, and that direction is
 * deliberate: something wrote it, it may be the one that says stop, and a
 * guard whose whole job is "may we interrupt this person" must answer no when
 * it cannot tell. An absent record is a different thing — nobody has ever
 * touched a trust control — and is allowed, because reading that as a refusal
 * would silence every push for every account and show nobody an error.
 */
export function pushAccessOf(trust: unknown): PushAccess {
  if (trust === undefined || trust === null) return ALLOWED;
  if (typeof trust !== 'object' || Array.isArray(trust)) return refuse('unreadable');
  const raw = trust as Record<string, unknown>;

  for (const field of ['deletedAt', 'revokedAt'] as const) {
    const value = raw[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') return refuse('unreadable');
    if (value !== '') return refuse(field === 'deletedAt' ? 'deleted' : 'revoked');
  }

  const quietMode = raw.quietMode;
  if (quietMode !== undefined && typeof quietMode !== 'boolean') return refuse('unreadable');
  if (quietMode === true) return refuse('quiet_mode');

  return ALLOWED;
}

export interface ReadPushAccessOptions {
  storage?: StorageAdapter;
}

interface TrustBearingUser {
  trust?: unknown;
}

/** This account's answer, from the one document the trust record lives on. */
export async function readPushAccess(
  uid: string,
  options: ReadPushAccessOptions = {},
): Promise<PushAccess> {
  requireUserId(uid);
  const storage = options.storage ?? getStorage();
  const user = await storage.get<TrustBearingUser>(userDoc(uid));
  return pushAccessOf(user?.trust);
}
