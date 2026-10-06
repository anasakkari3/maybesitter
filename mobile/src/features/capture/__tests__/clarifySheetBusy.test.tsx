/**
 * M2B-A-R4-REVIEW-003: while another proposal write is on its way, every way
 * to answer the question waits — the options, the person's own words and
 * «تخطّى» too, which sends the no-time answer where there is one.
 */
import React from 'react';
import { afterEach, expect, it, jest } from '@jest/globals';
import { cleanup, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { AppProvider } from '../../../state/AppContext';
import { ClarifySheet } from '../ClarifySheet';
import type { CaptureProposalItem } from '../../../api/schemas/capture';

const METRICS: Metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
afterEach(async () => { await cleanup(); });

const item = {
  itemId: 'item-a', title: 'Call Dana', resolvedTime: null, needsClarification: true,
  clarification: {
    questionId: 'q-time', field: 'time', questionKey: 'ask_time', params: { title: 'Call Dana' },
    options: [
      { optionId: 'evening', labelKey: 'evening', labelParams: {}, value: { localTime: '19:00', localDate: '2099-01-02' } },
      { optionId: 'none', labelKey: 'noTime', labelParams: {}, value: {} },
    ],
    allowFreeText: true,
  },
} as unknown as CaptureProposalItem;

it.each([true, false])('busy=%s: «تخطّى» and the free text wait exactly when the options do', async (busy) => {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <ClarifySheet item={item} position={1} total={1} busy={busy} onAnswer={jest.fn()} onSkip={jest.fn()} />
      </AppProvider>
    </SafeAreaProvider>,
  );
  const expectState = (el: ReturnType<typeof screen.getByTestId>) => (busy ? expect(el).toBeDisabled() : expect(el).not.toBeDisabled());
  expectState(screen.getByTestId('clarify-skip'));
  expectState(screen.getByTestId('clarify-free-text'));
});
