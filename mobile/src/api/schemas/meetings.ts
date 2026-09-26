import { z } from 'zod';
import { isoDateTime } from './common';
import { captureProposalSchema } from './capture';

/**
 * Mirrors `meetings.prepared.json` / `meetings.preparedGemini.json` (CL5a).
 *
 * The proposal is the ordinary capture proposal, parsed by the capture schema,
 * because it is reviewed and confirmed by the capture flow. `prep` says which
 * of its items is the one step before the meeting, and when it is due.
 */
export const meetingPrepResponseSchema = z.object({
  success: z.literal(true),
  proposal: captureProposalSchema,
  prep: z.object({
    itemId: z.string(),
    remindAt: isoDateTime,
    leadMinutes: z.number().int(),
    /**
     * Why the prep step is not simply an hour before: `short_notice` when the
     * meeting is sooner than that, `quiet_hours` when the hour fell inside them.
     */
    adjustment: z.enum(['none', 'short_notice', 'quiet_hours', 'quiet_hours_unavoidable']),
    startAt: isoDateTime,
    endAt: isoDateTime.nullable(),
  }),
});

export type MeetingPrepResponse = z.infer<typeof meetingPrepResponseSchema>;
