import { apiRequest } from '../client';
import {
  footballFixtureDismissedSchema,
  footballSettingsResponseSchema,
  type FootballSettingsResponse,
} from '../schemas/football';

/**
 * The three football calls (football fixtures MVP, Task 11).
 *
 * `getFootballSettings`/`putFollowedClubs` both answer the identical shape --
 * clubs, the follows, and the account's currently-active fixtures -- because
 * saving projects immediately (see the route's own header): the response to
 * `PUT` already carries whatever the follow just unlocked, so a screen never
 * has to make a second call to find out.
 */
export function getFootballSettings(): Promise<FootballSettingsResponse> {
  return apiRequest('GET', '/api/mobile/football', {
    schema: footballSettingsResponseSchema,
  });
}

/**
 * `locale` is the app's current language: the server titles the matches this
 * save projects in it ("برشلونة – ريال مدريد"), since it has no other way to
 * know which language the person reads.
 */
export function putFollowedClubs(clubIds: readonly string[], locale: 'ar' | 'he' | 'en'): Promise<FootballSettingsResponse> {
  return apiRequest('PUT', '/api/mobile/football', {
    body: { clubIds, locale },
    schema: footballSettingsResponseSchema,
  });
}

/**
 * The opt-out per match: "not this one" without unfollowing the whole club.
 *
 * A 404 here means the server found no football fixture reference linking
 * this commitment -- true for an id that never existed and for a real,
 * user-typed commitment alike (see the route's own header). Either way there
 * is nothing left to dismiss, and `apiRequest` turns that into a
 * `NotFoundError` the same as any other 404.
 */
export function dismissFixture(commitmentId: string): Promise<{ id: string; dismissed: boolean }> {
  return apiRequest('DELETE', `/api/mobile/football/fixtures/${encodeURIComponent(commitmentId)}`, {
    schema: footballFixtureDismissedSchema,
  });
}
