/**
 * «في إشي مش مزبوط؟» on the next-step card (QA CA2.5).
 *
 * The outcome line belongs to the proposal it was given for, and a refusal
 * that is not "collection is off" is said, with the panel and the note kept.
 */
import React from 'react';
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { FeedbackFlagButton } from '../FeedbackFlagButton';
import { ForbiddenError, ValidationError } from '../../../api/errors';
import * as feedbackEndpoints from '../../../api/endpoints/feedback';

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
let client: QueryClient;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});

afterEach(async () => {
  await cleanup();
  client.clear();
  jest.restoreAllMocks();
});

function tree(proposalId: string) {
  return (
    <SafeAreaProvider initialMetrics={metrics}>
      <AppProvider>
        <QueryClientProvider client={client}>
          <FeedbackFlagButton proposalId={proposalId} />
        </QueryClientProvider>
      </AppProvider>
    </SafeAreaProvider>
  );
}

it('does not carry proposal A\'s outcome onto proposal B', async () => {
  jest.spyOn(feedbackEndpoints, 'flagAlphaFeedback').mockRejectedValue(new ForbiddenError('feature_disabled', 'feature_disabled'));
  const view = await render(tree('prop-a'));
  await fireEvent.press(screen.getByTestId('next-step-flag'));
  await fireEvent.press(screen.getByTestId('next-step-flag-not_useful'));
  await waitFor(() => expect(screen.getByTestId('next-step-flag-disabled')).toBeTruthy());

  await view.rerender(tree('prop-b'));
  expect(screen.queryByTestId('next-step-flag-disabled')).toBeNull();
  expect(screen.getByTestId('next-step-flag')).toBeTruthy();
});

it('says a refusal other than 403, and keeps the panel and the note', async () => {
  jest.spyOn(feedbackEndpoints, 'flagAlphaFeedback').mockRejectedValue(new ValidationError('request refused'));
  await render(tree('prop-a'));
  await fireEvent.press(screen.getByTestId('next-step-flag'));
  await fireEvent.changeText(screen.getByTestId('next-step-flag-note'), 'it picked the wrong thing');
  await fireEvent.press(screen.getByTestId('next-step-flag-not_useful'));
  await waitFor(() => expect(screen.getByTestId('next-step-flag-error')).toBeTruthy());
  expect(screen.getByTestId('next-step-flag-sheet')).toBeTruthy();
  expect(screen.getByTestId('next-step-flag-note').props.value).toBe('it picked the wrong thing');
});
