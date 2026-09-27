/**
 * The saved screen names the day of an all-day deadline (FX3, review I-4).
 *
 * «بدي أدفع فاتورة الكهربا قبل آخر الشهر» confirms as an all-day `due_by`, so
 * the server's `persisted[].resolvedTime` is null — there is no hour. The review
 * card read «لحد <day>» and, one tap later, this screen read «بدون وقت»: the
 * deadline the person said was gone again. The day is on the proposal the
 * capture state still holds, by `itemId`; no contract change.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider } from '../../state/AppContext';
import { SavedScreen } from '../SavedScreen';
import * as captureProvider from '../../features/capture/CaptureProvider';
import { LANGUAGE_STORAGE_KEY } from '../../i18n/language';
import ar from '../../i18n/locales/ar.json';
import proposalFixture from '../../api/__fixtures__/capture.allDayDeadline.json';
import confirmationFixture from '../../api/__fixtures__/capture.allDayDeadlineConfirmation.json';

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

/** `YYYY-MM-DD` in the device's zone, `days` from now. */
function dayKeyIn(days: number): string {
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(Date.now() + days * 86_400_000));
}
const DAY = dayKeyIn(10);

function proposalItem(itemId: string, extra: Record<string, unknown>) {
  return { itemId, title: itemId, resolvedTime: null, needsClarification: false, priority: 'normal', priorityEstimated: true, ...extra };
}

const OWN = {
  proposal: {
    version: 'v1', proposalId: 'p', status: 'proposed', seeds: [],
    items: [
      proposalItem('bill', { resolvedDate: DAY, dateEstimated: false }),
      proposalItem('plain', {}),
    ],
  },
  persisted: [
    { itemId: 'bill', commitmentId: 'c1', title: 'أدفع فاتورة الكهربا', resolvedTime: null },
    { itemId: 'plain', commitmentId: 'c2', title: 'أرتب الخزانة', resolvedTime: null },
  ],
};

async function renderSaved(edits: Record<string, unknown> = {}, data: { proposal: unknown; persisted: unknown } = OWN) {
  jest.spyOn(captureProvider, 'useCaptureFlow').mockReturnValue({
    state: {
      stage: 'saved',
      status: 'saved',
      input: 'task',
      proposal: data.proposal,
      edits,
      persisted: data.persisted,
      failed: [],
      collisions: [],
      undoable: false,
    },
    close: jest.fn(),
    undo: jest.fn(),
  } as never);
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <SavedScreen />
      </AppProvider>
    </SafeAreaProvider>,
  );
}

function textOf(testID: string): string {
  const children = screen.getByTestId(testID).props.children as unknown;
  return Array.isArray(children) ? children.join('') : String(children);
}

beforeEach(async () => {
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'ar');
  await AsyncStorage.setItem('settings.language.chosen', 'true');
});
afterEach(() => { jest.restoreAllMocks(); });

describe('an all-day deadline on the saved screen', () => {
  it('reads «لحد <day>», like the review card, and an item with no day still reads «بدون وقت»', async () => {
    await renderSaved();
    const bill = textOf('saved-when-bill');
    expect(bill.startsWith(ar.reviewDueByDay.split('{day}')[0]!)).toBe(true);
    expect(bill).toContain(String(Number(DAY.slice(8, 10))));
    expect(bill).not.toContain(ar.noTimeYet);
    expect(textOf('saved-when-plain')).toBe(ar.noTimeYet);
  });

  it('reads the day on the real route\'s proposal and confirmation (the recorded fixtures)', async () => {
    // The confirmation must say no hour: a stale fixture holding the midnight
    // (review C-1) would render a time here instead of the day.
    expect(confirmationFixture.persisted[0]!.resolvedTime).toBeNull();
    // Each fixture normalises its ids on its own, so the saved item is joined to
    // the proposal's the way the live pair already is: by the proposal's id.
    const itemId = proposalFixture.items[0]!.itemId;
    const persisted = [{ ...confirmationFixture.persisted[0]!, itemId }];
    await renderSaved({}, { proposal: proposalFixture, persisted });
    const when = textOf(`saved-when-${itemId}`);
    expect(when.startsWith(ar.reviewDueByDay.split('{day}')[0]!)).toBe(true);
    expect(when).toContain(String(Number(proposalFixture.items[0]!.resolvedDate.slice(8, 10))));
  });

  it('says «بدون وقت» when the person cleared the time in review', async () => {
    await renderSaved({ bill: { localDateTime: '' } });
    expect(textOf('saved-when-bill')).toBe(ar.noTimeYet);
  });
});
