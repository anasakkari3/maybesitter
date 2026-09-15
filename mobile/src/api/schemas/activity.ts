import { z } from 'zod';
import { isoDateTime } from './common';

/**
 * Mirrors `activity.list.json` and `activity.summary.json` (UC-3.15, #201).
 *
 * ── `kind` is a string, not an enum ──────────────────────────────
 *
 * Two of the seven kinds the contract names have no producer in the backend
 * yet: `plan_accepted` arrives with UC-3.10a (#194) and
 * `reminder_acknowledged` with UC-3.14 (#200). A server that starts sending
 * one of them — or an eighth kind later — must not make the whole history
 * unparseable on a build that predates it. So the wire type is a string, the
 * kinds this build has words and an icon for are listed below, and the screen
 * skips an entry it cannot name rather than failing the screen.
 *
 * Same reasoning for a Moment's id, for the same reason: `first_plan_accepted`
 * cannot be reached until #194 lands.
 */

export const ACTIVITY_KINDS = [
  'captured',
  'confirmed',
  'completed',
  'postponed',
  'dropped',
  'plan_accepted',
  'reminder_acknowledged',
] as const;

export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export const MOMENT_IDS = [
  'first_capture',
  'first_done',
  'first_plan_accepted',
  'done_10',
  'done_25',
  'done_50',
  'done_100',
] as const;

export type MomentId = (typeof MOMENT_IDS)[number];

export function knownActivityKind(kind: string): ActivityKind | null {
  return (ACTIVITY_KINDS as readonly string[]).includes(kind) ? (kind as ActivityKind) : null;
}

export function knownMomentId(id: string): MomentId | null {
  return (MOMENT_IDS as readonly string[]).includes(id) ? (id as MomentId) : null;
}

export const activityItemSchema = z.object({
  id: z.string(),
  kind: z.string(),
  at: isoDateTime,
  /** Null when the entry is not about a commitment at all. */
  commitmentId: z.string().nullable(),
  /** Null when the commitment has been deleted; the screen names that. */
  commitmentTitle: z.string().nullable(),
  detail: z.object({ postponedUntil: isoDateTime.optional() }).optional(),
});

export const activityPageSchema = z.object({
  items: z.array(activityItemSchema),
  /** Opaque, and only ever echoed back. Null means the history is exhausted. */
  nextCursor: z.string().nullable(),
});

export const momentSchema = z.object({
  id: z.string(),
  reachedAt: isoDateTime,
});

/**
 * The week's three counts and the account's Moments.
 *
 * There is no field here for what did not happen, and there is not meant to
 * be: #201's decision is that this surface is not gamified — no streak, no
 * percentage, no "missed" count, no badge that can be lost.
 */
export const weeklySummarySchema = z.object({
  weekStart: z.string(),
  completedCount: z.number(),
  plannedDaysCount: z.number(),
  keptCount: z.number(),
  moments: z.array(momentSchema),
});

export type ActivityItem = z.infer<typeof activityItemSchema>;
export type ActivityPage = z.infer<typeof activityPageSchema>;
export type Moment = z.infer<typeof momentSchema>;
export type WeeklySummary = z.infer<typeof weeklySummarySchema>;
