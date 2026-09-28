import type { CommitmentCategory } from '../contracts/v1/categoryContracts';

export type ExtractionType = 'task' | 'follow_up' | 'informational_context' | 'unknown';

export type MissingField = 'action' | 'time' | 'person' | 'commitment_strength';

export type AmbiguityFlag =
  | 'multiple_commitments'
  | 'vague_time'
  | 'vague_action'
  | 'weak_commitment_language'
  | 'informational_without_action'
  | 'contradictory_time'
  | 'negated_request'
  /**
   * The text names no action. The prompt has asked the model for this flag
   * since UC-2.0, but the validator's allow-list did not carry it, so every
   * occurrence was silently dropped on the way in (UC-2.2, #162).
   */
  | 'no_action_verb';

/**
 * A time as the user's own clock shows it.
 *
 * The model is asked for this alongside `dueAt`, and it is the half that is
 * trusted: a wall-clock date and time plus a zone name cannot be wrong about
 * its own offset, whereas a UTC instant the model computed itself can be — and
 * was, by whole hours. `reconcileLocalTimeSpec` recomputes the instant from
 * this and overrules the model's arithmetic (UC-2.2, #162).
 */
export interface LocalTimeSpec {
  /** `YYYY-MM-DD`, on the user's clock. */
  date: string;
  /**
   * `HH:MM`, 24-hour, on the user's clock — or null when the text named a day
   * but no hour.
   *
   * Nullable because "next Sunday" and "Sunday at 4" are genuinely different
   * states, and collapsing them is what forced the old code to invent 18:00.
   * A null here is what lets the clarification step ask "what time on Sunday?"
   * (#165) instead of having to ask which day as well — the day survives even
   * though `dueAt` and `remindAt` cannot, because an instant needs an hour and
   * this does not.
   */
  time: string | null;
  /** IANA zone name, as the device reported it. */
  timezone: string;
}

/** Why a resolved time was believed. See `src/extraction/timeLexicon.ts`. */
export type TimeEvidence = 'none' | 'day_only' | 'clock_marker' | 'daypart' | 'ampm' | 'hhmm';

export interface ExtractionResult {
  type: ExtractionType;
  action: string | null;
  title: string | null;
  person: string | null;
  dueAt: string | null;
  remindAt: string | null;
  localTimeSpec: LocalTimeSpec | null;
  /**
   * What in the text justified the resolved time.
   *
   * `none` and `day_only` must always arrive with a null time: those are the
   * two cases where any time would be the product's invention rather than the
   * user's intent. `clock_marker` is a time the user named without saying which
   * half of the day they meant — kept, but soft.
   */
  timeEvidence: TimeEvidence;
  /**
   * True when the day in `localTimeSpec` came from a weekday name alone —
   * "Sunday", «الأحد الجاي» — so it is the product's guess at *which* Sunday
   * (`src/extraction/weekdayLexicon.ts`). Carried to the review card the way
   * `priority.source` is, so a guessed day is shown as one.
   *
   * Optional: absent means no guess was recorded, which every producer that
   * predates it meant.
   */
  dateInferred?: boolean;
  priority: {
    level: 'low' | 'normal' | 'high';
    source: 'default' | 'inferred' | 'user_explicit';
    pressureAllowed: boolean;
    pressureImplied: boolean;
  };
  flexibility: 'movable' | 'soft';
  /**
   * Which part of the user's life this belongs to, as the model read it (#415).
   *
   * Raw: a name from the catalog, or `null`. Whether it is good enough to keep
   * is not decided here — `resolveCategory` weighs it against the confidence
   * floor and the categories this user actually uses. Two layers applying the
   * same floor is two places to get it wrong.
   */
  category: CommitmentCategory | null;
  /** How sure the model was, clamped to [0, 1]. Always 0 when `category` is null. */
  categoryConfidence: number;
  confidence: {
    overall: number;
    type: number;
    action: number;
    time: number;
    priority: number;
  };
  missingFields: MissingField[];
  ambiguityFlags: AmbiguityFlag[];
  explicitReminderRequest: boolean;
  explicitPressureRequest: boolean;
  rawText: string;
  parserVersion: string;
}

export interface ExtractionContext {
  now: Date;
  timezone?: string;
  defaultReminderHour?: number;
  /**
   * The categories this user kept, for the prompt to offer (#415).
   *
   * Absent means the whole catalog — a caller that has not plumbed the
   * preference through still gets a model that categorises. An empty array is
   * a different answer: a user who turned every category off, who is told not
   * to categorise at all.
   */
  categories?: readonly CommitmentCategory[];
}

export type ExtractionDisposition = 'auto_confirm' | 'pending_confirmation' | 'needs_clarification' | 'store_note';
