/**
 * The one suggestion, and the five answers to it (UC-2.R3 #173).
 *
 * Three claims carry this card: it never implies it has acted, it offers only
 * the answers the server said were available, and one tap is one decision.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import { NextStepCard } from '../NextStepCard';
import { ConflictError, ForbiddenError } from '../../../api/errors';
import en from '../../../i18n/locales/en.json';
import ar from '../../../i18n/locales/ar.json';

import * as nextStepEndpoints from '../../../api/endpoints/nextStep';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const USER: AuthUser = {
  uid: 'ns-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

function recommendation(over: Record<string, unknown> = {}) {
  return {
    version: 'v1',
    proposalId: 'p-1',
    state: 'ready',
    locale: 'en',
    primaryStep: { commitmentId: 'c-1', title: 'Send the report to Sami' },
    explanation: {
      summary: 'Based on overdue.',
      evidenceLabels: ['overdue'],
      evidenceCodes: [{ code: 'overdue' }, { code: 'importance', params: { level: 'high' } }],
      sensitiveInferenceUsed: false,
    },
    availableActions: ['accept', 'edit', 'defer', 'dismiss', 'done'],
    persistence: { occurred: false, confirmationRequired: true },
    ...over,
  };
}

function response(over: Record<string, unknown> = {}) {
  return { success: true, participantId: USER.uid, recommendation: recommendation(over) };
}

beforeEach(() => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
});

afterEach(() => {
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

async function show(data: unknown = response()) {
  const get = jest.spyOn(nextStepEndpoints, 'getNextStep');
  if (data instanceof Error) get.mockRejectedValue(data);
  else get.mockResolvedValue(data as never);
  const view = await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}><NextStepCard /></QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId('query-loading')).toBeNull());
  return view;
}

function mockDecision() {
  return jest.spyOn(nextStepEndpoints, 'recordNextStepDecision').mockResolvedValue({
    success: true,
    replayed: false,
    participantId: USER.uid,
    outcome: {
      status: 'recorded_without_penalty',
      decision: { version: 'v1', proposalId: 'p-1', decision: 'accept', decidedAt: '2026-09-13T09:00:00.000Z' },
      persisted: false,
    },
  } as never);
}

describe('it never implies it has acted', () => {
  it('says so, every time, unconditionally', async () => {
    await show();
    expect(screen.getByTestId('next-step-note').props.children).toBe(en.suggestionNote);
  });

  it('still says so once the why is open', async () => {
    await show();
    await fireEvent.press(screen.getByTestId('next-step-why-toggle'));
    await waitFor(() => expect(screen.queryByTestId('next-step-why')).not.toBeNull());
    expect(screen.queryByTestId('next-step-note')).not.toBeNull();
  });
});

describe('the why', () => {
  it('is folded away until asked for', async () => {
    await show();
    expect(screen.queryByTestId('next-step-why')).toBeNull();
    await fireEvent.press(screen.getByTestId('next-step-why-toggle'));
    await waitFor(() => expect(screen.queryByTestId('next-step-why')).not.toBeNull());
  });

  it('is in the user’s language, not the server’s', async () => {
    // The response carries `evidenceLabels: ['overdue']` in English. The card
    // must read `evidenceCodes` and never fall back to that.
    await show();
    await fireEvent.press(screen.getByTestId('next-step-why-toggle'));
    await waitFor(() => expect(screen.queryByTestId('next-step-why')).not.toBeNull());
    expect(screen.queryByText(`· ${en.evidenceOverdue}`)).not.toBeNull();
    expect(screen.queryByText('· overdue')).toBeNull();
    expect(screen.queryByText('Based on overdue.')).toBeNull();
  });

  it('promises no sensitive inference was used', async () => {
    await show();
    await fireEvent.press(screen.getByTestId('next-step-why-toggle'));
    await waitFor(() => expect(screen.queryByTestId('next-step-no-sensitive')).not.toBeNull());
  });

  it('is not offered at all when there is nothing to say', async () => {
    await show(response({ explanation: { summary: '', evidenceLabels: [], evidenceCodes: [], sensitiveInferenceUsed: false } }));
    expect(screen.queryByTestId('next-step-why-toggle')).toBeNull();
  });

  it('is not offered when every code is one this build cannot say', async () => {
    await show(response({ explanation: {
      summary: 'x', evidenceLabels: ['x'], sensitiveInferenceUsed: false,
      evidenceCodes: [{ code: 'invented_next_sprint' }],
    } }));
    expect(screen.queryByTestId('next-step-why-toggle')).toBeNull();
  });
});

describe('only the answers the server offered', () => {
  it('shows all five when all five are available', async () => {
    await show();
    for (const action of ['accept', 'edit', 'defer', 'dismiss', 'done']) {
      expect(screen.queryByTestId(`next-step-${action}`)).not.toBeNull();
    }
  });

  it('shows only the subset, and does not grey out the rest', async () => {
    await show(response({ availableActions: ['accept', 'dismiss'] }));
    expect(screen.queryByTestId('next-step-accept')).not.toBeNull();
    expect(screen.queryByTestId('next-step-dismiss')).not.toBeNull();
    // Absent, not disabled: `decideNextStep` refuses an action outside the
    // list, so a rendered one could only ever fail.
    expect(screen.queryByTestId('next-step-defer')).toBeNull();
    expect(screen.queryByTestId('next-step-edit')).toBeNull();
  });
});

describe('one tap is one decision', () => {
  it('sends the whole proposal, not just its id', async () => {
    const decide = mockDecision();
    await show();
    await fireEvent.press(screen.getByTestId('next-step-accept'));
    await waitFor(() => expect(decide).toHaveBeenCalled());
    const sent = decide.mock.calls[0]![0] as { proposal: { proposalId: string }; idempotencyKey: string };
    expect(sent.proposal.proposalId).toBe('p-1');
    expect(sent.proposal).toHaveProperty('primaryStep');
    expect(sent.idempotencyKey).toBeTruthy();
  });

  it('sends one request for a double tap', async () => {
    const decide = mockDecision();
    await show();
    const button = screen.getByTestId('next-step-accept');
    // Both presses inside one `act`, so they land in the same frame: at that
    // point `isPending` is state that has not propagated, and only the ref
    // guard can stop the second. Un-awaited `fireEvent` calls would leave work
    // pending past the end of this test and break the next one.
    await act(async () => {
      fireEvent.press(button);
      fireEvent.press(button);
    });
    await waitFor(() => expect(decide).toHaveBeenCalled());
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it('sends the edited title with an edit, and only after the user confirms it', async () => {
    const decide = mockDecision();
    await show();
    await fireEvent.press(screen.getByTestId('next-step-edit'));
    await waitFor(() => expect(screen.queryByTestId('next-step-edit-input')).not.toBeNull());
    // Opening the editor is not a decision.
    expect(decide).not.toHaveBeenCalled();

    await fireEvent.changeText(screen.getByTestId('next-step-edit-input'), 'Send the report');
    await fireEvent.press(screen.getByTestId('next-step-edit-save'));
    await waitFor(() => expect(decide).toHaveBeenCalled());
    const sent = decide.mock.calls[0]![0] as { decision: string; editedTitle?: string };
    expect(sent.decision).toBe('edit');
    expect(sent.editedTitle).toBe('Send the report');
  });

  it('cannot send an empty edit', async () => {
    await show();
    await fireEvent.press(screen.getByTestId('next-step-edit'));
    await waitFor(() => expect(screen.queryByTestId('next-step-edit-input')).not.toBeNull());
    await fireEvent.changeText(screen.getByTestId('next-step-edit-input'), '   ');
    expect(screen.getByTestId('next-step-edit-save').props.accessibilityState.disabled).toBe(true);
  });
});

describe('when the proposal has moved', () => {
  it('says so, and does not resubmit', async () => {
    const decide = jest.spyOn(nextStepEndpoints, 'recordNextStepDecision')
      .mockRejectedValue(new ConflictError('stale'));
    await show();
    await fireEvent.press(screen.getByTestId('next-step-accept'));
    await waitFor(() => expect(screen.queryByTestId('next-step-stale')).not.toBeNull());
    expect(screen.queryByText(en.nextStepStale)).not.toBeNull();
    // Applying a decision the user made about a different suggestion is worse
    // than asking again.
    expect(decide).toHaveBeenCalledTimes(1);
  });
});

describe('the states that are not a suggestion', () => {
  it('says there is nothing to suggest', async () => {
    await show(response({ state: 'empty', primaryStep: null, explanation: null, availableActions: [] }));
    expect(screen.queryByTestId('next-step-empty')).not.toBeNull();
    expect(screen.queryByTestId('next-step-accept')).toBeNull();
  });

  it('says what is missing when there is too little to go on', async () => {
    await show(response({ state: 'insufficient_evidence', primaryStep: null, explanation: null, availableActions: [] }));
    expect(screen.queryByTestId('next-step-insufficient_evidence')).not.toBeNull();
    expect(screen.queryByText(en.nextStepThinBody)).not.toBeNull();
  });

  it('explains a 403 rather than offering a pointless retry', async () => {
    await show(new ForbiddenError('no', 'consent_required'));
    expect(screen.queryByText(en.errorsConsentRequired)).not.toBeNull();
    expect(screen.queryByText(en.errorsRetry)).toBeNull();
  });
});

describe('Arabic', () => {
  it('has every string this card needs', async () => {
    for (const key of ['nextStepLabel', 'suggestionNote', 'nextStepWhy', 'nextStepNoSensitive',
      'nextStepEmptyTitle', 'nextStepEmptyBody', 'nextStepThinTitle', 'nextStepThinBody',
      'nextStepStale', 'nextStepAccept', 'nextStepEdit', 'nextStepDefer', 'nextStepDismiss',
      'nextStepDone', 'nextStepEditTitle', 'nextStepEditSave']) {
      const value = (ar as unknown as Record<string, string>)[key];
      expect(typeof value === 'string' && value.trim().length > 0).toBe(true);
    }
  });
});
