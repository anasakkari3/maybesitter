import { BackHandler } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { resetAuthForTests } from '../../api/auth';
import { ProposalChangedError } from '../../api/errors';
import * as captureEndpoints from '../../api/endpoints/capture';
import * as seedEndpoints from '../../api/endpoints/seeds';
import type { CaptureConfirmation, CaptureProposal } from '../../api/schemas/capture';
import {
  ACCOUNT_B,
  ITEM_ID,
  PROPOSAL_ID,
  SEED_ID,
  START,
  answerFor,
  changeText,
  commitmentProposal,
  deferred,
  lastCall,
  openCapture,
  prepareRoot,
  press,
  say,
  seedProposal,
  showProposal,
  type RootHarness,
} from './harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'UTC' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

let harness: RootHarness;

beforeEach(async () => { harness = await prepareRoot('en'); });

afterEach(async () => {
  await cleanup();
  harness.client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  await AsyncStorage.clear();
});

function questionProposal(revision = 7): CaptureProposal {
  return commitmentProposal({
    revision,
    status: 'needs_clarification',
    items: [{
      itemId: ITEM_ID,
      title: 'Call Dana',
      resolvedTime: null,
      resolvedDate: '2030-01-08',
      needsClarification: true,
      clarification: {
        questionId: 'question-time',
        field: 'time',
        questionKey: 'ask_time',
        params: { title: 'Call Dana' },
        options: [{
          optionId: 'morning',
          labelKey: 'morning',
          labelParams: {},
          value: { localDate: '2030-01-08', localTime: '09:00' },
        }],
        allowFreeText: true,
      },
    }],
  });
}

async function leaveAndReopen(closeID: string): Promise<void> {
  await press(closeID);
  await waitFor(() => expect(screen.queryByTestId('tab-capture')).not.toBeNull());
  expect(screen.queryByTestId('capture-discard')).toBeNull();
  await press('tab-capture');
  await waitFor(() => expect(screen.queryByTestId('capture-input')).not.toBeNull());
}

async function askStartOver(): Promise<void> {
  await press('chat-more');
  await press('chat-menu-start-over');
  await waitFor(() => expect(screen.queryByTestId('capture-discard')).not.toBeNull());
}

describe('M2b capture navigation persistence', () => {
  it('A5 Back with a proposal closes the task and reopening restores the same summary', async () => {
    await showProposal(harness);
    await leaveAndReopen('capture-cancel');
    expect(screen.queryByTestId('understood-line-1')).not.toBeNull();
    expect(screen.queryByText('Call Dana tomorrow')).not.toBeNull();
  });

  it('A5 Back after a question-only reply closes without discarding and reopening restores the turns', async () => {
    jest.spyOn(captureEndpoints, 'chatCapture').mockResolvedValue(answerFor(null, 'What is on tomorrow?') as never);
    await openCapture(harness);
    await say('What is on tomorrow?');
    await waitFor(() => expect(screen.queryByTestId('chat-turn-assistant-1')).not.toBeNull());
    await leaveAndReopen('capture-cancel');
    expect(screen.queryByText('What is on tomorrow?')).not.toBeNull();
  });

  it('A5 Back with an unsent draft closes without a discard prompt and reopening restores the draft', async () => {
    await openCapture(harness);
    await changeText('capture-input', 'Unsent private draft');
    await leaveAndReopen('capture-cancel');
    expect(screen.getByTestId('capture-input').props.value).toBe('Unsent private draft');
  });

  it.each(['proposal', 'question-only', 'draft'] as const)('A5 start over in the %s state always asks before resetting', async (state) => {
    if (state === 'proposal') {
      await showProposal(harness);
    } else if (state === 'question-only') {
      jest.spyOn(captureEndpoints, 'chatCapture').mockResolvedValue(answerFor(null, 'Question only') as never);
      await openCapture(harness);
      await say('Question only');
      await waitFor(() => expect(screen.queryByTestId('chat-turn-assistant-1')).not.toBeNull());
    } else {
      await openCapture(harness);
      await changeText('capture-input', 'Unsent draft');
      // The baseline already asks when Start over is used directly on a draft.
      // First exercising the new close-and-restore lifecycle keeps this a red
      // acceptance test on the foundation while still proving the draft state.
      await leaveAndReopen('capture-cancel');
    }

    await askStartOver();
    await press('capture-discard-confirm');
    await waitFor(() => expect(screen.getByTestId('capture-input').props.value).toBe(''));
    expect(screen.queryByTestId('understood-line-1')).toBeNull();
  });

  it('A5 hardware Back closes and preserves an unsent draft just like the header control', async () => {
    let handlers: (() => boolean | null | undefined)[] = [];
    jest.spyOn(BackHandler, 'addEventListener').mockImplementation(((_event: string, handler: () => boolean) => {
      handlers.push(handler);
      return { remove: () => { handlers = handlers.filter((candidate) => candidate !== handler); } };
    }) as never);
    await openCapture(harness);
    await changeText('capture-input', 'Hardware draft');
    await act(async () => {
      for (const handler of [...handlers].reverse()) if (handler()) break;
    });
    await waitFor(() => expect(screen.queryByTestId('tab-capture')).not.toBeNull());
    await press('tab-capture');
    expect(screen.getByTestId('capture-input').props.value).toBe('Hardware draft');
  });
});

describe('M2b revision on every write', () => {
  it('A8 confirm sends the viewed revision', async () => {
    const confirm = jest.spyOn(captureEndpoints, 'confirmCapture').mockResolvedValue({
      success: true, replayed: false, persisted: [], failed: [],
    } as never);
    await showProposal(harness);
    await press('understood-confirm');
    await press('review-confirm');
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(lastCall(confirm)).toEqual(expect.objectContaining({ proposalId: PROPOSAL_ID, revision: 7 }));
  });

  it('A8 clarify sends the viewed revision', async () => {
    const initial = questionProposal();
    const settled = commitmentProposal({ revision: 8 });
    const clarify = jest.spyOn(captureEndpoints, 'clarifyCapture').mockResolvedValue(settled as never);
    await showProposal(harness, initial);
    await press('understood-confirm');
    await press('clarify-option-morning');
    await waitFor(() => expect(clarify).toHaveBeenCalledTimes(1));
    expect(lastCall(clarify)).toEqual(expect.objectContaining({ proposalId: PROPOSAL_ID, revision: 7 }));
  });

  it('A8 seed keep sends the viewed revision', async () => {
    const keep = jest.spyOn(seedEndpoints, 'keepProposedSeed').mockResolvedValue({
      item: { id: 'kept-seed', kind: 'idea', summary: 'Learn pottery', status: 'active', createdAt: START, updatedAt: START },
    } as never);
    await showProposal(harness, seedProposal());
    await press('understood-confirm');
    await press(`review-seed-keep-${SEED_ID}`);
    await waitFor(() => expect(keep).toHaveBeenCalledTimes(1));
    expect(lastCall(keep)).toEqual({ proposalId: PROPOSAL_ID, seedItemId: SEED_ID, revision: 7 });
  });

  it('A8 confirm conflict adopts the current proposal and does not resubmit', async () => {
    const current = commitmentProposal({
      revision: 8,
      items: [{ ...commitmentProposal().items[0]!, title: 'Current confirm title' }],
      understood: [{ kind: 'commitment', itemId: ITEM_ID, text: 'Current confirm title' }],
    });
    const confirm = jest.spyOn(captureEndpoints, 'confirmCapture').mockRejectedValue(
      new ProposalChangedError({ kind: 'proposal', proposal: current, state: 'open' }),
    );
    await showProposal(harness);
    await press('understood-confirm');
    await press('review-confirm');
    await waitFor(() => expect(screen.queryByText('Current confirm title')).not.toBeNull());
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('A8 clarify conflict adopts the current proposal and asks for review again without resubmitting', async () => {
    const initial = questionProposal();
    const current = commitmentProposal({
      revision: 8,
      items: [{ ...commitmentProposal().items[0]!, title: 'Current clarify title' }],
      understood: [{ kind: 'commitment', itemId: ITEM_ID, text: 'Current clarify title' }],
    });
    const clarify = jest.spyOn(captureEndpoints, 'clarifyCapture').mockRejectedValue(
      new ProposalChangedError({ kind: 'proposal', proposal: current, state: 'open' }),
    );
    await showProposal(harness, initial);
    await press('understood-confirm');
    await press('clarify-option-morning');
    await waitFor(() => expect(screen.queryByText('Current clarify title')).not.toBeNull());
    expect(clarify).toHaveBeenCalledTimes(1);
  });

  it('A8 seed keep conflict adopts the current proposal and does not mark the stale seed kept', async () => {
    const current = seedProposal('idea', {
      revision: 8,
      seeds: [{ seedItemId: SEED_ID, kind: 'idea', summary: 'Current seed words' }],
      understood: [{ kind: 'idea', seedItemId: SEED_ID, text: 'Current seed words' }],
    });
    const keep = jest.spyOn(seedEndpoints, 'keepProposedSeed').mockRejectedValue(
      new ProposalChangedError({ kind: 'proposal', proposal: current, state: 'open' }),
    );
    await showProposal(harness, seedProposal());
    await press('understood-confirm');
    await press(`review-seed-keep-${SEED_ID}`);
    await waitFor(() => expect(screen.queryByText('Current seed words')).not.toBeNull());
    expect(screen.queryByTestId(`review-seed-kept-${SEED_ID}`)).toBeNull();
    expect(keep).toHaveBeenCalledTimes(1);
  });
});

describe('M2b account isolation', () => {
  it('A9 chat: an account A answer resolving after account B signs in is dropped', async () => {
    const pending = deferred<ReturnType<typeof answerFor>>();
    jest.spyOn(captureEndpoints, 'chatCapture').mockReturnValue(pending.promise as never);
    await openCapture(harness);
    await changeText('capture-input', 'Account A message');
    await press('capture-analyze');
    await act(async () => { harness.repository.emit(ACCOUNT_B); });
    await act(async () => { pending.resolve(answerFor(commitmentProposal(), 'Account A message')); });

    await waitFor(() => expect(screen.queryByText('Call Dana tomorrow')).toBeNull());
    expect(screen.getByTestId('capture-input').props.value).toBe('');
  });

  it('A9 structured edit: an account A edit answer resolving under account B is dropped', async () => {
    const initial = commitmentProposal();
    const pending = deferred<ReturnType<typeof answerFor>>();
    const chat = jest.spyOn(captureEndpoints, 'chatCapture')
      .mockResolvedValueOnce(answerFor(initial) as never)
      .mockReturnValueOnce(pending.promise as never);
    await openCapture(harness);
    await say('First message');
    await press('understood-edit-1');
    await changeText('understood-edit-text', 'Account A edited title');
    await press('understood-edit-save');
    await waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    await act(async () => { harness.repository.emit(ACCOUNT_B); });
    const updated = commitmentProposal({
      revision: 8,
      items: [{ ...initial.items[0]!, title: 'Account A edited title' }],
      understood: [{ kind: 'commitment', itemId: ITEM_ID, text: 'Account A edited title' }],
    });
    await act(async () => { pending.resolve(answerFor(updated)); });
    expect(screen.queryByText('Account A edited title')).toBeNull();
  });

  it('A9 clarify: an account A clarification resolving under account B is dropped', async () => {
    const pending = deferred<CaptureProposal>();
    jest.spyOn(captureEndpoints, 'clarifyCapture').mockReturnValue(pending.promise as never);
    await showProposal(harness, questionProposal());
    await press('understood-confirm');
    await press('clarify-option-morning');
    await act(async () => { harness.repository.emit(ACCOUNT_B); });
    const settled = commitmentProposal({
      revision: 8,
      items: [{ ...commitmentProposal().items[0]!, title: 'Account A clarified title' }],
    });
    await act(async () => { pending.resolve(settled); });
    expect(screen.queryByText('Account A clarified title')).toBeNull();
  });

  it('A9 confirm: an account A confirmation resolving under account B is dropped', async () => {
    const pending = deferred<CaptureConfirmation>();
    jest.spyOn(captureEndpoints, 'confirmCapture').mockReturnValue(pending.promise as never);
    await showProposal(harness);
    await press('understood-confirm');
    await press('review-confirm');
    await act(async () => { harness.repository.emit(ACCOUNT_B); });
    await act(async () => {
      pending.resolve({
        success: true,
        replayed: false,
        persisted: [{ itemId: ITEM_ID, commitmentId: 'account-a-saved', title: 'Account A saved title', resolvedTime: START }],
        failed: [],
      });
    });
    expect(screen.queryByText('Account A saved title')).toBeNull();
    expect(screen.queryByTestId('chat-saved-1')).toBeNull();
  });
});

describe('M2b structured edits preserve composer state', () => {
  it('A10 successful structured edit keeps the unsent composer draft', async () => {
    const initial = commitmentProposal();
    const updated = commitmentProposal({
      revision: 8,
      items: [{ ...initial.items[0]!, title: 'Edited summary words' }],
      understood: [{ kind: 'commitment', itemId: ITEM_ID, text: 'Edited summary words' }],
    });
    jest.spyOn(captureEndpoints, 'chatCapture')
      .mockResolvedValueOnce(answerFor(initial) as never)
      .mockResolvedValueOnce(answerFor(updated) as never);
    await openCapture(harness);
    await say('First message');
    await changeText('capture-input', 'Unsent follow-up');
    await press('understood-edit-1');
    await changeText('understood-edit-text', 'Edited summary words');
    await press('understood-edit-save');
    await waitFor(() => expect(screen.queryByText('Edited summary words')).not.toBeNull());
    expect(screen.getByTestId('capture-input').props.value).toBe('Unsent follow-up');
  });
});
