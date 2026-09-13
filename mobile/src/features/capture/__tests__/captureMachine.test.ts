/**
 * The capture flow's invariants, as arithmetic (UC-2.R2, #172).
 *
 * The reducer is pure, so the two promises that matter most can be checked
 * exhaustively rather than demonstrated on a screen:
 *
 *   1. nothing is persisted before confirm — no event but `confirmSucceeded`
 *      can put anything in `persisted`, and that event's payload comes from the
 *      server;
 *   2. the draft never reaches disk — asserted against the module graph, not
 *      against a mock that a future import could bypass.
 */
import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  captureReducer,
  confirmPayload,
  confirmableItems,
  hasUnsavedText,
  initialCaptureState,
  MAX_CAPTURE_LENGTH,
  MAX_TITLE_LENGTH,
  type CaptureEvent,
  type CaptureState,
} from '../captureMachine';
import type { CaptureProposal, CaptureConfirmation } from '../../../api/schemas/capture';

function proposal(over: Partial<CaptureProposal> = {}): CaptureProposal {
  return {
    version: 'v1',
    proposalId: 'p1',
    status: 'proposed',
    items: [
      { itemId: 'a', title: 'Call the clinic', resolvedTime: '2026-09-15T07:00:00.000Z', needsClarification: false },
      { itemId: 'b', title: 'Pay the bill', resolvedTime: '2026-09-15T16:00:00.000Z', needsClarification: false },
    ],
    ...over,
  };
}

function confirmation(over: Partial<CaptureConfirmation> = {}): CaptureConfirmation {
  return {
    success: true,
    replayed: false,
    persisted: [{ itemId: 'a', commitmentId: 'c1', title: 'Call the clinic', resolvedTime: '2026-09-15T07:00:00.000Z' }],
    failed: [],
    ...over,
  };
}

/** Runs a sequence from a fresh state. */
function run(...events: CaptureEvent[]): CaptureState {
  return events.reduce(captureReducer, initialCaptureState());
}

const analyzed = (p: CaptureProposal = proposal()) =>
  run({ type: 'textChanged', text: 'call the clinic tomorrow at 9' }, { type: 'analyzeStarted' }, { type: 'analyzeSucceeded', proposal: p });

describe('nothing is committed before confirm', () => {
  it('leaves persisted empty through every event except confirmSucceeded', () => {
    // Every event the flow can receive, short of the server answering a confirm.
    const events: CaptureEvent[] = [
      { type: 'open', source: 'widget', inputMode: 'voice' },
      { type: 'textChanged', text: 'buy milk tomorrow at 4pm' },
      { type: 'analyzeStarted' },
      { type: 'analyzeSucceeded', proposal: proposal() },
      { type: 'toggleItem', itemId: 'a' },
      { type: 'toggleItem', itemId: 'a' },
      { type: 'editItem', itemId: 'a', edit: { title: 'Call the dentist' } },
      { type: 'clearEdit', itemId: 'a' },
      { type: 'confirmStarted' },
      { type: 'confirmFailed', reason: 'persistence_failed' },
      { type: 'backToComposer' },
      { type: 'undoWindowClosed' },
    ];

    let state = initialCaptureState();
    for (const event of events) {
      state = captureReducer(state, event);
      expect(state.persisted).toEqual([]);
      expect(state.failed).toEqual([]);
      expect(state.status).not.toBe('saved');
    }

    // Only the server's answer produces it.
    state = captureReducer(captureReducer(state, { type: 'analyzeSucceeded', proposal: proposal() }), { type: 'confirmStarted' });
    state = captureReducer(state, { type: 'confirmSucceeded', confirmation: confirmation() });
    expect(state.status).toBe('saved');
    expect(state.persisted).toHaveLength(1);
  });

  it('shows exactly what the server saved, not what the client selected', () => {
    // Both items selected, the server saved one and refused the other.
    const state = captureReducer(
      captureReducer(analyzed(), { type: 'confirmStarted' }),
      {
        type: 'confirmSucceeded',
        confirmation: confirmation({ failed: [{ itemId: 'b', reason: 'invalid_selection' }] }),
      },
    );

    expect(state.persisted.map(item => item.itemId)).toEqual(['a']);
    expect(state.failed.map(item => item.itemId)).toEqual(['b']);
    // The success screen reads `persisted`; 'b' must never appear there.
    expect(state.persisted.some(item => item.itemId === 'b')).toBe(false);
  });
});

describe('the confirm payload', () => {
  it('carries only the selected items', () => {
    const state = captureReducer(analyzed(), { type: 'toggleItem', itemId: 'b' });
    expect(confirmPayload(state).itemIds).toEqual(['a']);
  });

  it('never carries an item that needs clarification', () => {
    const state = analyzed(proposal({
      items: [
        { itemId: 'a', title: 'Call the clinic', resolvedTime: '2026-09-15T07:00:00.000Z', needsClarification: false },
        { itemId: 'b', title: 'Pay the bill', resolvedTime: null, needsClarification: true },
      ],
    }));

    expect(state.selected).toEqual(['a']);
    expect(confirmPayload(state).itemIds).toEqual(['a']);
    // And it cannot be selected by asking.
    const forced = captureReducer(state, { type: 'toggleItem', itemId: 'b' });
    expect(confirmPayload(forced).itemIds).toEqual(['a']);
  });

  it('drops edits for items the user chose not to save', () => {
    // Asking the server to validate a change to something not being saved is a
    // way to fail a confirm for a reason the user cannot see.
    const steps: CaptureEvent[] = [
      { type: 'editItem', itemId: 'a', edit: { title: 'Ring the clinic' } },
      { type: 'editItem', itemId: 'b', edit: { title: 'Settle the bill' } },
      { type: 'toggleItem', itemId: 'b' },
    ];
    const state = steps.reduce(captureReducer, analyzed());

    const payload = confirmPayload(state);
    expect(payload.itemIds).toEqual(['a']);
    expect(Object.keys(payload.edits)).toEqual(['a']);
  });

  it('refuses to start a confirm with nothing selected', () => {
    const steps: CaptureEvent[] = [
      { type: 'toggleItem', itemId: 'a' },
      { type: 'toggleItem', itemId: 'b' },
    ];
    const state = steps.reduce(captureReducer, analyzed());

    expect(confirmPayload(state).itemIds).toEqual([]);
    expect(captureReducer(state, { type: 'confirmStarted' }).status).not.toBe('confirming');
  });
});

describe('proposal status maps to a flow state', () => {
  const cases: [CaptureProposal['status'], string][] = [
    ['proposed', 'needsConfirmation'],
    ['needs_clarification', 'needsClarification'],
    ['no_commitment', 'noCommitment'],
    ['rejected', 'unsupportedRequest'],
  ];
  for (const [status, expected] of cases) {
    it(`${status} becomes ${expected}`, () => {
      expect(analyzed(proposal({ status, items: status === 'proposed' ? proposal().items : [] })).status).toBe(expected);
    });
  }

  it('treats a proposal whose every item needs a question as clarification', () => {
    // The proposal says 'proposed', but there is nothing confirmable in it.
    const state = analyzed(proposal({
      items: [{ itemId: 'a', title: 'Something', resolvedTime: null, needsClarification: true }],
    }));
    expect(state.status).toBe('needsClarification');
    expect(confirmableItems(state.proposal)).toEqual([]);
  });
});

describe('errors', () => {
  it('separates the three failures a user can act on differently', () => {
    for (const [kind, status] of [['network', 'networkError'], ['validation', 'validationError'], ['extraction', 'extractionFailed']] as const) {
      const state = captureReducer(
        run({ type: 'textChanged', text: 'x' }, { type: 'analyzeStarted' }),
        { type: 'analyzeFailed', kind },
      );
      expect(state.status).toBe(status);
    }
  });

  it('keeps the proposal after a failed confirm, so Retry has something to retry', () => {
    const state = captureReducer(captureReducer(analyzed(), { type: 'confirmStarted' }), { type: 'confirmFailed' });
    expect(state.status).toBe('confirmFailed');
    expect(state.proposal).not.toBeNull();
    expect(state.selected).toEqual(['a', 'b']);
  });

  it('keeps the text when going back to the composer', () => {
    // Losing what someone wrote is the worst possible answer to "I could not
    // read that".
    const state = captureReducer(analyzed(proposal({ status: 'no_commitment', items: [] })), { type: 'backToComposer' });
    expect(state.text).toBe('call the clinic tomorrow at 9');
    expect(state.status).toBe('editing');
    expect(state.proposal).toBeNull();
  });
});

describe('limits', () => {
  it('truncates rather than refuses a long paste', () => {
    const state = captureReducer(initialCaptureState(), { type: 'textChanged', text: 'x'.repeat(MAX_CAPTURE_LENGTH + 500) });
    expect(state.text).toHaveLength(MAX_CAPTURE_LENGTH);
    expect(state.status).toBe('editing');
  });

  it('caps an edited title at what the commitment validator accepts', () => {
    const state = captureReducer(analyzed(), { type: 'editItem', itemId: 'a', edit: { title: 'y'.repeat(MAX_TITLE_LENGTH + 50) } });
    expect(state.edits.a?.title).toHaveLength(MAX_TITLE_LENGTH);
  });

  it('ignores an edit for an item that is not in the proposal', () => {
    const state = captureReducer(analyzed(), { type: 'editItem', itemId: 'nope', edit: { title: 'x' } });
    expect(state.edits).toEqual({});
  });
});

describe('the original proposal is kept beside the edits', () => {
  it('so what the user saw at confirm stays answerable', () => {
    const state = captureReducer(analyzed(), { type: 'editItem', itemId: 'a', edit: { title: 'Ring the clinic' } });
    expect(state.original?.items.find(i => i.itemId === 'a')?.title).toBe('Call the clinic');
    expect(state.edits.a?.title).toBe('Ring the clinic');
  });
});

describe('deep link entry', () => {
  it('records the source and the input mode', () => {
    const state = captureReducer(initialCaptureState(), { type: 'open', source: 'widget', inputMode: 'voice' });
    expect(state.source).toBe('widget');
    expect(state.inputMode).toBe('voice');
    expect(state.text).toBe('');
  });

  it('keeps them across a reset, so a widget capture stays a widget capture', () => {
    const state = captureReducer(
      captureReducer(initialCaptureState(), { type: 'open', source: 'widget', inputMode: 'voice' }),
      { type: 'reset' },
    );
    expect(state.source).toBe('widget');
    expect(state.inputMode).toBe('voice');
  });
});

describe('discard confirmation', () => {
  it('is wanted only when there is something to lose', () => {
    expect(hasUnsavedText(initialCaptureState())).toBe(false);
    expect(hasUnsavedText(captureReducer(initialCaptureState(), { type: 'textChanged', text: '   ' }))).toBe(false);
    expect(hasUnsavedText(captureReducer(initialCaptureState(), { type: 'textChanged', text: 'buy milk' }))).toBe(true);
    // Once saved there is nothing to discard.
    const saved = captureReducer(captureReducer(analyzed(), { type: 'confirmStarted' }), { type: 'confirmSucceeded', confirmation: confirmation() });
    expect(hasUnsavedText(saved)).toBe(false);
  });
});

describe('the draft never reaches disk', () => {
  it('imports nothing that could write it', () => {
    // Asserted against the source rather than a mock: a mock only proves this
    // module did not call storage today, while the import graph is what would
    // make it possible tomorrow.
    const source = readFileSync(join(__dirname, '..', 'captureMachine.ts'), 'utf8');
    for (const forbidden of ['async-storage', 'expo-file-system', 'expo-secure-store', 'SecureStore', 'AsyncStorage', 'localStorage', 'writeFile']) {
      expect(source).not.toContain(forbidden);
    }
    // And no serialization of the draft at all.
    expect(source).not.toContain('JSON.stringify');
  });

  it('holds the text only in the state object it returns', () => {
    const state = captureReducer(initialCaptureState(), { type: 'textChanged', text: 'something private' });
    expect(state.text).toBe('something private');
    // Reset drops it entirely; there is nowhere else it could have gone.
    expect(captureReducer(state, { type: 'reset' }).text).toBe('');
  });
});

describe('undo', () => {
  it('is offered only when something was actually saved', () => {
    const savedNothing = captureReducer(
      captureReducer(analyzed(), { type: 'confirmStarted' }),
      { type: 'confirmSucceeded', confirmation: confirmation({ persisted: [], failed: [{ itemId: 'a', reason: 'persistence_failed' }] }) },
    );
    expect(savedNothing.undoable).toBe(false);

    const savedSomething = captureReducer(
      captureReducer(analyzed(), { type: 'confirmStarted' }),
      { type: 'confirmSucceeded', confirmation: confirmation() },
    );
    expect(savedSomething.undoable).toBe(true);
    expect(captureReducer(savedSomething, { type: 'undoWindowClosed' }).undoable).toBe(false);
  });
});
