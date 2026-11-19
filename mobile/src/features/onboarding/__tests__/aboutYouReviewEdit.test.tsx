/**
 * QA CA1.6: clearing an edit (or typing the same words back) hid the «Suggested
 * by AI» label and showed an empty row, while the server stored the original
 * model sentence with model provenance. The row says what is saved.
 */
import React from 'react';
import { afterEach, expect, it, jest } from '@jest/globals';
import { cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider } from '../../../state/AppContext';
import { AboutYouReviewStep } from '../AboutYouReviewStep';

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const SUGGESTIONS = [{ kind: 'fact', content: 'Software engineer', confidence: 0.8 }] as never;

afterEach(async () => {
  await cleanup();
  jest.restoreAllMocks();
});

async function show() {
  const onSave = jest.fn();
  await render(
    <SafeAreaProvider initialMetrics={metrics}>
      <AppProvider>
        <AboutYouReviewStep suggestions={SUGGESTIONS} onSave={onSave} onBack={() => {}} />
      </AppProvider>
    </SafeAreaProvider>,
  );
  return onSave;
}

for (const [name, typed] of [['cleared', ''], ['typed back unchanged', 'Software engineer '], ['spaces only', '   ']] as const) {
  it(`an edit ${name} keeps the AI label and the original sentence, as saved`, async () => {
    await show();
    await fireEvent.press(screen.getByTestId('about-review-edit-open-0'));
    await fireEvent.changeText(screen.getByTestId('about-review-edit-0'), typed);
    await fireEvent.press(screen.getByTestId('about-review-edit-open-0'));
    expect(screen.getByTestId('about-review-label-0')).toBeTruthy();
    expect(screen.getByTestId('about-review-content-0')).toHaveTextContent(/Software engineer/);
  });
}

it('a real rewrite drops the label and shows the new words', async () => {
  await show();
  await fireEvent.press(screen.getByTestId('about-review-edit-open-0'));
  await fireEvent.changeText(screen.getByTestId('about-review-edit-0'), 'Backend developer');
  await fireEvent.press(screen.getByTestId('about-review-edit-open-0'));
  expect(screen.queryByTestId('about-review-label-0')).toBeNull();
  expect(screen.getByTestId('about-review-content-0')).toHaveTextContent(/Backend developer/);
});
