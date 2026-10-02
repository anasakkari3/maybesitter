import { apiRequest } from '../client';
import { meetingPrepResponseSchema, type MeetingPrepResponse } from '../schemas/meetings';
import type { Locale } from '../../i18n/locale';

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
  /** The app's UI language: the steps are titled in it (owner request 2026-09-30). */
  locale?: Locale;
  /**
   * The person's own commitment it is for, when it is one (audit 2026-10-03
   * #3): the server reads that commitment's title to give an exam a day of
   * lead. Never sent for a calendar busy block.
   */
  commitmentId?: string;
}): Promise<MeetingPrepResponse> {
  return apiRequest('POST', '/api/mobile/meetings/prepare', {
    body: {
      notes: input.notes,
      startAt: input.startAt,
      ...(input.endAt ? { endAt: input.endAt } : {}),
      timezone: input.timezone,
      ...(input.locale ? { locale: input.locale } : {}),
      ...(input.commitmentId ? { commitmentId: input.commitmentId } : {}),
    },
    schema: meetingPrepResponseSchema,
  });
}
