import { z } from 'zod';
import { isoDateTime } from './common';

/**
 * M5b-1's shapes (PLAN-M5b-1 Wire + the r5 amendments): memory you can read
 * as a paragraph, and energy that says what it did where the plan and the
 * next step are decided.
 *
 * Every new object is strict: a field this app was not built against is a
 * contract change, not something to ignore. Fields added to an existing
 * response are optional so an older server still parses.
 */

/** `GET /api/mobile/capabilities/m5b`: false whenever the flag is off or killed. */
export const m5bCapabilitiesSchema = z.object({
  success: z.literal(true),
  memoryLearning: z.boolean(),
}).strict();
export type M5bCapabilities = z.infer<typeof m5bCapabilitiesSchema>;

/* ── the memory paragraph (R1.1) ─────────────────────────────────────── */

export const summaryLanguageSchema = z.enum(['ar', 'en', 'he']);

const summarySentenceSchema = z.object({
  text: z.string().min(1),
  memoryIds: z.array(z.string().min(1)),
}).strict();

export const memorySummarySchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ready'),
    language: summaryLanguageSchema,
    sentences: z.array(summarySentenceSchema).min(1),
    coveredCount: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative(),
  }).strict(),
  z.object({ status: z.literal('empty') }).strict(),
  z.object({ status: z.literal('unavailable') }).strict(),
]);
export type MemorySummary = z.infer<typeof memorySummarySchema>;

/** `GET /api/mobile/memory/summary?language=`. */
export const memorySummaryResponseSchema = z.object({
  success: z.literal(true),
  summary: memorySummarySchema,
}).strict();
export type MemorySummaryResponse = z.infer<typeof memorySummaryResponseSchema>;

/* ── energy (R4) ─────────────────────────────────────────────────────── */

export const energyLevelSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]);
export const energyBandSchema = z.enum(['low', 'steady', 'high']);
export const energySourceSchema = z.enum(['check_in', 'health', 'none']);

/** On a plan: what the reading did to it. Null is an unknown snapshot (a plan stored before M5b-1). */
export const readinessAppliedSchema = z.object({
  source: energySourceSchema,
  energy: energyLevelSchema.nullable(),
  band: energyBandSchema.nullable(),
  bufferMinutesAdded: z.number().int().nonnegative(),
  observedAt: isoDateTime.nullable(),
}).strict().nullable();
export type ReadinessApplied = z.infer<typeof readinessAppliedSchema>;

/** On `GET /api/mobile/readiness`: what a plan built now would add. */
export const planEffectSchema = z.object({
  source: energySourceSchema,
  energy: energyLevelSchema.nullable(),
  band: energyBandSchema.nullable(),
  bufferMinutes: z.number().int().nonnegative(),
  staleReading: z.object({
    source: z.enum(['check_in', 'health']),
    observedAt: isoDateTime,
  }).strict().nullable(),
}).strict();
export type PlanEffect = z.infer<typeof planEffectSchema>;

/** On the next step: the reading, and whether it changed the pick. */
export const nextStepEnergySchema = z.object({
  band: energyBandSchema.nullable(),
  source: energySourceSchema,
  level: energyLevelSchema.nullable(),
  changedPick: z.boolean(),
}).strict();
export type NextStepEnergy = z.infer<typeof nextStepEnergySchema>;
