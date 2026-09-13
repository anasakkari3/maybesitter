/**
 * The routine survey, as memory facts (UC-2.7a, #167).
 *
 * ── Why the survey is stored twice ───────────────────────────────
 *
 * The profile (`users/{uid}.profile.routine`) is the answer sheet: it is what
 * the survey screen re-opens and what the planner reads windows out of. The
 * facts are the same answers in the one vocabulary the memory screen, ranking
 * and the next step all already speak, so "what MaybeSitter knows about me"
 * can show a routine answer next to a self-described goal without a second
 * rendering path for each.
 *
 * Derivation runs one way only. The profile is the source; a fact is never
 * edited back into it. That is why `routineProfileToFacts` is a pure function
 * of the profile with no clock and no store: given the same profile it
 * produces the same facts, so re-saving an unchanged survey supersedes each
 * fact with an identical one rather than inventing drift.
 *
 * ── Machine strings, not sentences ───────────────────────────────
 *
 * `content` is `quiet_hours:22:30-07:30`, never «ساعات الهدوء من ١٠:٣٠». The
 * phone renders the display text from its own strings, so the same stored fact
 * reads correctly in Arabic, Hebrew and English, and changing the wording is a
 * client change rather than a data migration. It also keeps the store free of
 * prose nobody validated.
 *
 * ── A skipped survey has no facts ────────────────────────────────
 *
 * Skipping is an answer about the survey, not about the user's routine. It is
 * recorded on the profile (`surveySkipped`) and produces nothing here: a fact
 * saying "declined to say" would be a fact about the user that the user never
 * stated, and it would show up on the memory screen as though it were one.
 */
import {
  ROUTINE_SURVEY_VERSION,
  type RoutineTimeWindow,
  type UserRoutineProfile,
} from '../../src/contracts/v1/routineContracts';
import {
  USER_STATED_MEMORY_TTL_MS,
  type CreateMemoryInput,
  type MemoryLanguage,
} from '../../src/contracts/v1/memoryContracts';

/**
 * The stable key each routine answer is filed under.
 *
 * Superseding matches on this prefix, so renaming one is a data migration and
 * not a rename. They are also what UC-2.9 (#170) matches on when it looks for
 * a focus window in memory rather than re-reading the profile.
 */
export const ROUTINE_FACT_KEYS = [
  'sleep_window',
  'focus_window',
  'fixed_commitments',
  'reminder_intensity',
  'quiet_hours',
] as const;

export type RoutineFactKey = (typeof ROUTINE_FACT_KEYS)[number];

/** `sleep_window:22:30-06:30` — the whole grammar, in one place. */
export function routineFactContent(key: RoutineFactKey, value: string): string {
  return `${key}:${value}`;
}

/** The key a stored fact belongs to, or null when it is not a routine fact. */
export function routineFactKeyOf(content: string): RoutineFactKey | null {
  const separator = content.indexOf(':');
  if (separator < 1) return null;
  const key = content.slice(0, separator);
  return (ROUTINE_FACT_KEYS as readonly string[]).includes(key) ? key as RoutineFactKey : null;
}

function windowValue(window: RoutineTimeWindow): string {
  return `${window.start}-${window.end}`;
}

export interface RoutineFactsOptions {
  /**
   * The language the answers were given in. The content is machine text either
   * way, so this records the survey's locale rather than the string's script;
   * `mixed` is the honest default when the caller does not know.
   */
  readonly language?: MemoryLanguage;
  /** When the user answered. Defaults to the profile's own `updatedAt`. */
  readonly observedAt?: string;
}

/**
 * One fact per answered question, in a fixed order.
 *
 * `confidence: 1` and `source: 'user_stated'` are not a default here — they are
 * the point. The user picked these answers themselves; nothing is estimated,
 * so nothing downstream may treat a routine answer as a guess it can outrank.
 */
export function routineProfileToFacts(
  profile: UserRoutineProfile,
  scopeId: string,
  options: RoutineFactsOptions = {},
): CreateMemoryInput[] {
  if (profile.surveySkipped) return [];

  const observedAt = options.observedAt ?? profile.updatedAt;
  const language = options.language ?? 'mixed';
  const base = {
    scopeId,
    kind: 'preference' as const,
    language,
    source: 'user_stated' as const,
    confidence: 1,
    observedAt,
    // The user picked this themselves; it does not go stale on a timer.
    ttlMs: USER_STATED_MEMORY_TTL_MS,
    provenance: {
      origin: 'routine_survey' as const,
      originRef: ROUTINE_SURVEY_VERSION,
    },
  };

  const facts: CreateMemoryInput[] = [];
  const add = (key: RoutineFactKey, value: string) => {
    facts.push(Object.freeze({ ...base, content: routineFactContent(key, value) }));
  };

  if (profile.sleepWindow) add('sleep_window', windowValue(profile.sleepWindow));
  // Every focus window becomes its own fact rather than one joined string, so
  // deleting "afternoons" does not require rewriting "mornings".
  for (const window of profile.focusWindows) add('focus_window', windowValue(window));
  for (const window of profile.fixedCommitmentWindows) add('fixed_commitments', windowValue(window));
  add('reminder_intensity', profile.preferredReminderIntensity);
  if (profile.quietHours) add('quiet_hours', windowValue(profile.quietHours));

  return facts;
}
