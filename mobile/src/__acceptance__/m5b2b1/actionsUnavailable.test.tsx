import React from 'react';
import { AccessibilityInfo } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import * as apiErrors from '../../api/errors';
import {
  MEMORY_A,
  NOW,
  SUGGESTION_ID,
  inbox,
  initialState,
  memory,
  noRetries,
  prepare,
  showPanel,
  suggestion,
  teardown,
  type M5bHarness,
  type RecordedRequest,
  type RouteHandler,
} from './harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

let harness: M5bHarness | undefined;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(async () => {
  await teardown(harness);
  harness = undefined;
  jest.useRealTimers();
});

type Action = 'accept' | 'dismiss' | 'answer';

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).join('');
  if (React.isValidElement<{ children?: unknown }>(value)) return textOf(value.props.children);
  return '';
}

async function pressAction(action: Action): Promise<void> {
  const card = screen.getByTestId(`intelligence-suggestion-${SUGGESTION_ID}`);
  const buttons = within(card).getAllByRole('button');
  if (action === 'answer') {
    await fireEvent.changeText(screen.getByTestId(`intelligence-answer-${SUGGESTION_ID}`), 'My answer');
    await fireEvent.press(buttons[0]!);
  } else {
    await fireEvent.press(buttons[action === 'accept' ? 0 : 1]!);
  }
}

function actionRequest(action: Action, requests: RecordedRequest[]): RecordedRequest | undefined {
  const path = action === 'answer'
    ? `/api/mobile/intelligence/suggestions/${SUGGESTION_ID}/answer`
    : `/api/mobile/intelligence/suggestions/${SUGGESTION_ID}`;
  return requests.find(request => request.method === 'POST' && request.path === path);
}

describe('M5b-2b-1 unavailable suggestion actions', () => {
  it.each<Action>(['accept', 'dismiss', 'answer'])('R4-003 %s refreshes an unavailable card away without a visible or announced action error', async action => {
    expect(typeof (apiErrors as unknown as Record<string, unknown>).SuggestionUnavailableError).toBe('function');
    let rows = [suggestion(SUGGESTION_ID, {
      kind: action === 'answer' ? 'question' : 'action',
      memoryIds: [MEMORY_A],
    })];
    let mode: 'on_basis' | 'on_nobasis' = 'on_basis';
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    const handler: RouteHandler = request => {
      if (request.method === 'GET' && request.path === '/api/mobile/intelligence') {
        return { status: 200, body: inbox(rows, { basisMode: mode }) };
      }
      if (request.method === 'POST' && request.path.includes(`/intelligence/suggestions/${SUGGESTION_ID}`)) {
        rows = [];
        mode = 'on_nobasis';
        return {
          status: 404,
          body: { success: false, error: 'not_found', reason: 'suggestion_unavailable' },
        };
      }
      return undefined;
    };
    harness = await prepare('en', initialState({ memoryItems: [memory(MEMORY_A)] }), handler);
    noRetries(harness);
    await showPanel(harness);
    await waitFor(() => expect(screen.queryByTestId(`intelligence-suggestion-${SUGGESTION_ID}`)).not.toBeNull());

    await pressAction(action);
    await waitFor(() => expect(screen.queryByTestId(`intelligence-suggestion-${SUGGESTION_ID}`)).toBeNull());

    expect(actionRequest(action, harness.server.requests)).toMatchObject({
      method: 'POST',
      body: action === 'answer' ? { answer: 'My answer' } : { decision: action },
    });
    expect(screen.queryByTestId('m5b-suggestion-action-error')).toBeNull();
    expect(textOf(screen.getByTestId('intelligence-status').props.children)).toBe('');
    expect(announce).not.toHaveBeenCalled();
    expect(harness.server.matching('GET', /^\/api\/mobile\/intelligence$/)).toHaveLength(2);
  });

  it('R4-003 an ordinary 404 keeps the card and exposes the normal action error', async () => {
    const row = suggestion(SUGGESTION_ID, { memoryIds: [MEMORY_A] });
    const handler: RouteHandler = request => {
      if (request.method === 'GET' && request.path === '/api/mobile/intelligence') {
        return { status: 200, body: inbox([row], { basisMode: 'on_basis' }) };
      }
      if (request.method === 'POST' && request.path === `/api/mobile/intelligence/suggestions/${SUGGESTION_ID}`) {
        return { status: 404, body: { success: false, error: 'not_found', reason: 'not_found' } };
      }
      return undefined;
    };
    harness = await prepare('en', initialState({ memoryItems: [memory(MEMORY_A)] }), handler);
    noRetries(harness);
    await showPanel(harness);
    await waitFor(() => expect(screen.queryByTestId(`intelligence-suggestion-${SUGGESTION_ID}`)).not.toBeNull());

    await pressAction('accept');
    await waitFor(() => expect(screen.queryByTestId('m5b-suggestion-action-error')).not.toBeNull());
    expect(screen.queryByTestId(`intelligence-suggestion-${SUGGESTION_ID}`)).not.toBeNull();
  });
});
