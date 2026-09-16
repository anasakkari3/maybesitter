import { apiRequest } from '../client';
import {
  calendarSettingsResponseSchema,
  deviceCalendarLinkRemovedSchema,
  deviceCalendarLinkResponseSchema,
  type CalendarWriteTarget,
} from '../schemas/calendar';
import type { DeviceCalendarLink } from '../schemas/common';

/**
 * The two calendar calls (UC-3.1, #185).
 *
 * The link route is the only place in this app where a 409 is *expected* rather
 * than exceptional: it is how the server tells a second device that somebody
 * else owns this commitment's event. `client.ts` turns it into a
 * `DeviceCalendarLinkConflictError`, and the sync service treats it as "leave
 * the calendar alone" rather than as a failure to report.
 */

export function getCalendarSettings(): Promise<{ calendarSettings: { writeTarget: CalendarWriteTarget } }> {
  return apiRequest('GET', '/api/mobile/settings/calendar', {
    schema: calendarSettingsResponseSchema,
  });
}

export function putCalendarWriteTarget(
  writeTarget: CalendarWriteTarget,
): Promise<{ calendarSettings: { writeTarget: CalendarWriteTarget } }> {
  return apiRequest('PUT', '/api/mobile/settings/calendar', {
    body: { writeTarget },
    schema: calendarSettingsResponseSchema,
  });
}

export function putDeviceCalendarLink(
  commitmentId: string,
  link: Omit<DeviceCalendarLink, 'writtenAt'>,
): Promise<{ deviceCalendarLink: DeviceCalendarLink }> {
  return apiRequest('PUT', `/api/mobile/commitments/${encodeURIComponent(commitmentId)}/device-calendar-link`, {
    body: link,
    schema: deviceCalendarLinkResponseSchema,
  });
}

export function deleteDeviceCalendarLink(
  commitmentId: string,
  writerId: string,
): Promise<{ deleted: boolean }> {
  return apiRequest('DELETE', `/api/mobile/commitments/${encodeURIComponent(commitmentId)}/device-calendar-link`, {
    query: { writerId },
    schema: deviceCalendarLinkRemovedSchema,
  });
}
