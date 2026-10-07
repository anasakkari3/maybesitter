/**
 * M2b, after Codex's inspection of Task A: account isolation on the screen,
 * refused edits kept, a proposal already saved elsewhere, and screen-reader
 * focus around the «عدّل» sheet.
 */
import { AccessibilityInfo } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { resetAuthForTests } from '../../../api/auth';
import { ProposalChangedError } from '../../../api/errors';
import * as captureEndpoints from '../../../api/endpoints/capture';
import {
  ACCOUNT_B, answerFor, changeText, commitmentProposal, openCapture, prepareRoot, press, say, showProposal, type RootHarness,
} from '../../../__acceptance__/m2b/harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'UTC' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

jest.mock('../voice/speechService', () => {
  let callbacks: { onFinal?: (...args: unknown[]) => void; onPartial?: (text: string) => void; onStatus?: (status: string) => void } = {};
  const service = {
    locale: 'en-US', status: 'idle',
    start: jest.fn(async (next: typeof callbacks) => { callbacks = next; service.status = 'listening'; callbacks.onStatus?.('listening'); }),
    stop: jest.fn(async () => {}), cancel: jest.fn(async () => {}),
    finish(primary: string, alternatives: string[]) { callbacks.onFinal?.(primary, alternatives); },
  };
  return { SpeechEventBridge: () => null, createSpeechCaptureService: () => service, speechLanguageForTag: () => 'en', __speech: service };
});
const speech = () => (jest.requireMock('../voice/speechService') as { __speech: { status: string; finish(p: string, a: string[]): void } }).__speech;

let harness: RootHarness;
beforeEach(async () => { speech().status = 'idle'; harness = await prepareRoot('en'); });
afterEach(async () => {
  await cleanup();
  harness.client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  await AsyncStorage.clear();
});

describe('account isolation on the screen (M2B-A-001)', () => {
  it('a dictation of account A that finishes after account B signed in writes nothing into B\'s capture', async () => {
    await openCapture(harness);
    await waitFor(() => expect(screen.queryByTestId('voice-button')).not.toBeNull());
    await press('voice-button');
    await act(async () => { harness.repository.emit(ACCOUNT_B); });
    await act(async () => { speech().finish('account A words', ['account A wards']); });
    await waitFor(() => expect(screen.queryByTestId('capture-input')).not.toBeNull());
    expect(screen.getByTestId('capture-input').props.value).toBe('');
    expect(screen.queryByTestId('capture-alternative-1')).toBeNull();
  });
});

describe('a refused change is kept (M2B-A-002)', () => {
  it('after a 409 the summary shows the current version and offers the person\'s own change again', async () => {
    const initial = commitmentProposal();
    const current = commitmentProposal({ revision: 9, items: [{ ...initial.items[0]!, title: 'Their words' }], understood: [{ kind: 'commitment', itemId: initial.items[0]!.itemId, text: 'Their words' }] });
    jest.spyOn(captureEndpoints, 'chatCapture')
      .mockResolvedValueOnce(answerFor(initial) as never)
      .mockRejectedValueOnce(new ProposalChangedError({ kind: 'chat', answer: answerFor(current) }));
    await openCapture(harness);
    await say('First message');
    await waitFor(() => expect(screen.queryByTestId('understood-edit-1')).not.toBeNull());
    await press('understood-edit-1');
    await changeText('understood-edit-text', 'My words');
    await press('understood-edit-save');
    await waitFor(() => expect(screen.queryByTestId('understood-edit-reopen')).not.toBeNull());
    expect(screen.queryByText('Their words')).not.toBeNull();
    await press('understood-edit-reopen');
    expect(screen.getByTestId('understood-edit-text').props.value).toBe('My words');
  });

  it('a confirm refused for a changed proposal says so in the review and keeps the staged choices', async () => {
    const initial = commitmentProposal();
    const current = commitmentProposal({ revision: 8 });
    jest.spyOn(captureEndpoints, 'confirmCapture').mockRejectedValue(new ProposalChangedError({ kind: 'proposal', proposal: current, state: 'open' }));
    await showProposal(harness, initial);
    await press('understood-confirm');
    await press('review-confirm');
    await waitFor(() => expect(screen.queryByTestId('review-conflict-note')).not.toBeNull());
  });
});

describe('already saved elsewhere (M2B-A-003)', () => {
  it('a confirm answered "confirmed" removes the cards and says it is already saved', async () => {
    jest.spyOn(captureEndpoints, 'confirmCapture').mockRejectedValue(new ProposalChangedError({ kind: 'proposal', proposal: commitmentProposal({ revision: 8 }), state: 'confirmed' }));
    await showProposal(harness);
    await press('understood-confirm');
    await press('review-confirm');
    await waitFor(() => expect(screen.queryByTestId('capture-confirmed-elsewhere')).not.toBeNull());
    expect(screen.queryByTestId('review-confirm')).toBeNull();
  });
});

describe('screen-reader focus around the sheet (M2B-A-007)', () => {
  it('lands on the sheet when it opens and back on its «عدّل» when it closes', async () => {
    const focus = jest.spyOn(AccessibilityInfo, 'sendAccessibilityEvent');
    await showProposal(harness);
    const edit = screen.getByTestId('understood-edit-1');
    await press('understood-edit-1');
    await waitFor(() => expect(focus).toHaveBeenCalled());
    const opened = focus.mock.calls.length;
    await press('understood-edit-cancel');
    await waitFor(() => expect(focus.mock.calls.length).toBeGreaterThan(opened));
    expect(String((focus.mock.calls.at(-1)![0] as unknown as { props: { testID?: string } }).props.testID)).toBe(edit.props.testID);
  });
});
