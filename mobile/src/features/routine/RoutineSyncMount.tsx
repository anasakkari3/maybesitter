import { useRoutineSync } from './useRoutineSync';

/**
 * Where the routine sync actually lives (UC-2.7a, #167 step 5).
 *
 * It used to live only on `RoutineSettingsScreen`, which meant the retry the
 * hook exists for could not happen unless the user went looking for it: a
 * survey answered on a plane during onboarding stayed unsent until somebody
 * opened Settings → Routine. Mounting it here runs it for the whole session
 * instead, and a reconnection is heard wherever the user happens to be.
 *
 * It renders nothing, and it is mounted **inside** the signed-in, onboarded
 * tree on purpose: these answers belong to an account (#148), so a copy that
 * could sync without one is the bug that made four accounts share a survey.
 *
 * The settings screen keeps its own call — it needs the answers to render. Two
 * instances can each push once, which is harmless: the route takes the whole
 * profile and re-sending the same state is idempotent. That is the same
 * property that lets this be one bit instead of a queue.
 */
export function RoutineSyncMount(): null {
  useRoutineSync();
  return null;
}
