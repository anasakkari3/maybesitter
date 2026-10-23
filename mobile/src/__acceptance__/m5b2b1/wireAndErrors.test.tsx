import React from 'react';
import { Pressable, Text } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import {
  answerIntelligenceQuestion,
  decideIntelligenceSuggestion,
} from '../../api/endpoints/intelligence';
import {
  intelligenceGenerateSchema,
  intelligenceInboxSchema,
  suggestionSchema,
} from '../../api/schemas/intelligence';
import {
  NOW,
  Providers,
  SUGGESTION_ID,
  generated,
  inbox,
  initialState,
  memory,
  prepare,
  suggestion,
  teardown,
  type M5bHarness,
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

function SuggestionErrorProbe({ action }: { action: Action }) {
  const [name, setName] = React.useState('');
  const run = async () => {
    try {
      if (action === 'answer') await answerIntelligenceQuestion(SUGGESTION_ID, 'My answer');
      else await decideIntelligenceSuggestion(SUGGESTION_ID, action);
    } catch (cause) {
      setName(cause instanceof Error ? cause.constructor.name : 'non-error');
    }
  };
  return <>
    <Pressable testID="gate-run-suggestion-action" onPress={() => void run()} />
    <Text testID="gate-suggestion-error-name">{name}</Text>
  </>;
}

describe('M5b-2b-1 wire and typed refusal contracts', () => {
  it('R3 preserves at most three content-free memoryBasis ids on a suggestion', () => {
    const wire = suggestion(SUGGESTION_ID, { memoryIds: ['m1', 'm2', 'm3'] });
    const parsed = suggestionSchema.parse(wire) as unknown as Record<string, unknown>;

    expect(parsed.memoryBasis).toEqual([
      { memoryId: 'm1' },
      { memoryId: 'm2' },
      { memoryId: 'm3' },
    ]);
    expect(parsed.memoryBasis).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ content: expect.anything() }),
    ]));
  });

  it('R13-001 preserves the envelope basisMode on inbox', () => {
    const wire = inbox([suggestion()], { basisMode: 'on_basis' });
    const parsed = intelligenceInboxSchema.parse(wire) as unknown as Record<string, unknown>;
    expect(parsed.basisMode).toBe(wire.basisMode);
  });

  it('R13-001 preserves the envelope basisMode on generate', () => {
    const wire = generated([suggestion()], { basisMode: 'on_nobasis' });
    const parsed = intelligenceGenerateSchema.parse(wire) as unknown as Record<string, unknown>;
    expect(parsed.basisMode).toBe(wire.basisMode);
  });

  it('R14-002 parity: an off envelope has neither basisMode nor memoryBasis', () => {
    const wire = inbox([suggestion()]);
    const parsed = intelligenceInboxSchema.parse(wire) as unknown as {
      basisMode?: unknown;
      suggestions: Record<string, unknown>[];
    };

    expect(parsed).not.toHaveProperty('basisMode');
    expect(parsed.suggestions[0]).not.toHaveProperty('memoryBasis');
  });

  it.each<Action>(['accept', 'dismiss', 'answer'])('R4-003 maps %s 404 suggestion_unavailable to SuggestionUnavailableError', async action => {
    const handler: RouteHandler = request => {
      if (request.path.includes(`/intelligence/suggestions/${SUGGESTION_ID}`) && request.method === 'POST') {
        return {
          status: 404,
          body: { success: false, error: 'not_found', reason: 'suggestion_unavailable' },
        };
      }
      return undefined;
    };
    harness = await prepare('en', initialState({ memoryItems: [memory('m1')] }), handler);
    await render(
      <Providers harness={harness}>
        <SuggestionErrorProbe action={action} />
      </Providers>,
    );

    await fireEvent.press(screen.getByTestId('gate-run-suggestion-action'));
    await waitFor(() => expect(screen.getByTestId('gate-suggestion-error-name')).toHaveTextContent('SuggestionUnavailableError'));
    const request = harness.server.requests.find(candidate => candidate.path.includes(`/intelligence/suggestions/${SUGGESTION_ID}`));
    expect(request).toMatchObject({
      method: 'POST',
      path: action === 'answer'
        ? `/api/mobile/intelligence/suggestions/${SUGGESTION_ID}/answer`
        : `/api/mobile/intelligence/suggestions/${SUGGESTION_ID}`,
      body: action === 'answer' ? { answer: 'My answer' } : { decision: action },
    });
  });
});
