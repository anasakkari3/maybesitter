/**
 * The claim the app sends is one the server accepts (QA v3, V3-F18-04).
 *
 * The bug: on the iPhone every `PUT …/device-calendar-link` the app made was
 * answered 400, so no link was ever stored and every refresh wrote the event
 * again — 8 and 9 copies of each commitment. A hand-made body was accepted.
 * Nothing caught it because the app's tests checked the claim against a fake
 * calendar and a fake server, and the server's tests checked bodies written by
 * hand. This file runs the whole client side for real — the native seam, the
 * sync, the endpoint — with only `expo-calendar` and the HTTP call replaced,
 * and gives the body that would go on the wire to the server's own rule.
 *
 * The calendar double answers `createEvent` the way the iOS class API did on
 * the QA simulator: with an object that carries no id (the app recorded
 * `[null]` as every event id it wrote).
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Commitment } from '../../../api/schemas/common';
import { parseDeviceCalendarLinkInput } from '../../../../../lib/services/calendar/deviceCalendarLinkInput';

interface Row { id: string; calendarId: string; url?: string; title?: string }
const mockRows = new Map<string, Row>();
let mockSequence = 0;
const mockSentBodies: unknown[] = [];

function mockNativeEvent(row: Row) {
  return {
    id: row.id,
    url: row.url ?? null,
    update: async (details: Partial<Row>) => { Object.assign(row, details); },
    delete: async () => { mockRows.delete(row.id); },
  };
}

jest.mock('expo-calendar', () => ({
  EntityTypes: { EVENT: 'event' },
  getCalendarPermissions: async () => ({ granted: true, status: 'granted' }),
  ExpoCalendar: {
    get: async (calendarId: string) => ({
      id: calendarId,
      allowsModifications: true,
      createEvent: async (details: Partial<Row>) => {
        mockSequence += 1;
        const row: Row = { ...details, id: `ITEM-${mockSequence}`, calendarId };
        mockRows.set(row.id, row);
        // What the iOS class API answered on the QA simulator: no id.
        return { ...mockNativeEvent(row), id: undefined };
      },
      listEvents: async () => [...mockRows.values()].filter((row) => row.calendarId === calendarId).map(mockNativeEvent),
    }),
  },
  ExpoCalendarEvent: {
    get: async (id: string) => {
      const row = mockRows.get(id);
      if (!row) throw new Error('Event not found');
      return mockNativeEvent(row);
    },
  },
}));

jest.mock('../../../api/client', () => ({
  apiRequest: async (_method: string, _path: string, options: { body?: unknown }) => {
    // What `fetch` would carry: the JSON text, parsed back.
    mockSentBodies.push(JSON.parse(JSON.stringify(options.body)));
    return { deviceCalendarLink: options.body };
  },
}));

// Imported after the mocks are registered.
/* eslint-disable @typescript-eslint/no-require-imports */
const { deviceCalendar } = require('../deviceCalendar') as typeof import('../deviceCalendar');
const { reconcile } = require('../deviceCalendarSync') as typeof import('../deviceCalendarSync');
const { putDeviceCalendarLink } = require('../../../api/endpoints/calendar') as typeof import('../../../api/endpoints/calendar');
/* eslint-enable @typescript-eslint/no-require-imports */

const ZONE = 'Asia/Jerusalem';

function commitment(): Commitment {
  return {
    id: 'cmt-1',
    kind: 'task',
    title: 'موعد مع المحاسب',
    description: null,
    person: null,
    status: 'active',
    category: null,
    categorySource: 'inferred',
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
    timeSpec: { kind: 'due_by', dueAt: '2026-11-21T08:00:00.000Z', endAt: null, remindAt: null, allDay: false, timezone: ZONE },
    currentAckState: 'not_seen',
    postponedUntil: null,
    createdAt: '2026-11-19T00:00:00.000Z',
    updatedAt: '2026-11-19T00:00:00.000Z',
    confirmedAt: '2026-11-19T00:00:00.000Z',
    completedAt: null,
    droppedAt: null,
  };
}

function pass() {
  return reconcile({
    subjects: [{ commitmentId: 'cmt-1', commitment: commitment(), link: null }],
    writeTarget: 'device',
    writerId: 'c25b965a-115e-47c2-b6d5-c8002d2f3935',
    calendarId: '04A83879-B0D5-4DEE-B51D-4A5D070D5AD9',
    deviceTimeZone: ZONE,
    ports: {
      calendar: deviceCalendar,
      putLink: async (commitmentId, link) => { await putDeviceCalendarLink(commitmentId, link); },
      deleteLink: async () => undefined,
      rememberEvent: async () => undefined,
      forgetEvent: async () => undefined,
    },
  });
}

beforeEach(() => {
  mockRows.clear();
  mockSequence = 0;
  mockSentBodies.length = 0;
});

describe('the claim body, against the server\'s own rule', () => {
  it('is accepted, and names the event that is in the calendar', async () => {
    const outcome = await pass();
    expect(mockSentBodies).toHaveLength(1);
    const accepted = parseDeviceCalendarLinkInput(mockSentBodies[0] as never);
    expect(accepted.eventId).toBe('ITEM-1');
    expect(mockRows.has(accepted.eventId)).toBe(true);
    expect(outcome.created).toBe(1);
  });

  it('leaves exactly one event however many times the pass runs before the link comes back', async () => {
    // The server's answer is not fed back here, as it was not on the phone:
    // every pass sees "no link". The calendar must still hold one event.
    await pass();
    await pass();
    await pass();
    expect(mockRows.size).toBe(1);
    for (const body of mockSentBodies) {
      expect(() => parseDeviceCalendarLinkInput(body as never)).not.toThrow();
    }
  });
});
