/**
 * Will a Must reminder fire on time on this phone (UC-3.12a, #197)?
 *
 * ── Why the answer matters, and what does not depend on it ───────
 *
 * The Must stage is scheduled whatever this says. On Android, with "Alarms &
 * reminders" revoked, expo-notifications falls back to an inexact alarm that
 * the OS may deliver some minutes late — later is better than never, and the
 * user can still grant it. What this answer changes is two things only: the
 * calm note on the settings screen, and `exact` on the receipt, which is what
 * tells the server's backup push (#198) whether the phone can be trusted to
 * ring on time.
 *
 * ── An unknown answer is "no" ────────────────────────────────────
 *
 * If the native module is missing or throws, this reports `false`. The receipt
 * then says `exact: false`, and the server sends its backup a few minutes after
 * the reminder was due. That can mean a second notification; the other answer
 * can mean none at all, for a commitment the user said matters. #198 makes the
 * same trade in the same direction.
 *
 * iOS has no such permission: a calendar trigger fires at its date. It is
 * `true` there without asking anything native.
 */
import { Platform } from 'react-native';
import { exactAlarmNativeModule, type ExactAlarmNativeModule } from '../../modules/exact-alarm';

export interface ExactAlarmDeps {
  readonly platform?: typeof Platform.OS;
  readonly native?: ExactAlarmNativeModule | null;
}

function nativeOf(deps: ExactAlarmDeps): ExactAlarmNativeModule | null {
  if (deps.native !== undefined) return deps.native;
  try {
    return exactAlarmNativeModule();
  } catch {
    return null;
  }
}

export function canScheduleExactAlarms(deps: ExactAlarmDeps = {}): boolean {
  const platform = deps.platform ?? Platform.OS;
  if (platform === 'ios') return true;
  if (platform !== 'android') return false;
  const native = nativeOf(deps);
  if (!native) return false;
  try {
    return native.canScheduleExactAlarms() === true;
  } catch {
    return false;
  }
}

/**
 * Opens Android's "Alarms & reminders" page for this app. Returns whether a
 * page was opened; false on iOS, where there is nothing to open, and on an
 * Android below 12, where the permission cannot be revoked in the first place.
 */
export function openExactAlarmSettings(deps: ExactAlarmDeps = {}): boolean {
  const platform = deps.platform ?? Platform.OS;
  if (platform !== 'android') return false;
  const native = nativeOf(deps);
  if (!native) return false;
  try {
    return native.openExactAlarmSettings() === true;
  } catch {
    return false;
  }
}
