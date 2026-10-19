/**
 * The fail-closed rules Codex's inspection of Task A asked for
 * (M5A-A-REV-001/004/006/008), each held by a test that turns red when its
 * guard is removed.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { deviceCalendar } from '../deviceCalendar';
import { rejoinPhone } from '../m5aCalendar';
import {
  ACCOUNT_A,
  NOW,
  initialState,
  prepare,
  showBusyHost,
  teardown,
  waitForRequest,
  type M5aHarness,
} from '../../../__acceptance__/m5a/harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

const UID = ACCOUNT_A.uid;
const ENROLLED = `calendar.choiceEnrolledAt.v1:${UID}`;
const INCLUDED = `calendar.includedCalendarIds.v1:${UID}`;
const PENDING = `calendar.pendingSelection.v1:${UID}`;
const REMOVED = `calendar.phoneRemoved.v1:${UID}`;

let harness: M5aHarness | undefined;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  jest.spyOn(deviceCalendar, 'getAccess').mockResolvedValue('granted');
  jest.spyOn(deviceCalendar, 'listEventCalendars').mockResolvedValue([]);
  jest.spyOn(deviceCalendar, 'listWritableCalendars').mockResolvedValue([]);
  jest.spyOn(deviceCalendar, 'fetchBusyBlocks').mockResolvedValue([]);
});

afterEach(async () => {
  await teardown(harness);
  harness = undefined;
  jest.useRealTimers();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await act(async () => { await jest.advanceTimersByTimeAsync(50); });
}

describe('an enrolled pass reads nothing it cannot vouch for', () => {
  it('REV-001: a failed choice probe stops the pass before any native read', async () => {
    harness = await prepare('en', initialState(), request => {
      if (request.path === '/api/mobile/calendar/choice' && request.method === 'GET') {
        return { status: 503, body: { success: false, error: 'unavailable', reason: 'unavailable' } };
      }
      return undefined;
    });
    await AsyncStorage.multiSet([[ENROLLED, '2030-03-20T08:00:00.000Z'], [INCLUDED, JSON.stringify(['work'])]]);
    await showBusyHost(harness);
    await waitForRequest(harness, 'GET', /\/calendar\/choice$/);
    await settle();
    expect(deviceCalendar.fetchBusyBlocks).not.toHaveBeenCalled();
  });

  it('REV-004: an unreadable secure store stops the pass before any native read', async () => {
    harness = await prepare();
    jest.spyOn(SecureStore, 'getItemAsync').mockRejectedValue(new Error('keychain locked'));
    await AsyncStorage.multiSet([[ENROLLED, '2030-03-20T08:00:00.000Z'], [INCLUDED, JSON.stringify(['work'])]]);
    await showBusyHost(harness);
    await settle();
    expect(deviceCalendar.fetchBusyBlocks).not.toHaveBeenCalled();
  });

  const CORRUPT: [string, [string, string][]][] = [
    ['an inclusion list with a non-id member', [[ENROLLED, '2030-03-20T08:00:00.000Z'], [INCLUDED, JSON.stringify(['work', 7])]]],
    ['a corrupt enrolment marker', [[ENROLLED, 'corrupt'], [INCLUDED, JSON.stringify(['work'])]]],
  ];
  it.each(CORRUPT)('REV-006: %s blocks the read', async (_label, entries) => {
    harness = await prepare();
    await AsyncStorage.multiSet(entries);
    await showBusyHost(harness);
    await settle();
    expect(deviceCalendar.fetchBusyBlocks).not.toHaveBeenCalled();
  });

  it('REV-006: a pending record whose operation contradicts its list sends nothing', async () => {
    harness = await prepare();
    await AsyncStorage.multiSet([
      [ENROLLED, '2030-03-20T08:00:00.000Z'],
      // A digest that matches its (empty) list, so only the operation check can refuse it.
      [PENDING, JSON.stringify({
        intentId: 'i-1', included: [], selectionDigest: createHash('sha256').update('[]').digest('hex'),
        operation: 'upload', epoch: null, opId: null,
      })],
    ]);
    await showBusyHost(harness);
    await settle();
    expect(harness.server.matching('POST', /\/calendar\/busy\/intent$/)).toHaveLength(0);
    expect(deviceCalendar.fetchBusyBlocks).not.toHaveBeenCalled();
  });
});

describe('rejoin', () => {
  it('REV-008: a retry after a lost response reuses the persisted tuple, and taps never overlap', async () => {
    let first = true;
    harness = await prepare('en', initialState({ sourceStatus: 'revoked' }), request => {
      if (request.path === '/api/mobile/calendar/busy/register' && first) {
        first = false;
        return { status: 503, body: { success: false, error: 'unavailable', reason: 'unavailable' } };
      }
      return undefined;
    });
    await AsyncStorage.multiSet([[ENROLLED, '2030-03-20T08:00:00.000Z'], [REMOVED, '2030-03-29T08:00:00.000Z']]);
    // Mounted so the signed-in account is known to the request layer.
    await showBusyHost(harness);
    await settle();
    const [a, b] = await act(async () => Promise.all([rejoinPhone(UID), rejoinPhone(UID)]));
    expect([a, b]).toEqual([false, false]);
    expect(await act(async () => rejoinPhone(UID))).toBe(true);
    const bodies = harness.server.matching('POST', /\/calendar\/busy\/register$/)
      .map(request => (request.body as { sourceInstallationId: string }).sourceInstallationId);
    expect(bodies).toHaveLength(2);
    expect(new Set(bodies).size).toBe(1);
    await waitFor(async () => expect(await AsyncStorage.getItem(REMOVED)).toBeNull());
  });
});
