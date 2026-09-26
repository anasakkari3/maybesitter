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
    /** The first item of `proposal.items`, always. */
    itemId: z.string(),
    /** When its reminder rings: the chosen prep instant. */
    remindAt: isoDateTime,
    /**
     * When it is due: one reminder lead after `remindAt`, never after the
     * start, so the phone's own reminder (`dueAt − lead`) rings at `remindAt`.
     */
    dueAt: isoDateTime,
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
