import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import {
  answerIntelligenceQuestion,
  decideIntelligenceSuggestion,
  generateIntelligenceSuggestions,
  getIntelligenceInbox,
  reviewIntelligenceObservation,
} from '../../api/endpoints/intelligence';
import { intelligenceInboxSchema } from '../../api/schemas/intelligence';
import { strings } from '../../i18n/strings';
import {
  NOW,
  Providers,
  ZONE,
  inbox,
  initialState,
  panelHandler,
  panelState,
  prepare,
  readdMarker,
  teardown,
  type M5bHarness,
} from './harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

const CLIENT_FEATURE_HEADER = 'X-MaybeSitter-Client-Features';
const CLIENT_FEATURE_VALUE = 'readd,gmail-scan-daily-limit,gmail-scan-bulk';

let harness: M5bHarness | undefined;

beforeEach(() => {
  process.env.TZ = ZONE;
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(async () => {
  await teardown(harness);
  harness = undefined;
  jest.useRealTimers();
});

function HeaderProbe() {
  const [done, setDone] = React.useState(false);
  const run = async () => {
    await Promise.all([
      getIntelligenceInbox(),
      generateIntelligenceSuggestions(),
      getIntelligenceInbox(),
      generateIntelligenceSuggestions(),
    ]);
    setDone(true);
  };
  return <View>
    <Pressable testID="gate-readd-headers" onPress={() => void run()} />
    <Text testID="gate-readd-headers-done">{String(done)}</Text>
  </View>;
}

// GA-M5B2B2-AMEND-1 (Claude review): REV-005 refuses re-add-backed rows in
// claims without the header, so every claim request must carry it too.
function ClaimHeaderProbe() {
  const [done, setDone] = React.useState(false);
  const run = async () => {
    await Promise.allSettled([
      reviewIntelligenceObservation('claim-obs', 'confirmed'),
      decideIntelligenceSuggestion('claim-s', 'accept'),
      decideIntelligenceSuggestion('claim-s', 'dismiss'),
      answerIntelligenceQuestion('claim-q', 'yes'),
    ]);
    setDone(true);
  };
  return <View>
    <Pressable testID="gate-readd-claim-headers" onPress={() => void run()} />
    <Text testID="gate-readd-claim-headers-done">{String(done)}</Text>
  </View>;
}

function headerValue(headers: HeadersInit | undefined, name: string): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers)) {
    return headers.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? null;
  }
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1] ?? null;
}

describe('M5b-2b-2 wire contracts', () => {
  it('R3 App preserves the optional re-add projection through the real inbox schema', () => {
    const parsed = intelligenceInboxSchema.parse(inbox([
      readdMarker('wire', 'pending', 'completed'),
    ]));
    const observation = parsed.observations[0] as unknown as Record<string, unknown>;
    expect(observation.readd).toEqual({ after: 'completed', title: 'Title wire' });
  });

  it('R3 App parity parses a pre-2b-2 inbox with the additive field absent', () => {
    const legacy = readdMarker('legacy') as Record<string, unknown>;
    delete legacy.readd;
    const parsed = intelligenceInboxSchema.parse(inbox([legacy]));
    expect(parsed.observations[0]).not.toHaveProperty('readd');
  });

  it('R3 App exposes every frozen re-add copy key in ar, en, and he', () => {
    const keys = [
      'm5bLearnedReaddedAfterDrop',
      'm5bLearnedReaddedAfterDone',
      'm5bLearnedGuess',
      'm5bLearnedRightA11y',
    ];
    for (const language of ['ar', 'en', 'he'] as const) {
      const locale = strings[language] as unknown as Record<string, unknown>;
      for (const key of keys) expect(locale[key]).toEqual(expect.any(String));
    }
  });

  it('REV-002 / REV-005 every inbox and generate request carries the re-add capability header', async () => {
    const state = panelState();
    harness = await prepare('en', initialState(), panelHandler(state));
    await render(<Providers harness={harness}><HeaderProbe /></Providers>);

    await fireEvent.press(screen.getByTestId('gate-readd-headers'));
    await waitFor(() => expect(screen.getByTestId('gate-readd-headers-done')).toHaveTextContent('true'));

    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>;
    const intelligenceCalls = fetchMock.mock.calls.filter(([input]) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const path = new URL(raw, 'http://localhost').pathname;
      return path === '/api/mobile/intelligence' || path === '/api/mobile/intelligence/generate';
    });
    expect(intelligenceCalls).toHaveLength(4);
    for (const [, init] of intelligenceCalls) {
      expect(headerValue(init?.headers, CLIENT_FEATURE_HEADER)).toBe(CLIENT_FEATURE_VALUE);
    }
  });

  it('REV-005 GA-M5B2B2-AMEND-1 every review, decision and answer request carries the re-add capability header', async () => {
    const state = panelState({ observations: [readdMarker('claim-obs')] });
    harness = await prepare('en', initialState(), panelHandler(state));
    await render(<Providers harness={harness}><ClaimHeaderProbe /></Providers>);

    await fireEvent.press(screen.getByTestId('gate-readd-claim-headers'));
    await waitFor(() => expect(screen.getByTestId('gate-readd-claim-headers-done')).toHaveTextContent('true'));

    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>;
    const claimCalls = fetchMock.mock.calls.filter(([input]) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const path = new URL(raw, 'http://localhost').pathname;
      return /^\/api\/mobile\/intelligence\/(observations|suggestions)\//.test(path);
    });
    expect(claimCalls).toHaveLength(4);
    for (const [, init] of claimCalls) {
      expect(headerValue(init?.headers, CLIENT_FEATURE_HEADER)).toBe(CLIENT_FEATURE_VALUE);
    }
  });
});
