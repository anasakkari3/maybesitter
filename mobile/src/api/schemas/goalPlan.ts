import { z } from 'zod';
import { isoDateTime } from './common';

/**
 * The one plan path (M3a): summary → ordered plan → real times → one confirm.
 *
 * The shapes are `evidence/claudex-20261006/M3/WIRE-M3a.md`, which both
 * acceptance gates were written against, and the fixtures the route exporter
 * writes from the real handlers. Objects pass unknown keys through: the server
 * may add a field before the app reads it, and a response is never refused for
 * carrying more than the screen needs.
 */

const phaseSchema = z.object({ unit: z.enum(['day', 'week']), index: z.number().int().positive() });
const rhythmSchema = z.object({
  timesPerWeek: z.number().int().positive(),
  timeOfDay: z.enum(['morning', 'afternoon', 'evening']).optional(),
});

export const goalPlanStepSchema = z.object({
  stepId: z.string(),
  order: z.number().int().positive(),
  phase: phaseSchema,
  title: z.string(),
  kind: z.enum(['commitment', 'habit']),
  durationMinutes: z.number().int().positive(),
  rhythm: rhythmSchema.optional(),
  // Null when nothing may be claimed: the first step, a step whose predecessor
  // moved, a step the person added (M3A-007). The screen then shows no line.
  buildsOn: z.string().nullable(),
  expectedOutcome: z.string().nullable(),
  origin: z.enum(['model', 'template', 'person']).optional(),
}).passthrough().refine(step => step.kind !== 'habit' || step.rhythm !== undefined, { message: 'a habit step carries its rhythm', path: ['rhythm'] });

export const goalPlanSchema = z.object({
  planId: z.string(),
  goalId: z.string(),
  revision: z.number().int().nonnegative(),
  status: z.enum(['draft', 'approved', 'confirmed']),
  source: z.enum(['model', 'template', 'sentence_and_model', 'sentence']).optional(),
  horizon: z.enum(['days', 'weeks']),
  steps: z.array(goalPlanStepSchema),
  removedSteps: z.array(z.object({ stepId: z.string(), title: z.string() })).default([]),
}).passthrough();

const slotSchema = z.object({ startsAt: isoDateTime, endsAt: isoDateTime });
// A real wall-clock time: 00:00–23:59 (A4-003).
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const weeklySchema = z.object({ weekdays: z.array(z.number().int().min(0).max(6)), start: clock, end: clock });

/**
 * One step's place in the time proposal — exactly one of three shapes (WIRE):
 * a step after day 14 carries only its week; a commitment its slot (or null
 * with a reason) and slot alternatives; a habit its weekly timing and weekly
 * alternatives. Strict, so an impossible mix (a later step with a slot, a
 * commitment with a weekly timing) is refused rather than drawn and sent.
 */
const laterTimesStepSchema = z.object({
  stepId: z.string(),
  kind: z.enum(['commitment', 'habit']),
  later: z.object({ weekIndex: z.number().int().positive() }),
}).strict();
const commitmentTimesStepSchema = z.object({
  stepId: z.string(),
  kind: z.literal('commitment'),
  slot: slotSchema.nullable(),
  alternatives: z.array(slotSchema),
  reason: z.string().optional(),
  choice: z.enum(['proposed', 'none']),
}).strict();
const habitTimesStepSchema = z.object({
  stepId: z.string(),
  kind: z.literal('habit'),
  weekly: weeklySchema.nullable(),
  alternatives: z.array(weeklySchema),
  reason: z.string().optional(),
  choice: z.enum(['proposed', 'none']),
}).strict();
export const goalPlanTimesStepSchema = z.union([laterTimesStepSchema, commitmentTimesStepSchema, habitTimesStepSchema]);

export const goalPlanTimesSchema = z.object({
  timesId: z.string(),
  timesRevision: z.number().int().nonnegative(),
  planId: z.string(),
  planRevision: z.number().int().nonnegative(),
  anchor: z.object({ localDate: z.string(), timezone: z.string() }),
  steps: z.array(goalPlanTimesStepSchema),
}).passthrough();

const whenSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('slot'), startsAt: isoDateTime, endsAt: isoDateTime }),
  z.object({ kind: z.literal('weekly'), weekdays: z.array(z.number().int()), start: clock, end: clock }),
  z.object({ kind: z.literal('none') }),
]);
const whySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('later_week'), weekIndex: z.number().int().positive() }),
  z.object({ kind: z.literal('removed') }),
  z.object({ kind: z.literal('no_room'), reason: z.string() }),
]);

export const goalPlanConfirmResponseSchema = z.object({
  success: z.literal(true),
  saved: z.array(z.object({ stepId: z.string(), entity: z.enum(['commitment', 'habit']), id: z.string(), title: z.string(), when: whenSchema })),
  stayed: z.array(z.object({ stepId: z.string(), title: z.string(), why: whySchema })),
  // Every confirm names its outcome, so a replay can be told from a first save (WIRE).
  receipt: z.object({ outcomeId: z.string(), replayed: z.boolean() }).passthrough(),
}).passthrough();

const linkedWorkSchema = z.object({ entity: z.enum(['commitment', 'habit']), id: z.string(), title: z.string() }).passthrough();

export const goalPlanViewSchema = z.object({
  success: z.literal(true),
  draft: goalPlanSchema.nullable(),
  confirmed: z.object({
    planId: z.string(),
    saved: z.array(z.unknown()).default([]),
    pendingLater: z.array(z.object({ weekIndex: z.number().int().positive(), stepIds: z.array(z.string()) })).default([]),
  }).passthrough().nullable(),
  linkedWork: z.array(linkedWorkSchema).default([]),
}).passthrough();

export const goalPlanResponseSchema = z.object({ success: z.literal(true), plan: goalPlanSchema }).passthrough();
export const goalPlanApproveResponseSchema = z.object({ success: z.literal(true), plan: goalPlanSchema, times: goalPlanTimesSchema }).passthrough();
export const goalPlanTimesResponseSchema = z.object({ success: z.literal(true), times: goalPlanTimesSchema }).passthrough();
/** A later week's times come with the confirmed plan, so each step can be named. */
export const laterWeekTimesResponseSchema = z.object({ success: z.literal(true), plan: goalPlanSchema, times: goalPlanTimesSchema }).passthrough();

export const upcomingPlanItemSchema = z.object({
  goalId: z.string(),
  planId: z.string(),
  goalTitle: z.string(),
  weekIndex: z.number().int().positive(),
  weekStartsAt: isoDateTime.optional(),
  stepCount: z.number().int().positive(),
}).passthrough();
export const upcomingPlansResponseSchema = z.object({ success: z.literal(true), items: z.array(upcomingPlanItemSchema) });

export const statementPreviewResponseSchema = z.object({
  success: z.literal(true),
  summaryId: z.string(),
  revision: z.number().int().nonnegative(),
  understood: z.object({ goalText: z.string() }).passthrough(),
  expiresAt: isoDateTime,
}).passthrough();
export const statementAcceptResponseSchema = z.object({ success: z.literal(true), goalId: z.string() }).passthrough();

export type GoalPlan = z.infer<typeof goalPlanSchema>;
export type GoalPlanStep = z.infer<typeof goalPlanStepSchema>;
export type GoalPlanTimes = z.infer<typeof goalPlanTimesSchema>;
export type GoalPlanTimesStep = z.infer<typeof goalPlanTimesStepSchema>;
export type GoalPlanSlot = z.infer<typeof slotSchema>;
export type GoalPlanWeekly = z.infer<typeof weeklySchema>;
export type GoalPlanConfirmResult = z.infer<typeof goalPlanConfirmResponseSchema>;
export type GoalPlanView = z.infer<typeof goalPlanViewSchema>;
export type UpcomingPlanItem = z.infer<typeof upcomingPlanItemSchema>;
export type StatementPreview = z.infer<typeof statementPreviewResponseSchema>;
export type GoalPlanPhase = z.infer<typeof phaseSchema>;
export type GoalPlanRhythm = z.infer<typeof rhythmSchema>;
