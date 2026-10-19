import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { screen, waitFor } from '@testing-library/react-native';
import { CalendarFeedsScreen } from '../../features/calendarFeeds/CalendarFeedsScreen';
import {
  NOW,
  deadline,
  feed,
  instant,
  prepare,
  press,
  show,
  teardown,
  type M4bHarness,
  type RecordedRequest,
} from './harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

const CLASH = {
  title: 'Morning workout', startsAt: instant('2030-03-30', '08:30'), endsAt: instant('2030-03-30', '09:30'), kind: 'commitment',
};
const BUSY = {
  title: null, startsAt: instant('2030-03-30', '08:45'), endsAt: instant('2030-03-30', '09:15'), kind: 'calendar_busy',
};

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

async function showRows(rows: unknown[], handler?: (request: RecordedRequest) => { status: number; body: unknown } | undefined): Promise<void> {
  harness = await prepare('en', request => {
    if (request.path === '/api/mobile/calendar/ics' && request.method === 'GET') {
      return { status: 200, body: { success: true, feeds: [feed()], deadlines: rows } };
    }
    return handler?.(request);
  });
  await show(harness, <CalendarFeedsScreen onBack={() => undefined} />);
  await waitFor(() => expect(harness!.server.matching('GET', /\/calendar\/ics$/)).toHaveLength(1));
}

describe('R1.4 and R1.5 ICS holds', () => {
  it('R1.5 a clash-held deadline shows every clash and keeps accept and dismiss', async () => {
    await showRows([deadline({
      itemKey: 'clash', decisionVersion: 'decision-v1', held: { reason: 'clash', clashes: [CLASH, BUSY] },
    })]);

    await waitFor(() => expect(screen.queryByTestId('ics-held-clash')).not.toBeNull());
    expect(screen.queryByTestId('ics-accept-clash')).not.toBeNull();
    expect(screen.queryByTestId('ics-skip-clash')).not.toBeNull();
  });

  it('R1.5 unknown coverage says so while the person still has accept and dismiss', async () => {
    await showRows([deadline({
      itemKey: 'unknown', decisionVersion: 'decision-v1', held: { reason: 'unknown', clashes: [] },
    })]);

    await waitFor(() => expect(screen.queryByTestId('ics-held-unknown-unknown')).not.toBeNull());
    expect(screen.queryByTestId('ics-accept-unknown')).not.toBeNull();
    expect(screen.queryByTestId('ics-skip-unknown')).not.toBeNull();
  });

  it('M4B-R5-002 accept sends the decision version of the rendered row', async () => {
    await showRows(
      [deadline({ itemKey: 'accept', decisionVersion: 'decision-v1', held: { reason: 'clash', clashes: [CLASH] } })],
      request => request.path.endsWith('/deadlines/accept') && request.method === 'POST'
        ? { status: 200, body: { success: true, deadline: deadline({ itemKey: 'accept', state: 'accepted', commitmentId: 'c-1', decisionVersion: 'decision-v2' }), replayed: false } }
        : undefined,
    );
    await waitFor(() => expect(screen.queryByTestId('ics-accept-accept')).not.toBeNull());
    await press('ics-accept-accept');

    await waitFor(() => expect(harness!.server.matching('POST', /\/deadlines\/accept$/)).toHaveLength(1));
    expect(harness!.server.matching('POST', /\/deadlines\/accept$/)[0]!.body).toEqual({
      action: 'accept', expectedDecisionVersion: 'decision-v1',
    });
  });

  it('M4B-R5-002 apply_move sends its decision version', async () => {
    await showRows(
      [deadline({
        itemKey: 'move', state: 'accepted', commitmentId: 'c-1', notice: 'moved',
        proposedDueAt: instant('2030-03-31', '11:00'), proposedAllDay: false,
        proposedClashes: [CLASH], decisionVersion: 'move-v3',
      })],
      request => request.path.endsWith('/deadlines/move') && request.method === 'POST'
        ? { status: 200, body: { success: true, deadline: deadline({ itemKey: 'move', state: 'accepted', commitmentId: 'c-1', decisionVersion: 'move-v4' }), replayed: false } }
        : undefined,
    );
    await waitFor(() => expect(screen.queryByTestId('ics-apply-move-move')).not.toBeNull());
    await press('ics-apply-move-move');

    await waitFor(() => expect(harness!.server.matching('POST', /\/deadlines\/move$/)).toHaveLength(1));
    expect(harness!.server.matching('POST', /\/deadlines\/move$/)[0]!.body).toEqual({
      action: 'apply_move', expectedDecisionVersion: 'move-v3',
    });
  });

  it('M4B-R5-002 item_changed shows the notice and the returned current row', async () => {
    const current = deadline({
      itemKey: 'changed', title: 'Submit revised essay', dueAt: instant('2030-03-31', '10:00'),
      decisionVersion: 'decision-v2', held: { reason: 'clash', clashes: [BUSY] },
    });
    await showRows(
      [deadline({ itemKey: 'changed', decisionVersion: 'decision-v1', held: { reason: 'clash', clashes: [CLASH] } })],
      request => request.path.endsWith('/deadlines/changed') && request.method === 'POST'
        ? { status: 409, body: { success: false, error: 'item_changed', row: current } }
        : undefined,
    );
    await waitFor(() => expect(screen.queryByTestId('ics-accept-changed')).not.toBeNull());
    await press('ics-accept-changed');

    await waitFor(() => expect(screen.queryByTestId('ics-item-changed')).not.toBeNull());
    expect(screen.queryByTestId('ics-deadline-changed')).not.toBeNull();
    expect(screen.queryByTestId('ics-held-changed')).not.toBeNull();
  });
});
