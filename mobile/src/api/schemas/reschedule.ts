import { z } from 'zod';
import { isoDateTime } from './common';

/**
 * Missed work's new plan (lane E4): `GET /api/mobile/reschedule` and the
 * decision route `POST /api/mobile/reschedule/{commitmentId}`. Strict: a field
 * the server added that this app does not know is a contract it was not built
 * against. The server computes everything; the app only words `reason` and
 * `changes` from its own templates.
 */
const dayPart = z.enum(['morning', 'afternoon', 'evening']);

export const rescheduleSessionSchema = z.object({
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  localTime: z.string().regex(/^\d{2}:\d{2}$/),
}).strict();

export const rescheduleProposalSchema = z.object({
  commitmentId: z.string().min(1),
  title: z.string(),
  proposalId: z.string().min(1),
  missedAt: isoDateTime,
  missCount: z.number().int().positive(),
  reason: z.enum(['first_miss', 'same_time_again', 'missed_again', 'deadline_near']),
  changes: z.array(z.enum(['new_time', 'other_time_of_day', 'smaller_pieces', 'earlier_start'])).min(1),
  fromDayPart: dayPart,
  toDayPart: dayPart,
  minutesBefore: z.number().positive(),
  minutesEach: z.number().positive(),
  sessions: z.array(rescheduleSessionSchema).min(1).max(2),
}).strict();

export type RescheduleProposal = z.infer<typeof rescheduleProposalSchema>;

export const rescheduleAcceptedSchema = z.object({
  commitmentId: z.string().min(1),
  title: z.string(),
  undoUntil: isoDateTime,
  sessions: z.array(rescheduleSessionSchema).min(1).max(2),
}).strict();

export type RescheduleAccepted = z.infer<typeof rescheduleAcceptedSchema>;

export const rescheduleListSchema = z.object({
  success: z.literal(true),
  proposal: rescheduleProposalSchema.nullable(),
  accepted: z.array(rescheduleAcceptedSchema),
}).strict();

export type RescheduleList = z.infer<typeof rescheduleListSchema>;

export const rescheduleDecisionSchema = z.object({
  success: z.literal(true),
  state: z.enum(['accepted', 'dismissed', 'undone']),
  undoUntil: isoDateTime.optional(),
  replayed: z.literal(true).optional(),
}).strict();

export type RescheduleDecision = z.infer<typeof rescheduleDecisionSchema>;

/** The 409s: a proposal that went stale (with the fresh one, or none), or an undo no longer open. */
export const rescheduleRefusedSchema = z.union([
  z.object({ success: z.literal(false), error: z.literal('proposal_stale'), proposal: rescheduleProposalSchema.nullable() }).strict(),
  z.object({ success: z.literal(false), error: z.enum(['undo_unavailable', 'nothing_to_dismiss']) }).strict(),
]);
