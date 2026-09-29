import { apiRequest } from '../client';
import { meetingPrepResponseSchema, type MeetingPrepResponse } from '../schemas/meetings';

/**
 * «حضّرني» (CL5a): a busy block's times and the notes about it, in; a capture
 * proposal with one prep step, out. Nothing is saved until the proposal is
 * confirmed through the capture confirm.
 *
 * The block's times only — never a calendar event's title, which this app
 * does not read. The notes are sent once and not kept by the server.
 */
export function prepareMeeting(input: {
  notes: string;
  startAt: string;
  endAt: string | null;
  timezone: string;
}): Promise<MeetingPrepResponse> {
  return apiRequest('POST', '/api/mobile/meetings/prepare', {
    body: {
      notes: input.notes,
      startAt: input.startAt,
      ...(input.endAt ? { endAt: input.endAt } : {}),
      timezone: input.timezone,
    },
    schema: meetingPrepResponseSchema,
  });
}
