/** M2a · Task A · criterion 3 — one range presentation on every review surface. */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { CaptureProposal, CaptureProposalItem } from '../../api/schemas/capture';
import { captureProposalSchema } from '../../api/schemas/capture';
import * as captureEndpoints from '../../api/endpoints/capture';
import { resetAuthForTests } from '../../api/auth';
import { strings } from '../../i18n/strings';
import { chatServer } from '../../testing/captureChat';
import { chatItemPresentation } from '../../features/capture/chatPresentation';
import { openCapture, plain, prepareRoot, say, textOf, type RootHarness } from './harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'UTC' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

function clockPart(value: string): string | null {
  return plain(value).match(/\d{2}:\d{2}(?:\u2013\d{2}:\d{2})?/)?.[0] ?? null;
}

const BASE: CaptureProposalItem = {
  itemId: 'range-item', title: 'Workshop', resolvedTime: '2030-01-07T16:00:00.000Z',
  endTime: '2030-01-07T20:00:00.000Z', needsClarification: false,
};

let harness: RootHarness;

beforeEach(async () => { harness = await prepareRoot('en'); });

afterEach(async () => {
  await cleanup();
  harness.client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  await AsyncStorage.clear();
});

describe('range presentation', () => {
  it('A3 range helper: a moved range keeps its duration, rolls over midnight, clears with time, and ignores an invalid end', () => {
    const moved = chatItemPresentation(BASE, { localDateTime: '2030-01-08T18:00' }, 'en', 'UTC', strings.en);
    const rollover = chatItemPresentation(
      { ...BASE, resolvedTime: '2030-01-07T22:00:00.000Z', endTime: '2030-01-08T01:00:00.000Z' },
      { localDateTime: '2030-01-08T23:00' }, 'en', 'UTC', strings.en,
    );
    const cleared = chatItemPresentation(BASE, { localDateTime: '' }, 'en', 'UTC', strings.en);
    const invalidProposal = captureProposalSchema.parse({
      version: 'v1', proposalId: 'invalid-end', status: 'proposed', seeds: [],
      items: [{ ...BASE, endTime: 'not-an-instant' }],
    });
    const invalid = chatItemPresentation(invalidProposal.items[0]!, undefined, 'en', 'UTC', strings.en);
    const missing = chatItemPresentation({ ...BASE, endTime: undefined }, undefined, 'en', 'UTC', strings.en);

    expect([
      clockPart(moved.subtitle),
      clockPart(rollover.subtitle),
      clockPart(cleared.subtitle),
      clockPart(invalid.subtitle),
      clockPart(missing.subtitle),
    ]).toEqual(['18:00\u201322:00', '23:00\u201302:00', null, '16:00', '16:00']);
  });

  it('A3 shared range display: a legacy proposal shows 16:00–20:00 in chat cards and Review tools, including checkbox names', async () => {
    const proposal: CaptureProposal = {
      version: 'v1', proposalId: 'legacy-range', status: 'proposed', seeds: [],
      items: [BASE],
    };
    jest.spyOn(captureEndpoints, 'chatCapture').mockImplementation(chatServer(() => proposal) as never);
    await openCapture(harness);
    await say('Workshop from four until eight');
    await waitFor(() => expect(screen.queryByTestId('review-item-range-item')).not.toBeNull());

    const chat = {
      visible: clockPart(textOf('review-when-range-item')),
      spoken: plain(String(screen.getByTestId('review-item-range-item').props.accessibilityLabel)),
    };
    await act(async () => { await fireEvent.press(screen.getByTestId('review-tools')); });
    await waitFor(() => expect(screen.queryByTestId('review-scroll')).not.toBeNull());
    const review = {
      visible: clockPart(textOf('review-when-range-item')),
      spoken: plain(String(screen.getByTestId('review-item-range-item').props.accessibilityLabel)),
    };

    expect({ chat, review }).toEqual({
      chat: { visible: '16:00\u201320:00', spoken: expect.stringContaining('16:00\u201320:00') },
      review: { visible: '16:00\u201320:00', spoken: expect.stringContaining('16:00\u201320:00') },
    });
  });
});
