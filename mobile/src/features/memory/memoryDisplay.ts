/**
 * Turning a stored fact into a sentence (UC-2.7a, #167).
 *
 * ── Why the store holds machine text ─────────────────────────────
 *
 * A routine fact is stored as `quiet_hours:22:30-07:30`, never as a sentence.
 * The phone renders the words, so one stored fact reads correctly in Arabic,
 * Hebrew and English, and rewording it is a client change rather than a data
 * migration. This module is that rendering, and it is the only place that
 * knows the grammar.
 *
 * ── Anything unrecognised is shown as it is ──────────────────────
 *
 * A fact this build cannot parse — written by a newer version, or typed by the
 * user — is displayed verbatim rather than hidden. The screen's promise is
 * "everything it remembers about you"; silently dropping a row would make that
 * false in the one direction nobody can check.
 */
import { routineFactKeyOf, type RoutineFactKey } from './routineFactKeys';

export interface MemoryDisplayInput {
  content: string;
  /** `fill`-style templates, already localised. */
  strings: Record<string, string>;
}

const INTENSITY_KEY: Record<string, string> = {
  none: 'memoryIntensityNone',
  softAwareness: 'memoryIntensitySoft',
  followUp: 'memoryIntensityFollowUp',
  strongReminder: 'memoryIntensityStrong',
};

const WINDOW_TEMPLATE: Record<Exclude<RoutineFactKey, 'reminder_intensity'>, string> = {
  sleep_window: 'memorySleepWindow',
  focus_window: 'memoryFocusWindow',
  fixed_commitments: 'memoryFixedWindow',
  quiet_hours: 'memoryQuietWindow',
};

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
}

/** The sentence to show for a stored fact. Never empty. */
export function memorySentence({ content, strings }: MemoryDisplayInput): string {
  const key = routineFactKeyOf(content);
  if (key === null) return content;
  const value = content.slice(content.indexOf(':') + 1);

  if (key === 'reminder_intensity') {
    const level = strings[INTENSITY_KEY[value] ?? ''] ?? value;
    return fill(strings.memoryReminderIntensity ?? '{level}', { level });
  }

  const [from, to] = value.split('-');
  if (!from || !to) return content;
  return fill(strings[WINDOW_TEMPLATE[key]] ?? '{from}–{to}', { from, to });
}

export type ProvenanceChip = 'you' | 'survey' | 'ai' | 'capture' | 'noticed' | null;

/**
 * Which chip to show, from the record's own fields.
 *
 * `origin` says which path a fact arrived by and `source` says what kind of
 * thing asserted it. The chip the user reads is about *trust*, so the AI chip
 * is only ever shown for something a model actually produced — an onboarding
 * answer stays "From onboarding" even after the user edits it, because that is
 * still where it came from.
 */
export function provenanceChip(
  provenance: { origin: string } | null | undefined,
  source: string,
): ProvenanceChip {
  if (source === 'model_inferred') return 'ai';
  switch (provenance?.origin) {
    case 'routine_survey': return 'survey';
    case 'self_description': return 'you';
    case 'manual': return 'you';
    case 'capture': return 'capture';
    // A suggestion the user kept (#202). Once they rewrite it, it is theirs.
    case 'behaviour_rule': return source === 'deterministic_rule' ? 'noticed' : 'you';
    // A record written before #167 has no provenance. No chip is better than a
    // guessed one: the chip is the reason to trust the row.
    default: return null;
  }
}

export const CHIP_STRING: Record<Exclude<ProvenanceChip, null>, string> = {
  you: 'memoryFromYou',
  survey: 'memoryFromSurvey',
  ai: 'memoryFromAi',
  capture: 'memoryFromCapture',
  noticed: 'memorySourceNoticed',
};
