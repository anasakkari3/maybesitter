/**
 * «كل أسبوع» or «مرة وحدة بس» on a Review card (weekly fixed blocks).
 *
 * The server keeps an item as a weekly block only when the confirm names it in
 * `weeklyBlockItemIds`; otherwise it saves the one-off on the next occurrence.
 * So the whole feature's promise — nothing becomes a standing claim on
 * somebody's week unless they chose it — is a property of `confirmPayload`,
 * and is checked here as arithmetic.
 */
import { describe, expect, it } from '@jest/globals';
import {
  captureReducer,
  confirmPayload,
  initialCaptureState,
  wantsDiscardConfirmation,
  weeklyChoice,
  type CaptureEvent,
  type CaptureState,
} from '../captureMachine';
import type { CaptureConfirmation, CaptureProposal } from '../../../api/schemas/capture';

const OFFER = { title: 'تدريب', weekdays: [6], start: '10:00', end: '16:00', timezone: 'Asia/Jerusalem' };

function proposal(): CaptureProposal {
  return {
    version: 'v1',
    proposalId: 'p1',
    status: 'proposed',
    items: [
      { itemId: 'w', title: 'تدريب كل سبت', resolvedTime: '2026-10-03T07:00:00.000Z', needsClarification: false, weeklyBlock: OFFER },
      { itemId: 'o', title: 'Pay the bill', resolvedTime: '2026-09-30T16:00:00.000Z', needsClarification: false },
    ],
    seeds: [],
  };
}

function run(...events: CaptureEvent[]): CaptureState {
  return events.reduce(captureReducer, initialCaptureState());
}

const analyzed: CaptureEvent = { type: 'analyzeSucceeded', proposal: proposal() };

describe('the default', () => {
  it('keeps an offered item weekly, and names only it', () => {
    const state = run(analyzed);
    expect(weeklyChoice(state, 'w')).toBe('weekly');
    expect(weeklyChoice(state, 'o')).toBeNull();
    expect(confirmPayload(state).weeklyBlockItemIds).toEqual(['w']);
    expect(confirmPayload(state).itemIds).toEqual(['w', 'o']);
  });

  it('is not a change the person made, so leaving asks nothing', () => {
    expect(wantsDiscardConfirmation(run(analyzed))).toBe(false);
  });
});

describe('«مرة وحدة بس»', () => {
  it('drops the item from the weekly list and keeps it in the confirm', () => {
    const state = run(analyzed, { type: 'setWeekly', itemId: 'w', weekly: false });
    expect(weeklyChoice(state, 'w')).toBe('once');
    expect(confirmPayload(state).weeklyBlockItemIds).toEqual([]);
    expect(confirmPayload(state).itemIds).toContain('w');
  });

  it('can be taken back', () => {
    const state = run(analyzed, { type: 'setWeekly', itemId: 'w', weekly: false }, { type: 'setWeekly', itemId: 'w', weekly: true });
    expect(confirmPayload(state).weeklyBlockItemIds).toEqual(['w']);
  });

  it('is a choice worth asking about before discarding', () => {
    expect(wantsDiscardConfirmation(run(analyzed, { type: 'setWeekly', itemId: 'w', weekly: false }))).toBe(true);
  });

  it('cannot make an item with no offer weekly', () => {
    const before = run(analyzed, { type: 'setWeekly', itemId: 'w', weekly: false });
    expect(captureReducer(before, { type: 'setWeekly', itemId: 'o', weekly: true })).toBe(before);
    expect(captureReducer(before, { type: 'setWeekly', itemId: 'nope', weekly: false })).toBe(before);
  });

  it('is forgotten by a new analysis', () => {
    const state = run(analyzed, { type: 'setWeekly', itemId: 'w', weekly: false }, analyzed);
    expect(weeklyChoice(state, 'w')).toBe('weekly');
  });
});

describe('what the server would refuse is never sent', () => {
  it('sends a deselected weekly item nowhere', () => {
    const state = run(analyzed, { type: 'toggleItem', itemId: 'w' });
    expect(confirmPayload(state).weeklyBlockItemIds).toEqual([]);
    expect(confirmPayload(state).itemIds).toEqual(['o']);
  });

  it('names only what the confirm itself carries, whatever the selection holds', () => {
    // A selection is filtered to confirmable items before it is sent; the
    // weekly list must be the same subset, or the server refuses the confirm.
    const asking = { ...proposal(), items: proposal().items.map((item) => item.itemId === 'w' ? { ...item, needsClarification: true } : item) };
    const state: CaptureState = { ...run({ type: 'analyzeSucceeded', proposal: asking }), selected: ['w', 'o'] };
    expect(confirmPayload(state).itemIds).toEqual(['o']);
    expect(confirmPayload(state).weeklyBlockItemIds).toEqual([]);
  });

  it('turns an item whose time was edited into a one-off: the block\'s hours are the offer\'s', () => {
    const state = run(analyzed, { type: 'editItem', itemId: 'w', edit: { localDateTime: '2026-10-03T11:00' } });
    expect(weeklyChoice(state, 'w')).toBe('once');
    expect(confirmPayload(state).weeklyBlockItemIds).toEqual([]);
    // Pressing «كل أسبوع» does not undo that: the edit would be refused with it.
    const pressed = captureReducer(state, { type: 'setWeekly', itemId: 'w', weekly: true });
    expect(confirmPayload(pressed).weeklyBlockItemIds).toEqual([]);
  });

  it('does the same for a place reminder, and not for a title', () => {
    const place = run(analyzed, { type: 'editItem', itemId: 'w', edit: { locationTrigger: { kind: 'arrive', placeId: 'home', label: 'Home' } } });
    expect(weeklyChoice(place, 'w')).toBe('once');
    const titled = run(analyzed, { type: 'editItem', itemId: 'w', edit: { title: 'Training' } });
    expect(weeklyChoice(titled, 'w')).toBe('weekly');
    expect(confirmPayload(titled).weeklyBlockItemIds).toEqual(['w']);
  });
});

describe('after the confirm', () => {
  it('keeps the blocks the server says it made, and only those', () => {
    const block = {
      id: 'b1', title: 'تدريب', weekdays: [6], start: '10:00', end: '16:00', timezone: 'Asia/Jerusalem',
      status: 'active' as const, source: 'capture' as const, createdAt: '2026-09-29T10:00:00.000Z', updatedAt: '2026-09-29T10:00:00.000Z',
      confirmedAt: '2026-09-29T10:00:00.000Z', startsOn: '2026-10-03', deviceEvent: null,
    };
    const confirmation: CaptureConfirmation = { success: true, replayed: false, persisted: [], failed: [], weeklyBlocks: [{ itemId: 'w', block }] };
    const state = run(analyzed, { type: 'confirmStarted' }, { type: 'confirmSucceeded', confirmation });
    expect(state.status).toBe('saved');
    expect(state.weeklySaved.map((entry) => entry.block.id)).toEqual(['b1']);
    // Nothing a commitment Undo could take back.
    expect(state.undoable).toBe(false);
  });

  it('reads an older server with no field as none', () => {
    const state = run(analyzed, { type: 'confirmStarted' }, { type: 'confirmSucceeded', confirmation: { success: true, replayed: false, persisted: [], failed: [] } });
    expect(state.weeklySaved).toEqual([]);
  });
});
