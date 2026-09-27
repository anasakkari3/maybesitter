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
    /**
     * When the phone first rings for it, as the server worked it out from this
     * account's reminder settings: the chosen prep instant whenever it can
     * ring then, and null when nothing will ring at all (CL5a I-3).
     */
    remindAt: isoDateTime.nullable(),
    /**
     * Why nothing rings, when nothing does: the switch is off, the survey said
     * silent, quiet hours last until just before, or no moment is left.
     */
    silentBecause: z.enum(['reminders_off', 'silent_choice', 'quiet_hours', 'too_close']).nullable(),
    /** When it is due: never after the start. */
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
