/**
 * The Google Calendar calls the verification demo makes (UC-1.8 #152).
 *
 * Development only. Nothing here goes near MaybeSitter's own backend, and
 * nothing is stored: the access token lives in component state, and the demo
 * screen is unreachable in any build that is not a developer's.
 *
 * Every request narrows what it asks for. `calendarList` uses
 * `fields=items(id,summary)` so the response cannot contain anything but ids
 * and names, and `freeBusy` returns only ranges — there is no field in its
 * response that could carry an event title. That is the scope justification
 * made true in the request rather than promised in prose.
 */
import type { BusyInterval } from './overlap';

const BASE = 'https://www.googleapis.com/calendar/v3';

export class CalendarApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'CalendarApiError';
  }
}

async function call<T>(
  accessToken: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  if (!response.ok) {
    // The status only. Google's error bodies echo the request, and this one
    // carries the user's calendar ids.
    throw new CalendarApiError(response.status, `calendar request failed (${response.status})`);
  }
  return (text === '' ? null : JSON.parse(text)) as T;
}

export interface CalendarSummary {
  id: string;
  summary: string;
}

/** Names and ids, because `fields` allows the response nothing else. */
export async function listCalendars(accessToken: string): Promise<CalendarSummary[]> {
  const result = await call<{ items?: { id?: string; summary?: string }[] }>(
    accessToken,
    '/users/me/calendarList?fields=items(id,summary)',
  );
  return (result.items ?? [])
    .filter((item): item is { id: string; summary: string } => !!item.id)
    .map(item => ({ id: item.id, summary: item.summary ?? item.id }));
}

/**
 * When the user is busy across the chosen calendars, as ranges.
 *
 * `freeBusy` is used rather than `events.list` on purpose: its response has no
 * field for a title, so "we never read event titles" is enforced by the API
 * rather than by this code remembering not to look.
 */
export async function fetchBusy(
  accessToken: string,
  calendarIds: readonly string[],
  from: Date,
  to: Date,
): Promise<BusyInterval[]> {
  if (calendarIds.length === 0) return [];
  const result = await call<{ calendars?: Record<string, { busy?: { start: string; end: string }[] }> }>(
    accessToken,
    '/freeBusy',
    {
      method: 'POST',
      body: {
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        items: calendarIds.map(id => ({ id })),
      },
    },
  );
  return Object.values(result.calendars ?? {}).flatMap(calendar => calendar.busy ?? []);
}

/**
 * Writes one test event, which is what demonstrates the *write* half of
 * `calendar.events` to a reviewer.
 *
 * `extendedProperties.private.maybesitterCommitmentId` is how the real feature
 * (UC-3.3 #187) will find its own events again without guessing from titles.
 */
export async function insertDemoEvent(
  accessToken: string,
  input: { summary: string; start: Date; end: Date; commitmentId: string },
): Promise<{ id: string; htmlLink: string | null }> {
  const result = await call<{ id?: string; htmlLink?: string }>(
    accessToken,
    '/calendars/primary/events',
    {
      method: 'POST',
      body: {
        summary: input.summary,
        start: { dateTime: input.start.toISOString() },
        end: { dateTime: input.end.toISOString() },
        extendedProperties: { private: { maybesitterCommitmentId: input.commitmentId } },
      },
    },
  );
  return { id: result.id ?? '', htmlLink: result.htmlLink ?? null };
}
