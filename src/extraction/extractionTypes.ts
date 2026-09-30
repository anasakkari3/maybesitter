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

/** See `ExtractionResult.recurrenceHint`. 0 = Sunday … 6 = Saturday; `HH:MM` on the person's clock. */
export interface RecurrenceHint {
  weekdays: number[];
  start?: string;
  end?: string;
}

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
  /**
   * What the stated time is to the person (CL1, D2; `timeAnchorOf` in
   * `timeLexicon.ts`): `event` — a clock time to do it at («الساعة 5», "at
   * 5pm"), which becomes a `scheduled_event` the planner keeps where it is;
   * `deadline` — a limit ("by", «قبل», «עד»), which stays a `due_by`.
   *
   * Optional: absent or null means a deadline, which is what every producer
   * that predates it wrote.
   */
  timeAnchor?: 'event' | 'deadline' | null;
  /**
   * The commitment names a day and nobody chose the hour (FX3): «قبل آخر
   * الشهر» is due by the month's last day. `dueAt` is that day's local
   * midnight, `remindAt` is null and `localTimeSpec.time` is null — the same
   * shape `TimeSpec.allDay` stores. Optional: absent means a timed reading or
   * none, which every producer that predates it meant.
   */
  allDay?: boolean;
  /**
   * An hour the words said with no day to put it on (FIX-R8-CAPTURE), `HH:MM`
   * as read — «كل أسبوع الساعة 10», or the second conjunct of «…الاول يوم
   * الجمعة عال ٤ والثاني الحنعة عال٦» whose day word was not a day. Set only
   * when `localTimeSpec`, `dueAt` and `remindAt` are all null: the day is
   * asked (`ask_day`), never today, and the hour is kept for the answer.
   */
  undatedTime?: string;
  /**
   * How long the event lasts, in minutes, when the words gave a range — «من
   * 10 لـ 4», "10 to 4", «מ-10 עד 4» (FIX-R8-CAPTURE). Counted from the start,
   * so an answered صبح/مسا or an edited start moves the end with it;
   * `mapExtractionToCommand` writes it as the command's `endAt`.
   */
  rangeMinutes?: number;
  /**
   * The words said this repeats weekly (FIX-R8-CAPTURE). Content-free: day
   * numbers and clock times only. Nothing stores a weekly block yet, so the
   * item is a one-off on the next occurrence; this is what the recurring-block
   * lane turns into a weekly proposal. `start`/`end` only when the hour is
   * settled (not a صبح/مسا still to ask).
   */
  recurrenceHint?: RecurrenceHint | null;
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
  /**
   * The title in the app's language, as the model wrote it (owner request
   * 2026-09-30). Only when the context asked for one (`titleLanguage`), and
   * never read by anything that checks a title against the person's words:
   * `title` stays in their words through every validator, and the capture
   * boundary puts this in its place only when the proposal item is built.
   */
  appTitle?: string;
  /**
   * The person's own-words title, kept once `title` holds the app-language one
   * (set by the capture boundary, stored with the proposal). What the chat
   * matches a clause to an item by; never shown.
   */
  sourceTitle?: string;
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
  /**
   * The app's UI language (owner request 2026-09-30). Present, the model is
   * asked for `appTitle` — the title in this language — beside `title` in the
   * person's own words. Absent, the prompt is the one before the field existed.
   */
  titleLanguage?: 'ar' | 'en' | 'he';
}

export type ExtractionDisposition = 'auto_confirm' | 'pending_confirmation' | 'needs_clarification' | 'store_note';
