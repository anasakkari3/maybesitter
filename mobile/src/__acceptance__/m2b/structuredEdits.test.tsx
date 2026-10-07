import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { resetAuthForTests } from '../../api/auth';
import { ConversationNotFoundError, ProposalChangedError } from '../../api/errors';
import * as captureEndpoints from '../../api/endpoints/capture';
import type { CaptureProposal } from '../../api/schemas/capture';
import {
  CONVERSATION_ID,
  ITEM_ID,
  SEED_ID,
  answerFor,
  changeText,
  commitmentProposal,
  lastCall,
  openCapture,
  prepareRoot,
  press,
  say,
  seedProposal,
  type RootHarness,
} from './harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'UTC' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

type EditTarget = { itemId: string } | { seedItemId: string };
type EditChange = {
  kind?: 'commitment' | 'possible_goal' | 'consideration' | 'idea' | 'waiting_for';
  text?: string;
  time?: { at: string | null; timeZone: string };
  rejectCorrectionIds?: string[];
};
type EditRequest = {
  conversationId: string;
  edit: { proposalId: string; revision: number; target: EditTarget; change: EditChange };
};

let harness: RootHarness;

beforeEach(async () => { harness = await prepareRoot('en'); });

afterEach(async () => {
  await cleanup();
  harness.client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  await AsyncStorage.clear();
});

function installEditServer(initial: CaptureProposal, updated: CaptureProposal) {
  return jest.spyOn(captureEndpoints, 'chatCapture').mockImplementation((async (raw: unknown) => {
    const input = raw as { message?: string; conversationId?: string | null; edit?: unknown };
    return input.edit
      ? answerFor(updated, 'Structured edit', input.conversationId ?? CONVERSATION_ID)
      : answerFor(initial, input.message ?? 'First message', input.conversationId ?? CONVERSATION_ID);
  }) as never);
}

async function show(initial: CaptureProposal): Promise<void> {
  await openCapture(harness);
  await say('First message');
  await waitFor(() => expect(screen.queryByTestId('understood-line-1')).not.toBeNull());
}

async function openStructuredEdit(): Promise<void> {
  await press('understood-edit-1');
  await waitFor(() => expect(screen.queryByTestId('understood-edit-sheet')).not.toBeNull());
}

function editRequest(chat: { mock: { calls: readonly unknown[][] } }): EditRequest {
  return lastCall(chat) as unknown as EditRequest;
}

async function chooseKind(kind: EditChange['kind']): Promise<void> {
  await press(`understood-edit-kind-${kind}`);
}

async function setTime(at: string): Promise<void> {
  await act(async () => {
    await fireEvent(screen.getByTestId('understood-edit-time'), 'valueChange', at);
  });
}

describe('M2b structured summary edits', () => {
  it.each<['commitment' | 'idea', NonNullable<EditChange['kind']>]>([
    ['commitment', 'possible_goal'],
    ['commitment', 'consideration'],
    ['commitment', 'idea'],
    ['commitment', 'waiting_for'],
    ['idea', 'commitment'],
  ])('A3 \u00ab\u0639\u062f\u0651\u0644\u00bb kind: %s to %s sends the selected direction with revision and target', async (source, target) => { // «عدّل»
    const initial = source === 'commitment' ? commitmentProposal() : seedProposal(source);
    const updated = target === 'commitment'
      ? commitmentProposal({
        revision: 8,
        items: [{ ...commitmentProposal().items[0]!, itemId: SEED_ID, title: 'Learn pottery' }],
        understood: [{ kind: 'commitment', itemId: SEED_ID, text: 'Learn pottery' }],
      })
      : seedProposal(target, {
        revision: 8,
        seeds: [{ seedItemId: ITEM_ID, kind: target, summary: 'Call Dana' }],
        understood: [{ kind: target, seedItemId: ITEM_ID, text: 'Call Dana tomorrow' }],
      });
    const chat = installEditServer(initial, updated);
    await show(initial);
    await openStructuredEdit();
    await chooseKind(target);
    await press('understood-edit-save');
    await waitFor(() => expect(chat).toHaveBeenCalledTimes(2));

    expect(editRequest(chat)).toEqual(expect.objectContaining({
      conversationId: CONVERSATION_ID,
      edit: expect.objectContaining({
        proposalId: initial.proposalId,
        revision: 7,
        target: source === 'commitment' ? { itemId: ITEM_ID } : { seedItemId: SEED_ID },
        change: { kind: target },
      }),
    }));
  });

  it('A3 \u00ab\u0639\u062f\u0651\u0644\u00bb words: one save sends only the changed words and redraws the same proposal', async () => { // «عدّل»
    const initial = commitmentProposal();
    const updated = commitmentProposal({
      revision: 8,
      items: [{ ...initial.items[0]!, title: 'Call Rami' }],
      understood: [{ kind: 'commitment', itemId: ITEM_ID, text: 'Call Rami' }],
    });
    const chat = installEditServer(initial, updated);
    await show(initial);
    await openStructuredEdit();
    await changeText('understood-edit-text', 'Call Rami');
    await press('understood-edit-save');
    await waitFor(() => expect(screen.queryByText('Call Rami')).not.toBeNull());

    expect(editRequest(chat).edit).toEqual({
      proposalId: initial.proposalId,
      revision: 7,
      target: { itemId: ITEM_ID },
      change: { text: 'Call Rami' },
    });
    expect(screen.queryByTestId('understood-line-1')).not.toBeNull();
  });

  it.each<[string, string]>([
    ['set', '2030-01-09T12:15:00.000Z'],
    ['move range', '2030-01-10T14:00:00.000Z'],
  ])('A3 \u00ab\u0639\u062f\u0651\u0644\u00bb time %s: sends an absolute UTC patch and keeps the ranged duration in the answer', async (_case, at) => { // «عدّل»
    const initial = commitmentProposal();
    const duration = Date.parse(initial.items[0]!.endTime!) - Date.parse(initial.items[0]!.resolvedTime!);
    const updated = commitmentProposal({
      revision: 8,
      items: [{ ...initial.items[0]!, resolvedTime: at, endTime: new Date(Date.parse(at) + duration).toISOString() }],
    });
    const chat = installEditServer(initial, updated);
    await show(initial);
    await openStructuredEdit();
    await setTime(at);
    await press('understood-edit-save');
    await waitFor(() => expect(chat).toHaveBeenCalledTimes(2));

    expect(editRequest(chat).edit.change).toEqual({ time: { at, timeZone: 'UTC' } });
    expect(Date.parse(updated.items[0]!.endTime!) - Date.parse(updated.items[0]!.resolvedTime!)).toBe(duration);
  });

  it('A3 \u00ab\u0639\u062f\u0651\u0644\u00bb time clear: sends time.at null in the displayed zone', async () => { // «عدّل»
    const initial = commitmentProposal();
    const updated = commitmentProposal({
      revision: 8,
      items: [{ ...initial.items[0]!, resolvedTime: null, endTime: undefined }],
    });
    const chat = installEditServer(initial, updated);
    await show(initial);
    await openStructuredEdit();
    await press('understood-edit-time-clear');
    await press('understood-edit-save');
    await waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    expect(editRequest(chat).edit.change).toEqual({ time: { at: null, timeZone: 'UTC' } });
  });

  it('A3 \u00ab\u0639\u062f\u0651\u0644\u00bb atomic: one save sends kind, words and time in one change object', async () => { // «عدّل»
    const initial = seedProposal('idea');
    const at = '2030-01-11T16:30:00.000Z';
    const updated = commitmentProposal({
      revision: 8,
      items: [{ ...commitmentProposal().items[0]!, itemId: SEED_ID, title: 'Book the course', resolvedTime: at }],
      understood: [{ kind: 'commitment', itemId: SEED_ID, text: 'Book the course' }],
    });
    const chat = installEditServer(initial, updated);
    await show(initial);
    await openStructuredEdit();
    await chooseKind('commitment');
    await changeText('understood-edit-text', 'Book the course');
    await setTime(at);
    await press('understood-edit-save');
    await waitFor(() => expect(chat).toHaveBeenCalledTimes(2));

    expect(editRequest(chat).edit.change).toEqual({
      kind: 'commitment',
      text: 'Book the course',
      time: { at, timeZone: 'UTC' },
    });
  });

  it('A3 conflict: a 409 adopts the current chat answer, notes the change, and never resubmits', async () => {
    const initial = commitmentProposal();
    const current = commitmentProposal({
      revision: 9,
      items: [{ ...initial.items[0]!, title: 'Current server words' }],
      understood: [{ kind: 'commitment', itemId: ITEM_ID, text: 'Current server words' }],
    });
    const chat = jest.spyOn(captureEndpoints, 'chatCapture')
      .mockResolvedValueOnce(answerFor(initial) as never)
      .mockRejectedValueOnce(new ProposalChangedError({ kind: 'chat', answer: answerFor(current) }));
    await show(initial);
    await openStructuredEdit();
    await changeText('understood-edit-text', 'My words');
    await press('understood-edit-save');

    await waitFor(() => expect(screen.queryByText('Current server words')).not.toBeNull());
    expect(screen.queryByTestId('understood-edit-note')).not.toBeNull();
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('A3 conversation_not_found: never retries in a new conversation and keeps the unsent draft', async () => {
    const initial = commitmentProposal();
    const chat = jest.spyOn(captureEndpoints, 'chatCapture')
      .mockResolvedValueOnce(answerFor(initial) as never)
      .mockRejectedValueOnce(new ConversationNotFoundError('conversation_not_found'));
    await show(initial);
    await changeText('capture-input', 'Unsent follow-up');
    await openStructuredEdit();
    await changeText('understood-edit-text', 'My changed words');
    await press('understood-edit-save');

    await waitFor(() => expect(screen.queryByTestId('understood-edit-note')).not.toBeNull());
    expect(chat).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('capture-input').props.value).toBe('Unsent follow-up');
  });
});

describe('M2b coherent staged and summary edits', () => {
  it('A4 staged card title: folds the title into the summary time patch, clears it after the answer, then confirms the new revision', async () => {
    const initial = commitmentProposal();
    const at = '2030-01-12T11:00:00.000Z';
    const updated = commitmentProposal({
      revision: 8,
      items: [{ ...initial.items[0]!, title: 'Call Dana and Rami', resolvedTime: at }],
      understood: [{ kind: 'commitment', itemId: ITEM_ID, text: 'Call Dana and Rami' }],
    });
    const chat = installEditServer(initial, updated);
    const confirm = jest.spyOn(captureEndpoints, 'confirmCapture').mockResolvedValue({
      success: true, replayed: false, persisted: [], failed: [],
    } as never);
    await show(initial);
    await press('understood-line-1');
    await press(`review-edit-${ITEM_ID}`);
    await changeText('edit-item-title', 'Call Dana and Rami');
    await press('edit-item-save');
    await press('review-back');
    await openStructuredEdit();
    await setTime(at);
    await press('understood-edit-save');

    await waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    expect(editRequest(chat).edit.change).toEqual({ text: 'Call Dana and Rami', time: { at, timeZone: 'UTC' } });
    await press('understood-confirm');
    await press('review-confirm');
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(lastCall(confirm)).toEqual(expect.objectContaining({ proposalId: initial.proposalId, revision: 8 }));
    expect(lastCall(confirm).edits).toBeUndefined();
  });

  it.each(['possible_goal', 'consideration', 'idea', 'waiting_for'] as const)('A4 staged time to %s: folds the staged title but omits and discards time when the effective result is a seed', async (kind) => {
    const initial = commitmentProposal();
    const updated = seedProposal(kind, {
      revision: 8,
      seeds: [{ seedItemId: ITEM_ID, kind, summary: 'Call Dana later' }],
      understood: [{ kind, seedItemId: ITEM_ID, text: 'Call Dana later' }],
    });
    const chat = installEditServer(initial, updated);
    await show(initial);
    await press('understood-line-1');
    await press(`review-edit-${ITEM_ID}`);
    await changeText('edit-item-title', 'Call Dana later');
    await act(async () => { await fireEvent(screen.getByTestId('edit-item-no-time'), 'valueChange', true); });
    await press('edit-item-save');
    await press('review-back');
    await openStructuredEdit();
    await chooseKind(kind);
    await press('understood-edit-save');

    await waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    expect(editRequest(chat).edit.change).toEqual({ kind, text: 'Call Dana later' });
    expect(editRequest(chat).edit.change).not.toHaveProperty('time');
  });

  it('A10 legacy proposal: versioned proposals expose structured controls, then an unversioned answer exposes neither edit nor correction controls', async () => {
    const versioned = commitmentProposal({
      items: [{ ...commitmentProposal().items[0]!, corrections: [{ id: 'correction-1', from: 'Dan', to: 'Dana' }] }],
    });
    const legacy = commitmentProposal({ revision: undefined });
    const chat = jest.spyOn(captureEndpoints, 'chatCapture')
      .mockResolvedValueOnce(answerFor(versioned) as never)
      .mockResolvedValueOnce(answerFor(legacy, 'Another message') as never);
    await show(versioned);
    expect(screen.queryByTestId('understood-edit-1')).not.toBeNull();
    expect(screen.queryByTestId('understood-correction-reject-correction-1')).not.toBeNull();

    await changeText('capture-input', 'Another message');
    await press('capture-analyze');
    await waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('understood-edit-1')).toBeNull();
    expect(screen.queryByTestId('understood-correction-reject-correction-1')).toBeNull();
  });
});

describe('M2b structured-edit accessibility', () => {
  it('A6 accessibility: edit and correction are named buttons for their point and the edit sheet is modal', async () => {
    const proposal = commitmentProposal({
      items: [{
        ...commitmentProposal().items[0]!,
        corrections: [{ id: 'correction-1', from: 'Dan', to: 'Dana' }],
      }],
    });
    installEditServer(proposal, proposal);
    await show(proposal);

    const edit = screen.getByTestId('understood-edit-1');
    const reject = screen.getByTestId('understood-correction-reject-correction-1');
    expect(edit.props.accessibilityRole).toBe('button');
    expect(reject.props.accessibilityRole).toBe('button');
    expect(String(edit.props.accessibilityLabel)).toContain('Call Dana');
    expect(String(reject.props.accessibilityLabel)).toContain('Call Dana');
    expect(edit.parent?.props.accessible).not.toBe(true);

    await press('understood-edit-1');
    expect(screen.getByTestId('understood-edit-sheet').props.accessibilityViewIsModal).toBe(true);
  });

  it.todo('A6 accessibility: AX5 has no native clipping and focus returns to the originating summary edit control: needs simulator');
});
