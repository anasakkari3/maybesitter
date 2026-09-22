/**
 * Completing a flagged item by hand when its title is already right (#498).
 *
 * ── The dead end ─────────────────────────────────────────────────
 *
 * A capture that needs clarification usually arrives with a good title and no
 * time — "Call the pharmacy". The way out the product offers is Change: put in
 * the missing time and save. `completedByHand` (`captureMachine.ts`) and the
 * server's `commandsFor` (`captureBoundaryService.ts`) both read a completed
 * item as an edit that carries *both* a title and a time, and the sheet only
 * sent a title the user had retyped. So adding the one thing that was missing
 * left the item exactly as unselectable as before — the same shape as #492,
 * one screen further in.
 *
 * ── What stays as it was ─────────────────────────────────────────
 *
 * For an item that was never flagged, a title the user left alone is still
 * not sent: an untouched field must not ask the server to validate a change
 * nobody made (`diffEdits.test.ts`, `editProposalItemSheet.test.ts`). The
 * second case here pins that down beside the fix.
 */
import React from 'react';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AppProvider } from '../../../state/AppContext';
import { EditProposalItemSheet } from '../EditProposalItemSheet';
import {
  captureReducer,
  confirmPayload,
  confirmableItems,
  initialCaptureState,
  type CaptureEvent,
  type CaptureItemEdit,
} from '../captureMachine';
import type { CaptureProposal, CaptureProposalItem } from '../../../api/schemas/capture';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

const FLAGGED: CaptureProposalItem = {
  itemId: 'p',
  title: 'Call the pharmacy',
  resolvedTime: null,
  needsClarification: true,
};

async function renderSheet(item: CaptureProposalItem): Promise<jest.Mock<(next: CaptureItemEdit) => void>> {
  const onChange = jest.fn<(next: CaptureItemEdit) => void>();
  await render(
    <AppProvider>
      <EditProposalItemSheet item={item} edit={undefined} onChange={onChange} onClose={() => {}} />
    </AppProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId('edit-item-sheet')).not.toBeNull());
  return onChange;
}

/** Turn "No time" off: the sheet proposes an hour from now, which is a time. */
async function giveItATime() {
  expect(screen.getByTestId('edit-item-no-time').props.value).toBe(true);
  await fireEvent(screen.getByTestId('edit-item-no-time'), 'valueChange', false);
  await waitFor(() => expect(screen.queryByTestId('edit-item-pick-time')).not.toBeNull());
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('a flagged item completed with only a time (#498)', () => {
  it('saves an edit that carries the title it already had, beside the time', async () => {
    const onChange = await renderSheet(FLAGGED);
    await giveItATime();
    await fireEvent.press(screen.getByTestId('edit-item-save'));

    expect(onChange).toHaveBeenCalledTimes(1);
    const sent = onChange.mock.calls[0]![0];
    expect(sent.title).toBe('Call the pharmacy');
    expect(sent.localDateTime).toEqual(expect.any(String));
    expect(sent.localDateTime).not.toBe('');
  });

  it('and that edit is what makes the item selectable and confirmable', async () => {
    const onChange = await renderSheet(FLAGGED);
    await giveItATime();
    await fireEvent.press(screen.getByTestId('edit-item-save'));
    const sent = onChange.mock.calls[0]![0];

    const proposal: CaptureProposal = { version: 'v1', proposalId: 'p1', status: 'needs_clarification', items: [FLAGGED], seeds: [] };
    const events: CaptureEvent[] = [
      { type: 'textChanged', text: 'call the pharmacy' },
      { type: 'analyzeStarted' },
      { type: 'analyzeSucceeded', proposal },
      { type: 'editItem', itemId: 'p', edit: sent },
    ];
    const state = events.reduce(captureReducer, initialCaptureState());

    expect(confirmableItems(state.proposal, state.edits)).toEqual(['p']);
    // Completed by hand auto-selects (#503)
    expect(state.selected).toContain('p');
    expect(confirmPayload(state).itemIds).toEqual(['p']);
    expect(confirmPayload(state).edits.p).toMatchObject({ title: 'Call the pharmacy' });

    // And it can still be toggled off manually
    const unselected = captureReducer(state, { type: 'toggleItem', itemId: 'p' });
    expect(unselected.selected).not.toContain('p');
  });
});

describe('an item that was never flagged', () => {
  it('still does not send a title the user left alone', async () => {
    const onChange = await renderSheet({ ...FLAGGED, itemId: 'u', needsClarification: false });
    await giveItATime();
    await fireEvent.press(screen.getByTestId('edit-item-save'));

    const sent = onChange.mock.calls[0]![0];
    expect(sent.title).toBeUndefined();
    expect(sent.localDateTime).toEqual(expect.any(String));
  });
});

describe('a flagged item saved with No time (#505)', () => {
  it('emits an edit with localDateTime as empty string so review can route it to clarify', async () => {
    const onChange = await renderSheet(FLAGGED);
    await fireEvent.press(screen.getByTestId('edit-item-save'));

    expect(onChange).toHaveBeenCalledTimes(1);
    const sent = onChange.mock.calls[0]![0];
    expect(sent.title).toBe('Call the pharmacy');
    expect(sent.localDateTime).toBe('');
  });
});

