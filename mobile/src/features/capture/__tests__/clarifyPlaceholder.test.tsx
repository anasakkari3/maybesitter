/**
 * The clarify box asks for what the question asks for (chat UAT 2026-09-30):
 * «أي يوم؟» came with «أو اكتب وقت» under it.
 */
import React from 'react';
import { afterEach, describe, expect, it } from '@jest/globals';
import { cleanup, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { AppProvider } from '../../../state/AppContext';
import { ClarifySheet } from '../ClarifySheet';
import type { CaptureProposalItem } from '../../../api/schemas/capture';
import en from '../../../i18n/locales/en.json';
import ar from '../../../i18n/locales/ar.json';
import he from '../../../i18n/locales/he.json';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

afterEach(async () => {
  await cleanup();
});

function asking(questionKey: 'ask_day' | 'ask_time'): CaptureProposalItem {
  return {
    itemId: 'item-a',
    title: 'Meeting with Sara',
    resolvedTime: null,
    needsClarification: true,
    clarification: {
      questionId: `q-${questionKey}`,
      field: questionKey === 'ask_day' ? 'which_day' : 'time',
      questionKey,
      params: questionKey === 'ask_day' ? { title: 'Meeting with Sara', time: '09:00' } : { title: 'Meeting with Sara' },
      options: [],
      allowFreeText: true,
    },
  } as unknown as CaptureProposalItem;
}

async function show(item: CaptureProposalItem) {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <ClarifySheet item={item} position={1} total={1} busy={false} onAnswer={() => {}} onSkip={() => {}} />
      </AppProvider>
    </SafeAreaProvider>,
  );
}

describe('the clarify box placeholder', () => {
  it('a day question asks for a day', async () => {
    await show(asking('ask_day'));
    expect(screen.getByTestId('clarify-free-text').props.placeholder).toBe(en.orTypeDay);
  });

  it('a time question still asks for a time', async () => {
    await show(asking('ask_time'));
    expect(screen.getByTestId('clarify-free-text').props.placeholder).toBe(en.orTypeTime);
  });

  it('every language says "a day" in its own words', () => {
    expect(ar.orTypeDay).toBe('أو اكتب يوم');
    expect(he.orTypeDay).toBe('או להקליד יום');
    for (const bundle of [en, ar, he]) expect(bundle.orTypeDay).not.toBe(bundle.orTypeTime);
  });
});
