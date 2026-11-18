import { apiRequest } from '../client';
import { rescheduleDecisionSchema, rescheduleListSchema, type RescheduleDecision, type RescheduleList } from '../schemas/reschedule';

type Bound = { asUid?: string };
const bound = (options: Bound) => (options.asUid !== undefined ? { asUid: options.asUid } : {});

/** Missed work's new plan and the plans that can still be put back (lane E4). Read-only. */
export function getReschedule(options: Bound = {}): Promise<RescheduleList> {
  return apiRequest('GET', '/api/mobile/reschedule', { schema: rescheduleListSchema, ...bound(options) });
}

/** «اقبل» / «مش هلّق» / «رجّعها». `clientActionId` makes a repeated tap a replay, not a second move. */
export function decideReschedule(
  commitmentId: string,
  input: { action: 'accept' | 'dismiss' | 'undo'; clientActionId: string; proposalId?: string },
  options: Bound = {},
): Promise<RescheduleDecision> {
  return apiRequest('POST', `/api/mobile/reschedule/${encodeURIComponent(commitmentId)}`, {
    body: input,
    schema: rescheduleDecisionSchema,
    ...bound(options),
  });
}
