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

export const timeSpecSchema = z.object({
  kind: z.enum(['unscheduled', 'due_by', 'scheduled_event']),
  dueAt: isoDateTime.nullable(),
  remindAt: isoDateTime.nullable(),
  timezone: z.string(),
});

export const commitmentSchema = z.object({
  id: z.string(),
  kind: z.enum(['task', 'follow_up']),
  title: z.string(),
  description: z.string().nullable(),
  person: z.string().nullable(),
  status: z.string(),
  priority: prioritySchema,
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
});

export type Commitment = z.infer<typeof commitmentSchema>;
export type RankReasonCode = NonNullable<Commitment['reasonCodes']>[number];
export type TimeSpec = z.infer<typeof timeSpecSchema>;

export const commitmentListSchema = z.object({
  items: z.array(commitmentSchema),
});

/**
 * The design's three importance levels, from the server's priority levels.
 * `high → Must`, `normal → Should`, `low → Nice`.
 */
export function importanceOf(commitment: Commitment): 'must' | 'should' | 'nice' {
  return commitment.priority.level === 'high' ? 'must' : commitment.priority.level === 'low' ? 'nice' : 'should';
}
