/**
 * The native half of the exact-alarm check (UC-3.12a, #197), or null.
 *
 * `requireOptionalNativeModule` rather than `requireNativeModule`: a build
 * without this module — Expo Go, a unit test, an old dev client — must still
 * start. What it means for the answer to be missing is decided one level up,
 * in `src/notifications/exactAlarms.ts`, not here.
 */
import { requireOptionalNativeModule } from 'expo';

export interface ExactAlarmNativeModule {
  canScheduleExactAlarms(): boolean;
  openExactAlarmSettings(): boolean;
}

export function exactAlarmNativeModule(): ExactAlarmNativeModule | null {
  return requireOptionalNativeModule<ExactAlarmNativeModule>('ExactAlarm');
}
