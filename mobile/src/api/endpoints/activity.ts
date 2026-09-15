import { apiRequest } from '../client';
import { activityPageSchema, weeklySummarySchema } from '../schemas/activity';

/**
 * One page of history, newest first (UC-3.15, #201).
 *
 * `cursor` is whatever the previous response returned and nothing else. It is
 * never constructed here: its shape is the server's, and a client that built
 * one would be deciding where the server's pages begin.
 */
export function listActivity(input: { cursor?: string | null; limit?: number } = {}) {
  return apiRequest('GET', '/api/mobile/activity', {
    query: {
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.limit ? { limit: input.limit } : {}),
    },
    schema: activityPageSchema,
  });
}

/**
 * The week's summary.
 *
 * `weekStart` is omitted for "this week", and the *server* decides which week
 * that is — from the timezone and language on the account, Sunday for Arabic
 * and Hebrew and Monday for English. A client that computed it would disagree
 * with the other device the same person is signed in on.
 */
export function getWeeklySummary(weekStart?: string) {
  return apiRequest('GET', '/api/mobile/activity/summary', {
    query: { ...(weekStart ? { weekStart } : {}) },
    schema: weeklySummarySchema,
  });
}
