/**
 * The routine fact keys, mirrored on the client (UC-2.7a, #167).
 *
 * The server owns this list (`lib/memory/routineFacts.ts`) and the fixtures
 * generated from the real routes are what keep the two honest — a key added
 * there without being added here shows up as an unrendered fact in
 * `memoryDisplay`'s fallback rather than as a crash.
 */
export const ROUTINE_FACT_KEYS = [
  'sleep_window',
  'focus_window',
  'fixed_commitments',
  'reminder_intensity',
  'quiet_hours',
] as const;

export type RoutineFactKey = (typeof ROUTINE_FACT_KEYS)[number];

export function routineFactKeyOf(content: string): RoutineFactKey | null {
  const separator = content.indexOf(':');
  if (separator < 1) return null;
  const key = content.slice(0, separator);
  return (ROUTINE_FACT_KEYS as readonly string[]).includes(key) ? key as RoutineFactKey : null;
}
