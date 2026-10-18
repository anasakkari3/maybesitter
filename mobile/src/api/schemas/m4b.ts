import { z } from 'zod';
import { isoDateTime } from './common';

/**
 * M4b's shapes (WIRE-M4b): time that helps decide, part 2 — an external
 * source never inserts a clash silently (condition 24), an evening that can
 * hurt the next morning (25), and postpone offering real free times (26).
 *
 * Every new object is strict: a field the server added that this app does not
 * know is a contract it was not built against. Every new field on an existing
 * response is optional, so a server without M4b still parses.
 */

/**
 * One clash, the same fields and meaning as the capture card's `conflicts`
 * entry without `inProposal`: the person's own title for a commitment, a
 * weekly block or a match; null only for calendar busy time, which has no
 * title and is never given one.
 */
export const clashSchema = z.object({
  title: z.string().nullable(),
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  kind: z.enum(['commitment', 'fixture', 'weekly', 'calendar_busy']),
}).strict();

export type Clash = z.infer<typeof clashSchema>;

/** `GET /api/mobile/capabilities/m4b`. Exists in every environment; all false when off. */
export const m4bCapabilitiesSchema = z.object({
  success: z.literal(true),
  externalClashHold: z.boolean(),
  eveningImpact: z.boolean(),
  smartPostpone: z.boolean(),
}).strict();

export type M4bCapabilities = z.infer<typeof m4bCapabilitiesSchema>;

/* ── R1: held external items ─────────────────────────────────────────── */

/** A followed club's match the server did not save because it clashes. */
export const heldFixtureSchema = z.object({
  fixtureId: z.string().min(1),
  heldVersion: z.string().min(1),
  homeTeamName: z.string(),
  awayTeamName: z.string(),
  homeTeamId: z.string().optional(),
  awayTeamId: z.string().optional(),
  kickoffUtc: isoDateTime,
  endUtc: isoDateTime,
  moved: z.boolean(),
  clashes: z.array(clashSchema).min(1),
}).strict();

export type HeldFixture = z.infer<typeof heldFixtureSchema>;

/** The 409 `held_changed` body: the hold as it is now, or null when it is gone. */
export const heldChangedSchema = z.object({
  success: z.literal(false),
  error: z.literal('held_changed'),
  held: heldFixtureSchema.nullable(),
}).strict();

/** `GET /api/mobile/held-items`: what «يتابع لك» counts. */
export const heldItemsSchema = z.object({
  success: z.literal(true),
  count: z.number().int().nonnegative(),
  items: z.array(z.object({
    source: z.enum(['football', 'ics']),
    id: z.string().min(1),
    title: z.string(),
    startsAt: isoDateTime,
  }).strict()),
}).strict();

export type HeldItems = z.infer<typeof heldItemsSchema>;

/** A calendar feed row's hold (R1.4): `clashes` is empty for `unknown`. */
export const icsHeldSchema = z.object({
  reason: z.enum(['clash', 'unknown']),
  clashes: z.array(clashSchema),
}).strict();

/* ── R2: evening impact on a capture proposal item ───────────────────── */

export const eveningImpactSchema = z.object({
  kind: z.literal('late_before_important'),
  role: z.enum(['evening', 'important']),
  otherTitle: z.string(),
  otherStartsAt: isoDateTime,
  otherEndsAt: isoDateTime.nullable(),
  otherInProposal: z.literal(true).optional(),
  readiness: z.enum(['ready', 'not_ready', 'unsure']).nullable(),
  prep: z.union([
    z.null(),
    z.object({ state: z.literal('offered'), itemId: z.string().min(1) }).strict(),
    z.object({ state: z.literal('no_slot') }).strict(),
  ]),
}).strict();

export type EveningImpact = z.infer<typeof eveningImpactSchema>;
export type Readiness = 'ready' | 'not_ready' | 'unsure';

/** A prep item the server generated from a readiness answer. */
export const generatedItemSchema = z.object({
  kind: z.literal('evening_impact_prep'),
  sourceItemId: z.string().min(1),
}).strict();

/* ── R3: postpone slots ─────────────────────────────────────────────── */

export const postponeSlotSchema = z.object({
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  localTime: z.string().regex(/^\d{2}:\d{2}$/),
  why: z.enum(['soonest', 'light_day', 'usual_time']),
  slotToken: z.string().min(1),
}).strict();

export type PostponeSlot = z.infer<typeof postponeSlotSchema>;

export const postponeSlotsSchema = z.object({
  success: z.literal(true),
  complete: z.boolean(),
  slots: z.array(postponeSlotSchema).max(3),
}).strict();

export type PostponeSlots = z.infer<typeof postponeSlotsSchema>;

/** The action route's 409 for a picked slot. */
export const slotRefusedSchema = z.object({
  success: z.literal(false),
  error: z.enum(['slot_taken', 'slot_unverified', 'slot_stale']),
  slots: z.array(postponeSlotSchema),
  complete: z.boolean(),
}).strict();
