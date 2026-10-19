import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, screen, waitFor } from '@testing-library/react-native';
import { TodayScreen } from '../../screens/TodayScreen';
import {
  ITEM_ID,
  NOW,
  accessibilityAction,
  capabilities,
  commitment,
  firstRequest,
  instant,
  prepare,
  press,
  show,
  showDetails,
  teardown,
  type M4bHarness,
  type RecordedRequest,
  type RouteReply,
} from './harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

const PRESETS = ['oneHour', 'threeHours', 'tomorrowMorning', 'nextWeek'] as const;
const SLOTS = [
  { startsAt: instant('2030-03-29', '17:00'), endsAt: instant('2030-03-29', '18:00'), localDate: '2030-03-29', localTime: '17:00', why: 'soonest', slotToken: 'slot-token-0' },
  { startsAt: instant('2030-03-30', '10:00'), endsAt: instant('2030-03-30', '11:00'), localDate: '2030-03-30', localTime: '10:00', why: 'light_day', slotToken: 'slot-token-1' },
  { startsAt: instant('2030-03-31', '18:00'), endsAt: instant('2030-03-31', '19:00'), localDate: '2030-03-31', localTime: '18:00', why: 'usual_time', slotToken: 'slot-token-2' },
];

let harness: M4bHarness | undefined;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(async () => {
  await teardown(harness);
  harness = undefined;
  jest.useRealTimers();
});

function todayRows(request: RecordedRequest): RouteReply | undefined {
  if (request.path === '/api/mobile/commitments/today') {
    return {
      status: 200,
      body: {
        items: [commitment('primary', { rank: 0 }), commitment(ITEM_ID, { rank: 1 })],
        calendarOrphans: [],
      },
    };
  }
  return undefined;
}

async function showToday(handler?: (request: RecordedRequest) => RouteReply | Promise<RouteReply> | undefined): Promise<void> {
  harness = await prepare('en', async request => await handler?.(request) ?? todayRows(request));
  await show(harness, <TodayScreen />);
  await waitFor(() => expect(screen.queryByTestId(`today-item-${ITEM_ID}`)).not.toBeNull());
}

function expectLegacyPostpone(request: RecordedRequest): void {
  expect(request.body).toMatchObject({ action: 'postpone' });
  expect(request.body).toHaveProperty('postponedUntil');
  expect(request.body).not.toHaveProperty('fromSlot');
  expect(request.body).not.toHaveProperty('slotToken');
}

describe('M4b capability fail closed', () => {
  it.each([
    ['error', { status: 503, body: { success: false, error: 'unavailable', reason: 'unavailable' } }],
    ['all-false', { status: 200, body: capabilities({ externalClashHold: false, eveningImpact: false, smartPostpone: false }) }],
    ['killed', { status: 200, body: capabilities({ smartPostpone: false }) }],
  ])('M4B-REV-007 %s keeps the row one-hour action and makes no gated reads', async (_case, probe) => {
    await showToday(request => request.path === '/api/mobile/capabilities/m4b' ? probe : undefined);
    await accessibilityAction(`today-item-${ITEM_ID}`, 'postpone');

    await waitFor(() => expect(harness!.server.matching('POST', new RegExp(`/commitments/${ITEM_ID}/actions$`))).toHaveLength(1));
    expectLegacyPostpone(firstRequest(harness!, 'POST', new RegExp(`/commitments/${ITEM_ID}/actions$`)));
    expect(harness!.server.matching('GET', /\/capabilities\/m4b$/)).not.toHaveLength(0);
    expect(harness!.server.matching('GET', /\/postpone-slots$/)).toHaveLength(0);
    expect(harness!.server.matching('GET', /\/held-items$/)).toHaveLength(0);
    expect(harness!.server.matching('POST', /\/capture\/impact$/)).toHaveLength(0);
  });

  it('M4B-R2-005 a pending fresh probe waits at most 1.5 seconds, then uses today\'s action', async () => {
    await showToday(request => request.path === '/api/mobile/capabilities/m4b'
      ? new Promise<RouteReply>(() => undefined)
      : undefined);

    await accessibilityAction(`today-item-${ITEM_ID}`, 'postpone');
    expect(harness!.server.matching('POST', new RegExp(`/commitments/${ITEM_ID}/actions$`))).toHaveLength(0);
    await act(async () => { jest.advanceTimersByTime(1_501); });
    await waitFor(() => expect(harness!.server.matching('POST', new RegExp(`/commitments/${ITEM_ID}/actions$`))).toHaveLength(1));
    expectLegacyPostpone(firstRequest(harness!, 'POST', new RegExp(`/commitments/${ITEM_ID}/actions$`)));
  });

  it('M4B-R2-005 a cached true followed by a fresh false postpones immediately instead of opening slots', async () => {
    let probes = 0;
    await showToday(request => {
      if (request.path !== '/api/mobile/capabilities/m4b') return undefined;
      probes += 1;
      return { status: 200, body: capabilities({ smartPostpone: probes === 1 }) };
    });
    await waitFor(() => expect(harness!.server.matching('GET', /\/capabilities\/m4b$/)).toHaveLength(1));

    await accessibilityAction(`today-item-${ITEM_ID}`, 'postpone');
    await waitFor(() => expect(harness!.server.matching('GET', /\/capabilities\/m4b$/)).toHaveLength(2));
    await waitFor(() => expect(harness!.server.matching('POST', new RegExp(`/commitments/${ITEM_ID}/actions$`))).toHaveLength(1));
    expect(screen.queryByTestId('postpone-sheet')).toBeNull();
  });

  it('M4B-REV-007 the Details sheet shows all four presets immediately while smart postpone is false', async () => {
    harness = await prepare('en', request => request.path === '/api/mobile/capabilities/m4b'
      ? { status: 200, body: capabilities({ smartPostpone: false }) }
      : undefined);
    await showDetails(harness);
    await press('details-postpone');

    for (const preset of PRESETS) expect(screen.queryByTestId(`postpone-${preset}`)).not.toBeNull();
    expect(screen.queryByTestId('postpone-slots-loading')).toBeNull();
    expect(harness.server.matching('GET', /\/postpone-slots$/)).toHaveLength(0);
    expect(harness.server.matching('GET', /\/capabilities\/m4b$/)).not.toHaveLength(0);
  });
});

describe('R3.3 smart postpone', () => {
  it('R3.3 enabled Today row postpone opens the sheet without moving anything', async () => {
    await showToday(request => request.path === `/api/mobile/commitments/${ITEM_ID}/postpone-slots`
      ? { status: 200, body: { success: true, complete: true, slots: SLOTS } }
      : undefined);
    await accessibilityAction(`today-item-${ITEM_ID}`, 'postpone');

    await waitFor(() => expect(screen.queryByTestId('postpone-sheet')).not.toBeNull());
    expect(harness!.server.matching('POST', new RegExp(`/commitments/${ITEM_ID}/actions$`))).toHaveLength(0);
  });

  it('R3.3 renders up to three real slots, keeps custom, and sends the selected token and start', async () => {
    harness = await prepare('en', request => {
      if (request.path === `/api/mobile/commitments/${ITEM_ID}/postpone-slots`) {
        return { status: 200, body: { success: true, complete: true, slots: SLOTS } };
      }
      return undefined;
    });
    await showDetails(harness);
    await press('details-postpone');

    for (let n = 0; n < 3; n += 1) expect(screen.queryByTestId(`postpone-slot-${n}`)).not.toBeNull();
    expect(screen.queryByTestId('postpone-slot-3')).toBeNull();
    expect(screen.queryByTestId('postpone-custom')).not.toBeNull();
    await press('postpone-slot-1');
    await waitFor(() => expect(harness!.server.matching('POST', new RegExp(`/commitments/${ITEM_ID}/actions$`))).toHaveLength(1));
    expect(firstRequest(harness, 'POST', new RegExp(`/commitments/${ITEM_ID}/actions$`)).body).toMatchObject({
      action: 'postpone', postponedUntil: SLOTS[1]!.startsAt, fromSlot: true, slotToken: SLOTS[1]!.slotToken,
    });
  });

  it('R3.3 enabled loading shows only the loading line before slot discovery settles', async () => {
    harness = await prepare('en', request => request.path === `/api/mobile/commitments/${ITEM_ID}/postpone-slots`
      ? new Promise<RouteReply>(() => undefined)
      : undefined);
    await showDetails(harness);
    await press('details-postpone');

    await waitFor(() => expect(screen.queryByTestId('postpone-slots-loading')).not.toBeNull());
    for (const preset of PRESETS) expect(screen.queryByTestId(`postpone-${preset}`)).toBeNull();
  });

  it('R3.3 custom time stays available and its existing action never sends slot fields', async () => {
    harness = await prepare('en', request => request.path === `/api/mobile/commitments/${ITEM_ID}/postpone-slots`
      ? { status: 200, body: { success: true, complete: true, slots: SLOTS } }
      : undefined);
    await showDetails(harness);
    await press('details-postpone');
    await waitFor(() => expect(screen.queryByTestId('postpone-slot-0')).not.toBeNull());
    await press('postpone-custom');
    await waitFor(() => expect(screen.queryByTestId('postpone-custom-confirm')).not.toBeNull());
    await press('postpone-custom-confirm');

    await waitFor(() => expect(harness!.server.matching('POST', new RegExp(`/commitments/${ITEM_ID}/actions$`))).toHaveLength(1));
    const body = firstRequest(harness, 'POST', new RegExp(`/commitments/${ITEM_ID}/actions$`)).body;
    expect(body).toMatchObject({ action: 'postpone' });
    expect(body).not.toHaveProperty('fromSlot');
    expect(body).not.toHaveProperty('slotToken');
  });

  it.each([
    ['incomplete', { status: 200, body: { success: true, complete: false, slots: [] } }],
    ['error', { status: 503, body: { success: false, error: 'unavailable', reason: 'unavailable' } }],
  ])('R3.3 %s slot discovery falls back to the unchanged presets', async (_case, reply) => {
    harness = await prepare('en', request => request.path === `/api/mobile/commitments/${ITEM_ID}/postpone-slots` ? reply : undefined);
    await showDetails(harness);
    await press('details-postpone');

    await waitFor(() => expect(screen.queryByTestId('postpone-oneHour')).not.toBeNull());
    for (const preset of PRESETS) expect(screen.queryByTestId(`postpone-${preset}`)).not.toBeNull();
    expect(screen.queryAllByTestId(/^postpone-slot-\d+$/)).toHaveLength(0);
    expect(harness!.server.matching('GET', /\/capabilities\/m4b$/)).not.toHaveLength(0);
    expect(harness!.server.matching('GET', /\/postpone-slots$/)).toHaveLength(1);
  });

  it.each(['slot_taken', 'slot_unverified', 'slot_stale'] as const)(
    'R3.3 %s shows the problem and redraws the fresh slots',
    async (error) => {
      const fresh = [{ ...SLOTS[2]!, slotToken: `fresh-${error}` }];
      harness = await prepare('en', request => {
        if (request.path === `/api/mobile/commitments/${ITEM_ID}/postpone-slots`) {
          return { status: 200, body: { success: true, complete: true, slots: SLOTS } };
        }
        if (request.path === `/api/mobile/commitments/${ITEM_ID}/actions`) {
          return { status: 409, body: { success: false, error, complete: true, slots: fresh } };
        }
        return undefined;
      });
      await showDetails(harness);
      await press('details-postpone');
      await waitFor(() => expect(screen.queryByTestId('postpone-slot-0')).not.toBeNull());
      await press('postpone-slot-0');

      await waitFor(() => expect(screen.queryByTestId('postpone-slot-problem')).not.toBeNull());
      expect(screen.getByTestId('postpone-slot-0')).toHaveTextContent('18:00', { exact: false });
    },
  );

  it('R3.3 a 409 without a fresh slot keeps the problem above all four presets', async () => {
    harness = await prepare('en', request => {
      if (request.path === `/api/mobile/commitments/${ITEM_ID}/postpone-slots`) {
        return { status: 200, body: { success: true, complete: true, slots: SLOTS } };
      }
      if (request.path === `/api/mobile/commitments/${ITEM_ID}/actions`) {
        return { status: 409, body: { success: false, error: 'slot_taken', complete: true, slots: [] } };
      }
      return undefined;
    });
    await showDetails(harness);
    await press('details-postpone');
    await waitFor(() => expect(screen.queryByTestId('postpone-slot-0')).not.toBeNull());
    await press('postpone-slot-0');

    await waitFor(() => expect(screen.queryByTestId('postpone-slot-problem')).not.toBeNull());
    for (const preset of PRESETS) expect(screen.queryByTestId(`postpone-${preset}`)).not.toBeNull();
  });
});
