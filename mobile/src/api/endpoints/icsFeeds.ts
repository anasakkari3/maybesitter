import { apiRequest } from '../client';
import {
  icsDeadlineDecidedSchema,
  icsFeedCreatedSchema,
  icsFeedDeletedSchema,
  icsFeedListSchema,
  icsFeedRefreshedSchema,
  icsFeedUpdatedSchema,
  type IcsDeadlineAction,
} from '../schemas/icsFeeds';

/**
 * The calendar feed calls (UC-3.4, #188).
 *
 * `createIcsFeed` is the only function in the app that is ever handed a feed
 * URL, and it hands it straight to the request body. Nothing here keeps it,
 * logs it or returns it; the server's answer does not contain it either.
 */

export function listIcsFeeds() {
  return apiRequest('GET', '/api/mobile/calendar/ics', { schema: icsFeedListSchema });
}

export function createIcsFeed(input: { url: string; label: string | null; autoAcceptDeadlines: boolean }) {
  return apiRequest('POST', '/api/mobile/calendar/ics', {
    body: {
      url: input.url,
      ...(input.label ? { label: input.label } : {}),
      autoAcceptDeadlines: input.autoAcceptDeadlines,
    },
    schema: icsFeedCreatedSchema,
    expectStatus: 201,
  });
}

export function updateIcsFeed(feedId: string, changes: { label?: string | null; autoAcceptDeadlines?: boolean }) {
  return apiRequest('PATCH', `/api/mobile/calendar/ics/${encodeURIComponent(feedId)}`, {
    body: changes,
    schema: icsFeedUpdatedSchema,
  });
}

export function refreshIcsFeed(feedId: string) {
  return apiRequest('POST', `/api/mobile/calendar/ics/${encodeURIComponent(feedId)}/refresh`, {
    schema: icsFeedRefreshedSchema,
  });
}

export function deleteIcsFeed(feedId: string) {
  return apiRequest('DELETE', `/api/mobile/calendar/ics/${encodeURIComponent(feedId)}`, {
    schema: icsFeedDeletedSchema,
  });
}

export function decideIcsDeadline(feedId: string, itemKey: string, action: IcsDeadlineAction) {
  return apiRequest(
    'POST',
    `/api/mobile/calendar/ics/${encodeURIComponent(feedId)}/deadlines/${encodeURIComponent(itemKey)}`,
    { body: { action }, schema: icsDeadlineDecidedSchema },
  );
}
