/**
 * Whether this account gets a next step, at this moment (UC-2.9, #170).
 *
 * ── Why this is not in `lib/recommendation/` ─────────────────────
 *
 * #170 names `lib/recommendation/launchAccess.ts`. That directory is the
 * locked Sprint 08 selector, and its own boundary tests forbid anything in it
 * from reaching a writer, a route handler or the shipped next-step pilot —
 * which is exactly what an access gate must do. The guard is right and the
 * issue predates it, so the file lives beside the service that calls it.
 *
 * ── Not the closed pilot's gate ──────────────────────────────────
 *
 * `decidePilotExposure` reads `PilotTrustState.recommendationConsent`, which is
 * the *closed pilot's* admission control. This reads
 * `users/{uid}.consents.recommendations` — the launch consent, asked of
 * everybody in onboarding and versioned against the words they were shown
 * (#171). The two are deliberately separate, and reading one where the other
 * was meant is the mistake this file exists to make impossible: the pilot flag
 * defaults to `false` for everyone, so using it at launch would hide the
 * feature from every user who ever consented.
 *
 * ── Quiet hours are not a refusal ────────────────────────────────
 *
 * Every other reason here means "you may not have this". Quiet hours means
 * "not right now", and the difference matters at the call site: a 403 at 23:00
 * makes the client render an error on a screen where nothing is wrong. So
 * `quiet_hours` is its own reason and the route answers 200 with no card.
 *
 * ── Missing means declined, everywhere ───────────────────────────
 *
 * A fresh account has never been asked, so it has not agreed, so there is no
 * card. Same rule as every other consent in this product, and the same reason:
 * the failure mode of getting it backwards is doing something to somebody they
 * did not ask for.
 */
import { getRecommendationConsent } from '../../consents/recommendationConsentService';
import { readRoutineProfile } from './routineProfileService';
import { getOrCreateTrust } from '../../pilot/pilotTrustStore';
import { readRuntimeControls } from '../../../src/contracts/v1/runtimeControls';
import { requireUserId, type StorageAdapter } from '../../storage';
import type { RoutineTimeWindow } from '../../../src/contracts/v1/routineContracts';

export type NextStepAccessReason =
  | 'authorized'
  | 'deleted'
  | 'revoked'
  | 'kill_switch_active'
  | 'feature_disabled'
  | 'quiet_mode'
  | 'consent_required'
  /** Inside the user's own quiet window. Not a refusal — see the header. */
  | 'quiet_hours';

export interface NextStepAccess {
  allowed: boolean;
  reason: NextStepAccessReason;
}

export interface NextStepAccessOptions {
  storage?: StorageAdapter;
}

/**
 * True when `at` falls inside a wall-clock window in `timeZone`.
 *
 * Windows wrap midnight, which is the normal case here — quiet hours are
 * 22:30–07:30, not 07:30–22:30 — so a window whose end is not after its start
 * is read as spanning the night rather than as empty. Getting that backwards
 * would suppress the card all day and show it all night, which is exactly
 * inverted.
 */
export function isWithinWindow(window: RoutineTimeWindow, at: Date, timeZone: string): boolean {
  const minutes = minutesOfDay(at, timeZone);
  const start = toMinutes(window.start);
  const end = toMinutes(window.end);
  if (start === null || end === null) return false;
  return start <= end
    ? minutes >= start && minutes < end
    : minutes >= start || minutes < end;
}

function toMinutes(value: string): number | null {
  const match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/**
 * The wall-clock minute-of-day in a zone.
 *
 * Through `Intl` with an explicit `timeZone`, because the server runs in UTC
 * and the user's 23:00 is not the server's.
 */
function minutesOfDay(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(at);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
  // `en-GB` renders midnight as 24 in some engines.
  return (hour % 24) * 60 + minute;
}

export async function resolveNextStepAccess(
  uid: string,
  at: Date,
  options: NextStepAccessOptions = {},
): Promise<NextStepAccess> {
  requireUserId(uid);

  const trust = await getOrCreateTrust(uid, at.toISOString());
  // Deleted and revoked come first: they are the two states where the user has
  // told us to stop, and no flag should be able to speak over that.
  if (trust.deletedAt) return { allowed: false, reason: 'deleted' };
  if (trust.revokedAt) return { allowed: false, reason: 'revoked' };

  const controls = readRuntimeControls();
  if (controls.killSwitches.recommendation) return { allowed: false, reason: 'kill_switch_active' };
  if (!controls.featureFlags.recommendation) return { allowed: false, reason: 'feature_disabled' };

  // The user's own switch, from the trust record — an explicit "not now, for a
  // while", and stronger than any schedule.
  if (trust.quietMode) return { allowed: false, reason: 'quiet_mode' };

  const consent = await getRecommendationConsent(uid, options);
  if (consent !== 'granted') return { allowed: false, reason: 'consent_required' };

  const profile = await readRoutineProfile(uid, options);
  if (profile?.quietHours && isWithinWindow(profile.quietHours, at, profile.timezone)) {
    return { allowed: false, reason: 'quiet_hours' };
  }

  return { allowed: true, reason: 'authorized' };
}

/**
 * Whether a refusal should read as an error to the client.
 *
 * `quiet_hours` is the only one that should not: nothing is wrong, the user
 * simply asked not to be spoken to right now. The route answers 200 with no
 * card, and the screen shows nothing rather than a message about a problem.
 */
export function isSilentRefusal(reason: NextStepAccessReason): boolean {
  return reason === 'quiet_hours' || reason === 'quiet_mode';
}
