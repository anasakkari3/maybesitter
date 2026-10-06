/**
 * M2b, after Codex's second inspection of Task A (M2B-A-R2-REVIEW-001..007):
 * no frame of another account's capture, a summary edit spends the card value
 * it replaces, a refused change kept on its point, one proposal writer at a
 * time, and every way out of the «عدّل» sheet giving focus back.
 */
import React from 'react';
import { AccessibilityInfo, ScrollView } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { resetAuthForTests } from '../../../api/auth';
import { ProposalChangedError } from '../../../api/errors';
import * as captureEndpoints from '../../../api/endpoints/capture';
import * as seedEndpoints from '../../../api/endpoints/seeds';
import type { CaptureProposal } from '../../../api/schemas/capture';
import { captureReducer, initialCaptureState } from '../captureMachine';
import {
  ACCOUNT_B, ITEM_ID, SEED_ID, answerFor, seedProposal, changeText, commitmentProposal, deferred, lastCall, openCapture, prepareRoot, press, say,
  type RootHarness,
} from '../../../__acceptance__/m2b/harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'UTC' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

// Every render of the summary, with the account it rendered under.
jest.mock('../UnderstoodMessage', () => {
  const actual = jest.requireActual('../UnderstoodMessage') as typeof import('../UnderstoodMessage');
  const { useOptionalAuth } = jest.requireActual('../../../auth/AuthProvider') as typeof import('../../../auth/AuthProvider');
  const ReactActual = jest.requireActual('react') as typeof React;
  const renders: (string | null)[] = [];
  function UnderstoodMessage(props: Parameters<typeof actual.UnderstoodMessage>[0]) {
    renders.push(useOptionalAuth()?.user?.uid ?? null);
    return ReactActual.createElement(actual.UnderstoodMessage, props);
  }
  return { ...actual, UnderstoodMessage, __renders: renders };
});
const summaryRenders = () => (jest.requireMock('../UnderstoodMessage') as { __renders: (string | null)[] }).__renders;

const OTHER_ID = 'm2b-item-2';
const AT = '2030-01-12T11:00:00.000Z';

let harness: RootHarness;
beforeEach(async () => { summaryRenders().length = 0; harness = await prepareRoot('en'); });
afterEach(async () => {
  await cleanup();
  harness.client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  await AsyncStorage.clear();
});

/** A server that answers the message with `initial` and each edit with the next of `edits` (an Error is thrown). */
function server(initial: CaptureProposal, ...edits: (CaptureProposal | Error)[]) {
  const queue = [...edits];
  return jest.spyOn(captureEndpoints, 'chatCapture').mockImplementation((async (raw: unknown) => {
    const input = raw as { message?: string; edit?: unknown };
    if (!input.edit) return answerFor(initial, input.message ?? 'First message');
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return answerFor(next ?? initial, 'Structured edit');
  }) as never);
}

function editsSent(chat: { mock: { calls: readonly unknown[][] } }) {
  return chat.mock.calls.map(([input]) => input as { edit?: { target: unknown; change: Record<string, unknown> } }).filter((input) => input.edit).map((input) => input.edit!);
}

async function show(): Promise<void> {
  await openCapture(harness);
  await say('First message');
  await waitFor(() => expect(screen.queryByTestId('understood-line-1')).not.toBeNull());
}

/** A card title staged on the review cards, then back to the summary. */
async function stageCardTitle(title: string): Promise<void> {
  await press('understood-line-1');
  await press(`review-edit-${ITEM_ID}`);
  await changeText('edit-item-title', title);
  await press('edit-item-save');
  await press('review-back');
}

function twoPoints(overrides: Partial<CaptureProposal> = {}, order: 'same' | 'swapped' = 'same'): CaptureProposal {
  const base = commitmentProposal();
  const items = [base.items[0]!, { ...base.items[0]!, itemId: OTHER_ID, title: 'Book a table' }];
  const understood = [
    { kind: 'commitment' as const, itemId: ITEM_ID, text: 'Call Dana tomorrow' },
    { kind: 'commitment' as const, itemId: OTHER_ID, text: 'Book a table' },
  ];
  return commitmentProposal({ items, understood: order === 'same' ? understood : [understood[1]!, understood[0]!], ...overrides });
}

describe('no frame of another account (M2B-A-R2-REVIEW-001)', () => {
  it('when account B signs in over A\'s summary, the summary never renders under B', async () => {
    server(commitmentProposal());
    await show();
    expect(summaryRenders()).toContain('m2b-account-a');
    await act(async () => { harness.repository.emit(ACCOUNT_B); });
    expect(summaryRenders().filter((uid) => uid === ACCOUNT_B.uid)).toEqual([]);
    expect(screen.queryByText('Call Dana tomorrow')).toBeNull();
  });
});

describe('a summary edit spends the card value it replaces (M2B-A-R2-REVIEW-002)', () => {
  it('words over staged words: the sheet\'s words are sent, and the card\'s never come back at confirm', async () => {
    const initial = commitmentProposal();
    const updated = commitmentProposal({ revision: 8, items: [{ ...initial.items[0]!, title: 'Sheet words' }], understood: [{ kind: 'commitment', itemId: ITEM_ID, text: 'Sheet words' }] });
    const chat = server(initial, updated);
    const confirm = jest.spyOn(captureEndpoints, 'confirmCapture').mockResolvedValue({ success: true, replayed: false, persisted: [], failed: [] } as never);
    await show();
    await stageCardTitle('Card words');
    await press('understood-edit-1');
    await changeText('understood-edit-text', 'Sheet words');
    await press('understood-edit-save');
    await waitFor(() => expect(editsSent(chat)).toHaveLength(1));
    expect(editsSent(chat)[0]!.change.text).toBe('Sheet words');
    await waitFor(() => expect(screen.queryByText('Sheet words')).not.toBeNull());
    expect(screen.queryByText('Card words')).toBeNull();
    await press('understood-confirm');
    await press('review-confirm');
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(lastCall(confirm).edits).toBeUndefined();
  });

  it('a time over a staged time: the card\'s "no time" is spent by the sheet\'s time', async () => {
    const initial = commitmentProposal();
    const updated = commitmentProposal({ revision: 8, items: [{ ...initial.items[0]!, resolvedTime: AT, endTime: undefined }] });
    const chat = server(initial, updated);
    const confirm = jest.spyOn(captureEndpoints, 'confirmCapture').mockResolvedValue({ success: true, replayed: false, persisted: [], failed: [] } as never);
    await show();
    await press('understood-line-1');
    await press(`review-edit-${ITEM_ID}`);
    await act(async () => { await fireEvent(screen.getByTestId('edit-item-no-time'), 'valueChange', true); });
    await press('edit-item-save');
    await press('review-back');
    await press('understood-edit-1');
    await act(async () => { await fireEvent(screen.getByTestId('understood-edit-time'), 'valueChange', AT); });
    await press('understood-edit-save');
    await waitFor(() => expect(editsSent(chat)).toHaveLength(1));
    expect(editsSent(chat)[0]!.change.time).toEqual({ at: AT, timeZone: 'UTC' });
    await press('understood-confirm');
    await press('review-confirm');
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(lastCall(confirm).edits).toBeUndefined();
  });

  it('a refused summary edit keeps the card value; the same change applied later spends it', async () => {
    const initial = commitmentProposal();
    const current = commitmentProposal({ revision: 8 });
    const updated = commitmentProposal({ revision: 9, items: [{ ...initial.items[0]!, title: 'Sheet words' }], understood: [{ kind: 'commitment', itemId: ITEM_ID, text: 'Sheet words' }] });
    const chat = server(initial, new ProposalChangedError({ kind: 'chat', answer: answerFor(current) }), updated);
    const confirm = jest.spyOn(captureEndpoints, 'confirmCapture').mockResolvedValue({ success: true, replayed: false, persisted: [], failed: [] } as never);
    await show();
    await stageCardTitle('Card words');
    await press('understood-edit-1');
    await changeText('understood-edit-text', 'Sheet words');
    await press('understood-edit-save');
    await waitFor(() => expect(screen.queryByTestId('understood-edit-reopen')).not.toBeNull());
    // Refused: the card's own words are still the person's.
    expect(screen.queryByText('Card words')).not.toBeNull();
    await press('understood-edit-reopen');
    expect(screen.getByTestId('understood-edit-text').props.value).toBe('Sheet words');
    await press('understood-edit-save');
    await waitFor(() => expect(editsSent(chat)).toHaveLength(2));
    expect(editsSent(chat)[1]!.change.text).toBe('Sheet words');
    await waitFor(() => expect(screen.queryByText('Card words')).toBeNull());
    await press('understood-confirm');
    await press('review-confirm');
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(lastCall(confirm).edits).toBeUndefined();
  });
});

describe('a refused change stays on its point (M2B-A-R2-REVIEW-003)', () => {
  it('when the current version reorders the points, it reopens on the same point and is sent to it', async () => {
    const initial = twoPoints();
    const current = twoPoints({ revision: 8 }, 'swapped');
    const chat = server(initial, new ProposalChangedError({ kind: 'chat', answer: answerFor(current) }), twoPoints({ revision: 9 }, 'swapped'));
    await show();
    await press('understood-edit-1');
    await changeText('understood-edit-text', 'Call Dana at noon');
    await press('understood-edit-save');
    await waitFor(() => expect(screen.queryByTestId('understood-edit-reopen')).not.toBeNull());
    await press('understood-edit-reopen');
    expect(screen.getByTestId('understood-edit-text').props.value).toBe('Call Dana at noon');
    await press('understood-edit-save');
    await waitFor(() => expect(editsSent(chat)).toHaveLength(2));
    expect(editsSent(chat)[1]!.target).toEqual({ itemId: ITEM_ID });
  });

  it('survives leaving capture and coming back', async () => {
    const initial = commitmentProposal();
    server(initial, new ProposalChangedError({ kind: 'chat', answer: answerFor(commitmentProposal({ revision: 8 })) }));
    await show();
    await press('understood-edit-1');
    await changeText('understood-edit-text', 'My words');
    await press('understood-edit-save');
    await waitFor(() => expect(screen.queryByTestId('understood-edit-reopen')).not.toBeNull());
    await press('capture-cancel');
    await waitFor(() => expect(screen.queryByTestId('understood-edit-reopen')).toBeNull());
    await press('tab-capture');
    await waitFor(() => expect(screen.queryByTestId('understood-edit-reopen')).not.toBeNull());
    expect(screen.queryByTestId('understood-edit-note')).not.toBeNull();
    await press('understood-edit-reopen');
    expect(screen.getByTestId('understood-edit-text').props.value).toBe('My words');
  });

  it('Back from the reopened sheet leaves no draft behind for the next «عدّل»', async () => {
    server(commitmentProposal(), new ProposalChangedError({ kind: 'chat', answer: answerFor(commitmentProposal({ revision: 8 })) }));
    await show();
    await press('understood-edit-1');
    await changeText('understood-edit-text', 'My words');
    await press('understood-edit-save');
    await waitFor(() => expect(screen.queryByTestId('understood-edit-reopen')).not.toBeNull());
    await press('understood-edit-reopen');
    await press('capture-cancel');
    await waitFor(() => expect(screen.queryByTestId('understood-edit-sheet')).toBeNull());
    await press('understood-edit-1');
    expect(screen.getByTestId('understood-edit-text').props.value).toBe('Call Dana');
  });
});

describe('one proposal writer at a time (M2B-A-R2-REVIEW-005)', () => {
  it('while a «مش هيك» is on its way, a typed message is not sent', async () => {
    const corrected = commitmentProposal({ items: [{ ...commitmentProposal().items[0]!, corrections: [{ id: 'c1', from: 'Dana', to: 'Dina' }] } as never] });
    const pending = deferred<unknown>();
    const chat = jest.spyOn(captureEndpoints, 'chatCapture').mockImplementation((async (raw: unknown) => {
      const input = raw as { message?: string; edit?: unknown };
      if (input.edit) return pending.promise;
      return answerFor(corrected, input.message ?? 'First message');
    }) as never);
    await show();
    await waitFor(() => expect(screen.queryByTestId('understood-correction-reject-c1')).not.toBeNull());
    await press('understood-correction-reject-c1');
    await changeText('capture-input', 'Another thing');
    await act(async () => { await fireEvent.press(screen.getByTestId('capture-analyze')); });
    expect(chat).toHaveBeenCalledTimes(2);
    await act(async () => { pending.resolve(answerFor(commitmentProposal({ revision: 8 }))); });
    await waitFor(() => expect(screen.getByTestId('capture-input').props.value).toBe('Another thing'));
  });
});

describe('every way out of the sheet gives focus back (M2B-A-R2-REVIEW-007)', () => {
  it('the header Back lands on the «عدّل» the sheet came from', async () => {
    const focus = jest.spyOn(AccessibilityInfo, 'sendAccessibilityEvent');
    server(commitmentProposal());
    await show();
    const edit = screen.getByTestId('understood-edit-1');
    await press('understood-edit-1');
    await waitFor(() => expect(focus).toHaveBeenCalled());
    const opened = focus.mock.calls.length;
    await press('capture-cancel');
    await waitFor(() => expect(screen.queryByTestId('understood-edit-sheet')).toBeNull());
    await waitFor(() => expect(focus.mock.calls.length).toBeGreaterThan(opened));
    expect(String((focus.mock.calls.at(-1)![0] as unknown as { props: { testID?: string } }).props.testID)).toBe(edit.props.testID);
  });
});


describe('an edit refused because the proposal is already saved (F7c)', () => {
  it('says it is saved and offers no review of it', async () => {
    server(commitmentProposal(), new ProposalChangedError({ kind: 'chat', answer: answerFor(commitmentProposal({ revision: 8 })), state: 'confirmed' }));
    await show();
    await press('understood-edit-1');
    await changeText('understood-edit-text', 'My words');
    await press('understood-edit-save');
    await waitFor(() => expect(screen.queryByTestId('capture-confirmed-elsewhere')).not.toBeNull());
    expect(screen.queryByTestId('understood-confirm')).toBeNull();
    expect(screen.queryByTestId('understood-edit-reopen')).toBeNull();
  });
});

// ── Codex's third inspection (M2B-A-R3-REVIEW-002..004) ──────────────────

function correctedProposal(): CaptureProposal {
  return commitmentProposal({ items: [{ ...commitmentProposal().items[0]!, corrections: [{ id: 'c1', from: 'Dana', to: 'Dina' }] } as never] });
}

describe('one proposal writer at a time, every writer (M2B-A-R3-REVIEW-002)', () => {
  it('while a «مش هيك» is on its way, the review cannot confirm', async () => {
    const pending = deferred<unknown>();
    jest.spyOn(captureEndpoints, 'chatCapture').mockImplementation((async (raw: unknown) => {
      const input = raw as { message?: string; edit?: unknown };
      return input.edit ? pending.promise : answerFor(correctedProposal(), input.message ?? 'First message');
    }) as never);
    const confirm = jest.spyOn(captureEndpoints, 'confirmCapture').mockResolvedValue({ success: true, replayed: false, persisted: [], failed: [] } as never);
    await show();
    await press('understood-correction-reject-c1');
    await press('understood-confirm');
    await act(async () => { await fireEvent.press(screen.getByTestId('review-confirm')); });
    expect(confirm).not.toHaveBeenCalled();
    await act(async () => { pending.resolve(answerFor(commitmentProposal({ revision: 8 }))); });
    await waitFor(() => expect(screen.getByTestId('review-confirm').props.accessibilityState?.disabled).toBe(false));
    await press('review-confirm');
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(lastCall(confirm)).toEqual(expect.objectContaining({ revision: 8 }));
  });

  it('while a «مش هيك» is on its way, a seed is not kept', async () => {
    const pending = deferred<unknown>();
    const both = commitmentProposal({
      items: correctedProposal().items, seeds: [{ seedItemId: SEED_ID, kind: 'idea', summary: 'Learn pottery' }],
      understood: [{ kind: 'commitment', itemId: ITEM_ID, text: 'Call Dana tomorrow' }, { kind: 'idea', seedItemId: SEED_ID, text: 'Learn pottery' }],
    });
    jest.spyOn(captureEndpoints, 'chatCapture').mockImplementation((async (raw: unknown) => {
      const input = raw as { message?: string; edit?: unknown };
      return input.edit ? pending.promise : answerFor(both, input.message ?? 'First message');
    }) as never);
    const keep = jest.spyOn(seedEndpoints, 'keepProposedSeed').mockResolvedValue({ success: true, replayed: false, seed: { id: 's' } } as never);
    await show();
    await press('understood-correction-reject-c1');
    await press('understood-confirm');
    await waitFor(() => expect(screen.queryByTestId(`review-seed-keep-${SEED_ID}`)).not.toBeNull());
    await act(async () => { await fireEvent.press(screen.getByTestId(`review-seed-keep-${SEED_ID}`)); });
    expect(keep).not.toHaveBeenCalled();
    await act(async () => { pending.resolve(answerFor(both)); });
  });
});

describe('a newer change spends an older refused one (M2B-A-R3-REVIEW-003)', () => {
  it.each<[string, () => CaptureProposal]>([
    ['a point', () => commitmentProposal()],
    ['a seed', () => seedProposal('idea')],
  ])('on %s, a fresh applied edit removes the stale «رجعلي تعديلي»', async (_label, make) => {
    const initial = make();
    const chat = server(initial, new ProposalChangedError({ kind: 'chat', answer: answerFor({ ...make(), revision: 8 }) }), { ...make(), revision: 9 });
    await show();
    await press('understood-edit-1');
    await changeText('understood-edit-text', 'Refused words');
    await press('understood-edit-save');
    await waitFor(() => expect(screen.queryByTestId('understood-edit-reopen')).not.toBeNull());
    await press('understood-edit-1');
    await changeText('understood-edit-text', 'Newer words');
    await press('understood-edit-save');
    await waitFor(() => expect(editsSent(chat)).toHaveLength(2));
    await waitFor(() => expect(screen.queryByTestId('understood-edit-reopen')).toBeNull());
  });
});

describe('a late answer about a former proposal (M2B-A-R3-REVIEW-004)', () => {
  it('"already saved" for P1 leaves P2 on screen alone; for P2 it clears it', () => {
    const p2 = commitmentProposal({ proposalId: 'p2' });
    const shown = captureReducer(captureReducer(initialCaptureState(), { type: 'open' }), { type: 'analyzeSucceeded', proposal: p2 });
    const late = captureReducer(shown, { type: 'proposalConfirmedElsewhere', proposalId: 'p1' });
    expect(late).toBe(shown);
    const own = captureReducer(shown, { type: 'proposalConfirmedElsewhere', proposalId: 'p2' });
    expect(own.proposal).toBeNull();
    expect(own.confirmedElsewhere).toBe(true);
  });
});

// ── Codex's fourth inspection (M2B-A-R4-REVIEW-001, 002, 004) ─────────────

describe('controls say they wait while another write is on its way', () => {
  it('⋯ and paste are disabled, and a refused change cannot be reopened, while a «مش هيك» is on its way', async () => {
    const pending = deferred<unknown>();
    let edits = 0;
    jest.spyOn(captureEndpoints, 'chatCapture').mockImplementation((async (raw: unknown) => {
      const input = raw as { message?: string; edit?: unknown };
      if (!input.edit) return answerFor(correctedProposal(), input.message ?? 'First message');
      edits += 1;
      if (edits === 1) throw new ProposalChangedError({ kind: 'chat', answer: answerFor({ ...correctedProposal(), revision: 8 }) });
      return pending.promise;
    }) as never);
    await show();
    await press('understood-edit-1');
    await changeText('understood-edit-text', 'My words');
    await press('understood-edit-save');
    await waitFor(() => expect(screen.queryByTestId('understood-edit-reopen')).not.toBeNull());
    expect(screen.getByTestId('understood-edit-reopen')).not.toBeDisabled();
    await press('understood-correction-reject-c1');
    expect(screen.getByTestId('understood-edit-reopen')).toBeDisabled();
    expect(screen.getByTestId('chat-more')).toBeDisabled();
    expect(screen.getByTestId('capture-paste')).toBeDisabled();
    await act(async () => { pending.resolve(answerFor({ ...commitmentProposal(), revision: 9 })); });
    await waitFor(() => expect(screen.getByTestId('chat-more')).not.toBeDisabled());
  });

  it('«مش هلّق» waits while its keep is on its way', async () => {
    const pending = deferred<unknown>();
    const both = commitmentProposal({
      seeds: [{ seedItemId: SEED_ID, kind: 'idea', summary: 'Learn pottery' }],
      understood: [{ kind: 'commitment', itemId: ITEM_ID, text: 'Call Dana tomorrow' }, { kind: 'idea', seedItemId: SEED_ID, text: 'Learn pottery' }],
    });
    server(both);
    jest.spyOn(seedEndpoints, 'keepProposedSeed').mockImplementation((() => pending.promise) as never);
    await show();
    await press('understood-confirm');
    await waitFor(() => expect(screen.queryByTestId(`review-seed-skip-${SEED_ID}`)).not.toBeNull());
    await act(async () => { await fireEvent.press(screen.getByTestId(`review-seed-keep-${SEED_ID}`)); });
    expect(screen.getByTestId(`review-seed-skip-${SEED_ID}`)).toBeDisabled();
    await act(async () => { pending.resolve({ success: true, replayed: false, seed: { id: 's' } }); });
    await waitFor(() => expect(screen.queryByTestId(`review-seed-kept-${SEED_ID}`)).not.toBeNull());
  });
});

describe('the start-over question asks what it does (M2b design critique)', () => {
  it('says «start over?», not the discard question', async () => {
    server(commitmentProposal());
    await show();
    await press('chat-more');
    await press('chat-menu-start-over');
    expect(screen.queryByText('Start over?')).not.toBeNull();
  });
});

// ── Codex's fifth inspection (M2B-A-R5-REVIEW-001, 002) ─────────────────────

describe('the sheet holds still while its change is on its way (M2B-A-R5-REVIEW-001)', () => {
  it('kind, words, day, hour and «بلا وقت» wait with Save, and come back when the answer lands', async () => {
    const pending = deferred<unknown>();
    jest.spyOn(captureEndpoints, 'chatCapture').mockImplementation((async (raw: unknown) => {
      const input = raw as { message?: string; edit?: unknown };
      return input.edit ? pending.promise : answerFor(commitmentProposal(), input.message ?? 'First message');
    }) as never);
    await show();
    await press('understood-edit-1');
    await changeText('understood-edit-text', 'My words');
    await press('understood-edit-save');
    for (const id of ['understood-edit-kind-idea', 'understood-edit-text', 'understood-edit-time-date', 'understood-edit-time-clock', 'understood-edit-time-clear', 'understood-edit-save']) {
      expect(screen.getByTestId(id)).toBeDisabled();
    }
    await act(async () => { pending.resolve(answerFor({ ...commitmentProposal(), revision: 8 })); });
    await waitFor(() => expect(screen.queryByTestId('understood-edit-sheet')).toBeNull());
  });
});

describe('each sheet starts at its own top (M2B-A-R5-REVIEW-002)', () => {
  it('the start-over question replacing the menu scrolls to the top again', async () => {
    server(commitmentProposal());
    await show();
    const scroll = jest.spyOn(ScrollView.prototype, 'scrollTo');
    await press('chat-more');
    const afterMenu = scroll.mock.calls.filter(([to]) => (to as { y?: number })?.y === 0).length;
    expect(afterMenu).toBeGreaterThan(0);
    await press('chat-menu-start-over');
    const afterQuestion = scroll.mock.calls.filter(([to]) => (to as { y?: number })?.y === 0).length;
    expect(afterQuestion).toBeGreaterThan(afterMenu);
  });
});
