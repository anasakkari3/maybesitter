/**
 * «يتابع لك» suggestion cards (QA CA7.3, CA7.4, NA7.1).
 *
 * The server refuses an edited title under 4 characters and an answer under
 * 2. The card says so before the press, the press is off, and nothing is sent.
 * A refusal that still happens is said on the card itself.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import {
  NOW,
  SUGGESTION_ID,
  inbox,
  initialState,
  noRetries,
  prepare,
  showPanel,
  suggestion,
  teardown,
  type M5bHarness,
  type RouteHandler,
} from '../../../__acceptance__/m5b2b1/harness';
import en from '../../../i18n/locales/en.json';

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

async function open(kind: 'action' | 'question', post: RouteHandler = () => undefined) {
  const row = suggestion(SUGGESTION_ID, { kind });
  const handler: RouteHandler = request => {
    if (request.method === 'GET' && request.path === '/api/mobile/intelligence') {
      return { status: 200, body: inbox([row], { basisMode: 'on_nobasis' }) };
    }
    return post(request);
  };
  harness = await prepare('en', initialState({}), handler);
  noRetries(harness);
  await showPanel(harness);
  await waitFor(() => expect(screen.queryByTestId(`intelligence-suggestion-${SUGGESTION_ID}`)).not.toBeNull());
  return within(screen.getByTestId(`intelligence-suggestion-${SUGGESTION_ID}`));
}

const posts = () => harness!.server.requests.filter(request => request.method === 'POST');

describe('short input', () => {
  it('CA7.3: an edited title under 4 characters is said and not sent', async () => {
    const card = await open('action');
    await fireEvent.changeText(screen.getByTestId(`intelligence-edit-${SUGGESTION_ID}`), 'Gym');
    expect(screen.getByTestId(`intelligence-edit-short-${SUGGESTION_ID}`)).toBeTruthy();
    expect(screen.getByText(en.xIntelligenceTitleTooShort)).toBeTruthy();
    const accept = card.getAllByRole('button')[0]!;
    expect(accept.props.accessibilityState?.disabled).toBe(true);
    await fireEvent.press(accept);
    expect(posts()).toHaveLength(0);

    await fireEvent.changeText(screen.getByTestId(`intelligence-edit-${SUGGESTION_ID}`), 'Gym class');
    expect(screen.queryByTestId(`intelligence-edit-short-${SUGGESTION_ID}`)).toBeNull();
    expect(card.getAllByRole('button')[0]!.props.accessibilityState?.disabled).toBe(false);
  });

  it('CA7.4: a one-character answer is said and not sent', async () => {
    const card = await open('question');
    await fireEvent.changeText(screen.getByTestId(`intelligence-answer-${SUGGESTION_ID}`), '3');
    expect(screen.getByTestId(`intelligence-answer-short-${SUGGESTION_ID}`)).toBeTruthy();
    expect(screen.getByText(en.xIntelligenceAnswerTooShort)).toBeTruthy();
    expect(card.getAllByRole('button')[0]!.props.accessibilityState?.disabled).toBe(true);
    await fireEvent.changeText(screen.getByTestId(`intelligence-answer-${SUGGESTION_ID}`), '3 times');
    expect(screen.queryByTestId(`intelligence-answer-short-${SUGGESTION_ID}`)).toBeNull();
    expect(card.getAllByRole('button')[0]!.props.accessibilityState?.disabled).toBe(false);
  });
});

describe('a refusal on the card (NA7.1)', () => {
  it('is said under the card that was pressed', async () => {
    const card = await open('action', request => request.method === 'POST'
      ? { status: 400, body: { success: false, error: 'request refused', reason: 'invalid_title' } }
      : undefined);
    await fireEvent.press(card.getAllByRole('button')[0]!);
    await waitFor(() => expect(screen.getByTestId(`intelligence-card-error-${SUGGESTION_ID}`)).toBeTruthy());
    expect(screen.getByText(en.xIntelligenceTitleTooShort)).toBeTruthy();
  });
});
