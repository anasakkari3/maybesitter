import { z } from 'zod';

/**
 * The pieces more than one response is built from.
 *
 * Every schema in this directory mirrors a fixture in `../__fixtures__/`,
 * which the root test `tests/mobile/exportMobileApiFixtures.test.ts` writes by
 * invoking the real route handlers. The schemas are therefore checkable rather
 * than believed: `schemas.test.ts` parses every fixture, so a backend change
 * that alters a response fails the mobile suite instead of a user's screen.
 *
 * Objects are non-strict on purpose. A backend that *adds* a field must not
 * break a client that predates it; a backend that removes or renames one must.
 */

export const isoDateTime = z.string().refine(value => !Number.isNaN(Date.parse(value)), {
  message: 'expected an ISO-8601 instant',
});

/** `{ success: false, error, reason? }` — every refusal the routes emit. */
export const errorBodySchema = z.object({
  success: z.literal(false),
  error: z.string(),
  reason: z.string().optional(),
});

export type ApiErrorBody = z.infer<typeof errorBodySchema>;

export const prioritySchema = z.object({
  level: z.enum(['high', 'normal', 'low']),
  source: z.string(),
  pressureAllowed: z.boolean(),
  pressureLevel: z.string(),
});

/**
 * When a commitment happens.
 *
 * `endAt` and `allDay` are **required**, not optional, and that is the whole
 * value of them (UC-3.1, #185). The calendar mapper decides between a short
 * event, a start–end block and an all-day entry by reading them; if a backend
 * that stopped sending one could still parse here, the mapper would read the
 * absence as "no end, not all-day" and quietly write a thirty-minute block over
 * somebody's day off. `defaultTimeSpec` on the server fills both on every
 * commitment it stores, so requiring them is a claim the fixtures prove rather
 * than a hope.
 */
export const timeSpecSchema = z.object({
  kind: z.enum(['unscheduled', 'due_by', 'scheduled_event']),
  dueAt: isoDateTime.nullable(),
  /** `null` is "this names no end", which is not the same as a zero-length one. */
  endAt: isoDateTime.nullable(),
  remindAt: isoDateTime.nullable(),
  /** `dueAt` is a day's local midnight in `timezone`, and nobody chose the hour. */
  allDay: z.boolean(),
  timezone: z.string(),
});

/**
 * Which event in this phone's calendar a commitment was written to (UC-3.1, #185).
 *
 * `writerId` is the installation that owns the event. The app compares it
 * against its own and writes nothing when they differ — that is how a second
 * device signed into the same account does not produce a second event.
 */
export const deviceCalendarLinkSchema = z.object({
  writerId: z.string(),
  calendarId: z.string(),
  eventId: z.string(),
  contentHash: z.string(),
  state: z.enum(['linked', 'detached']),
  writtenAt: isoDateTime,
});

export type DeviceCalendarLink = z.infer<typeof deviceCalendarLinkSchema>;

/**
 * "Remind me when I arrive / leave" (closure CL4). Which way, the id of a place
 * saved on *some* phone, and the place's name. Never a coordinate: those stay
 * on the phone that saved the place (`src/lib/deviceSettings/placeReminders.ts`).
 */
export const locationTriggerSchema = z.object({
  kind: z.enum(['arrive', 'leave']),
  placeId: z.string(),
  label: z.string(),
});

export type LocationTrigger = z.infer<typeof locationTriggerSchema>;

export const commitmentSchema = z.object({
  id: z.string(),
  kind: z.enum(['task', 'follow_up']),
  title: z.string(),
  description: z.string().nullable(),
  person: z.string().nullable(),
  status: z.string(),
  priority: prioritySchema,
  /**
   * Which part of the user's life this belongs to, or `null` (#415).
   *
   * Not optional, unlike `rank` and `deviceCalendarLink`. Those distinguish "we
   * did not look" from "there is none", and the server has three answers to
   * give. Here it has two: every response that carries a commitment carries its
   * category, and `null` is the ordinary one. An optional field would let a
   * server that stopped sending categories read as a whole account that has
   * none, and the filter bar would empty itself rather than disappear.
   */
  category: z.enum(['work', 'family', 'health', 'finance', 'social', 'errands']).nullable(),
  /** Whether the user filed this themselves. The chip is drawn the same either way. */
  categorySource: z.enum(['inferred', 'user_explicit']),
  timeSpec: timeSpecSchema,
  currentAckState: z.string(),
  postponedUntil: isoDateTime.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  confirmedAt: isoDateTime.nullable(),
  completedAt: isoDateTime.nullable(),
  droppedAt: isoDateTime.nullable(),
  /**
   * Where this item sits in the day's order, and why (UC-2.8, #169).
   *
   * Both are **absent** when the priority module is off, which is not the same
   * as rank 0: absent means this build does not rank, and the client keeps the
   * time order the server sent. A default of 0 here would silently make every
   * item the top one.
   */
  rank: z.number().optional(),
  reasonCodes: z.array(z.enum([
    'overdue', 'due_within_2h', 'due_today',
    'user_must', 'user_low', 'estimated_important', 'no_deadline',
  ])).optional(),
  /**
   * The calendar event this commitment owns (UC-3.1, #185).
   *
   * Three states, and the difference between two of them is what stops a
   * duplicate: **absent** means this response did not look the link up — a 409
   * conflict body carries a commitment and no link — while **null** means it
   * looked and there is none. A client that read absent as null would take a
   * refusal as proof the event had been unlinked and write a second one. The
   * lists and the single reads always answer, so the sync pass has a complete
   * picture from the responses the screens already hold.
   */
  deviceCalendarLink: deviceCalendarLinkSchema.nullable().optional(),
  /** Absent when the commitment has no place reminder (closure CL4). */
  locationTrigger: locationTriggerSchema.optional(),
});

export type Commitment = z.infer<typeof commitmentSchema>;
export type RankReasonCode = NonNullable<Commitment['reasonCodes']>[number];
export type TimeSpec = z.infer<typeof timeSpecSchema>;

/**
 * One event whose commitment the account no longer holds (UC-3.1, #185).
 *
 * The phone cannot work this out for itself. A commitment that was cancelled
 * and a commitment that merely dropped off Today both look like an id that
 * stopped appearing, and guessing wrong in one direction leaves an event behind
 * for ever while guessing wrong in the other deletes an entry out of somebody's
 * calendar. So the server, which is the only party that can tell them apart,
 * says which is which.
 */
export const calendarOrphanSchema = z.object({
  commitmentId: z.string(),
  link: deviceCalendarLinkSchema,
});

export type CalendarOrphan = z.infer<typeof calendarOrphanSchema>;

export const commitmentListSchema = z.object({
  items: z.array(commitmentSchema),
  /**
   * Optional because only Today computes it. Absent is "this response did not
   * look", `[]` is "it looked and there are none" — and the sync deletes what
   * appears here, so the two must not collapse into one.
   */
  calendarOrphans: z.array(calendarOrphanSchema).optional(),
});

export type CommitmentList = z.infer<typeof commitmentListSchema>;

/**
 * The design's three importance levels, from the server's priority levels.
 * `high → Must`, `normal → Should`, `low → Nice`.
 */
export function importanceOf(commitment: Commitment): 'must' | 'should' | 'nice' {
  return commitment.priority.level === 'high' ? 'must' : commitment.priority.level === 'low' ? 'nice' : 'should';
}

/**
 * The vocabulary a proposed fact is written in.
 *
 * Here rather than in `profile.ts` because two schema files need it — the
 * self-description and the AI context import — and having the second import the
 * first produced a load-time cycle: `profile.ts` needs the import's receipt for
 * its own response, so the arrow has to point one way and this is the only
 * place both ends can reach.
 */
export const suggestionKindSchema = z.enum(['fact', 'preference', 'goal']);

export const suggestionCategorySchema = z.enum([
  'work_study', 'schedule', 'household', 'social',
  'fitness_habit', 'learning', 'personal_project', 'other',
]);

/** One thing a model proposed. Nothing is stored until the user keeps it. */
export const suggestionSchema = z.object({
  kind: suggestionKindSchema,
  category: suggestionCategorySchema,
  content: z.string(),
  targetDate: z.string().nullable(),
  confidence: z.number(),
});
