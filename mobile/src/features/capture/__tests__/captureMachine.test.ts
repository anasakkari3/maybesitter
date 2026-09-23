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
  defaultSelectedItems,
  hasUnsavedText,
  wantsDiscardConfirmation,
  initialCaptureState,
  MAX_CAPTURE_LENGTH,
  MAX_TITLE_LENGTH,
  type CaptureEvent,
  type CaptureItemEdit,
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
    // Always an array on the client (#519); the schema defaults it.
    seeds: [],
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

  /**
   * The fallback the product offers for a question nobody wants to answer
   * (#492): fill the item in by hand in the edit sheet. The server accepts
   * exactly this — `commandsFor()` builds the commands from a title and a
   * resolved time — so the client has to let it be selected, or the path
   * cannot be reached from the app at all.
   */
  it('carries a flagged item the user completed by hand with a title and a time', () => {
    const flagged = analyzed(proposal({
      items: [
        { itemId: 'a', title: 'Call the clinic', resolvedTime: '2026-09-15T07:00:00.000Z', needsClarification: false },
        { itemId: 'b', title: 'Pay the bill', resolvedTime: null, needsClarification: true },
      ],
    }));

    const completed = captureReducer(flagged, {
      type: 'editItem',
      itemId: 'b',
      edit: { title: 'Pay the electricity bill', localDateTime: '2026-09-15T19:00' },
    });

    expect(completed.selected).toContain('b');
    expect(confirmPayload(completed).itemIds).toEqual(['a', 'b']);
    expect(confirmPayload(completed).edits.b).toMatchObject({
      title: 'Pay the electricity bill',
      localDateTime: '2026-09-15T19:00',
    });
  });

  it('auto-selects a flagged item once completed by hand with a title and a time (#503)', () => {
    const flagged = analyzed(proposal({
      items: [
        { itemId: 'a', title: 'Call the clinic', resolvedTime: '2026-09-15T07:00:00.000Z', needsClarification: false },
        { itemId: 'b', title: 'Pay the bill', resolvedTime: null, needsClarification: true },
      ],
    }));
    expect(flagged.selected).toEqual(['a']);

    const completed = captureReducer(flagged, {
      type: 'editItem',
      itemId: 'b',
      edit: { title: 'Pay the electricity bill', localDateTime: '2026-09-15T19:00' },
    });

    // #503: Completed by hand is now confirmable, so it joins selected immediately without manual toggle.
    expect(completed.selected).toEqual(['a', 'b']);
    expect(confirmPayload(completed).itemIds).toEqual(['a', 'b']);
  });

  it('still refuses a flagged item with only half an answer', () => {
    const flagged = analyzed(proposal({
      items: [
        { itemId: 'a', title: 'Call the clinic', resolvedTime: '2026-09-15T07:00:00.000Z', needsClarification: false },
        { itemId: 'b', title: 'Pay the bill', resolvedTime: null, needsClarification: true },
      ],
    }));

    // A title and no time is not an answer: there is nothing to remind anyone
    // about, and the server refuses it too (`captureAtomicEdits.test.ts`).
    const titleOnly = captureReducer(flagged, { type: 'editItem', itemId: 'b', edit: { title: 'Pay the electricity bill' } });
    expect(captureReducer(titleOnly, { type: 'toggleItem', itemId: 'b' }).selected).not.toContain('b');

    // And a time with no title is not one either.
    const timeOnly = captureReducer(flagged, { type: 'editItem', itemId: 'b', edit: { localDateTime: '2026-09-15T19:00' } });
    expect(captureReducer(timeOnly, { type: 'toggleItem', itemId: 'b' }).selected).not.toContain('b');
  });

  it('keeps a hand-completed item selected when another item\'s question is answered', () => {
    // The clarified proposal is a whole new proposal object, and the selection
    // is rebuilt from what is confirmable in it. A hand-completed item is only
    // confirmable together with its edit, so the edits have to be read there
    // too or answering one question silently deselects another item (#492).
    const twoFlagged = analyzed(proposal({
      items: [
        { itemId: 'b', title: 'Pay the bill', resolvedTime: null, needsClarification: true },
        { itemId: 'c', title: 'Study probability', resolvedTime: null, needsClarification: true },
      ],
    }));
    const completed = captureReducer(twoFlagged, {
      type: 'editItem',
      itemId: 'b',
      edit: { title: 'Pay the electricity bill', localDateTime: '2026-09-15T19:00' },
    });
    expect(completed.selected).toContain('b');

    const answered = captureReducer(completed, {
      type: 'clarified',
      proposal: proposal({
        items: [
          { itemId: 'b', title: 'Pay the bill', resolvedTime: null, needsClarification: true },
          { itemId: 'c', title: 'Study probability', resolvedTime: '2026-09-15T18:00:00.000Z', needsClarification: false },
        ],
      }),
    });

    expect(answered.selected).toContain('b');
    expect(answered.selected).toContain('c');
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

describe('an answered question (#474)', () => {
  const asking = () => proposal({
    items: [
      { itemId: 'a', title: 'Call the clinic', resolvedTime: '2026-09-15T07:00:00.000Z', needsClarification: false },
      { itemId: 'b', title: 'Study probability', resolvedTime: null, needsClarification: true },
      { itemId: 'c', title: 'Pay the bill', resolvedTime: '2026-09-15T16:00:00.000Z', needsClarification: false },
    ],
  });
  // What the server returns after "no specific time": the item is settled, with
  // no time, and nothing else about the proposal moved.
  const settled = () => proposal({
    items: [
      { itemId: 'a', title: 'Call the clinic', resolvedTime: '2026-09-15T07:00:00.000Z', needsClarification: false },
      { itemId: 'b', title: 'Study probability', resolvedTime: null, needsClarification: false, clarification: null },
      { itemId: 'c', title: 'Pay the bill', resolvedTime: '2026-09-15T16:00:00.000Z', needsClarification: false },
    ],
  });

  it('makes a time-less answer confirmable and selects it', () => {
    const state = captureReducer(analyzed(asking()), { type: 'clarified', proposal: settled() });
    expect(confirmableItems(state.proposal)).toContain('b');
    expect(state.selected).toContain('b');
    expect(state.status).toBe('needsConfirmation');
    expect(confirmPayload(state).itemIds).toContain('b');
    expect(state.proposal?.items.find((item) => item.itemId === 'b')?.resolvedTime).toBeNull();
  });

  it('keeps what the user already chose for the other items', () => {
    const before = [
      { type: 'toggleItem', itemId: 'c' },
      { type: 'editItem', itemId: 'a', edit: { title: 'Ring the clinic' } },
    ] as CaptureEvent[];
    const state = [...before, { type: 'clarified', proposal: settled() } as CaptureEvent]
      .reduce(captureReducer, analyzed(asking()));
    expect([...state.selected].sort()).toEqual(['a', 'b']);
    expect(confirmPayload(state)).toEqual({ proposalId: 'p1', itemIds: ['a', 'b'], edits: { a: { title: 'Ring the clinic' } } });
  });

  it('ignores an answer for a different proposal', () => {
    const state = analyzed(asking());
    expect(captureReducer(state, { type: 'clarified', proposal: { ...settled(), proposalId: 'other' } })).toBe(state);
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

    // Composer states via wantsDiscardConfirmation:
    expect(wantsDiscardConfirmation(initialCaptureState())).toBe(false);
    expect(wantsDiscardConfirmation(captureReducer(initialCaptureState(), { type: 'textChanged', text: '   ' }))).toBe(false);
    expect(wantsDiscardConfirmation(captureReducer(initialCaptureState(), { type: 'textChanged', text: 'buy milk' }))).toBe(true);
    expect(wantsDiscardConfirmation(saved)).toBe(false);

    // Review states: fresh proposal with untouched default selections needs no confirmation
    const fresh = analyzed();
    expect(wantsDiscardConfirmation(fresh)).toBe(false);

    // Deselecting an item is worth losing
    const deselected = captureReducer(fresh, { type: 'toggleItem', itemId: 'b' });
    expect(wantsDiscardConfirmation(deselected)).toBe(true);

    // Reselecting restores default selections, so no confirmation is needed
    const reselected = captureReducer(deselected, { type: 'toggleItem', itemId: 'b' });
    expect(wantsDiscardConfirmation(reselected)).toBe(false);

    // Hand-editing an item is worth losing
    const edited = captureReducer(fresh, { type: 'editItem', itemId: 'a', edit: { title: 'Call the clinic urgently' } });
    expect(wantsDiscardConfirmation(edited)).toBe(true);

    // Clearing the edit restores default state
    const cleared = captureReducer(edited, { type: 'clearEdit', itemId: 'a' });
    expect(wantsDiscardConfirmation(cleared)).toBe(false);
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

/**
 * Proposal-level eligibility, as the server actually emits it (#492, reopened).
 *
 * #493 taught the per-item rule to count an item completed by hand, but left a
 * proposal-level guard in front of it that only let `proposed` through. The
 * server emits `needs_clarification` whenever *every* item needs a question
 * (`captureBoundaryService.ts`, `items.every(...)`), so a single flagged item —
 * #492's own repro — never reached the per-item rule at all. The server's
 * confirm accepts both statuses; the client has to agree.
 *
 * The tests above built proposals with the `proposal()` helper, which defaults
 * to `status: 'proposed'` even when every item is flagged — a state the server
 * never produces. That is why they were green while the app was broken. Every
 * proposal below uses the status the server would emit for its items.
 */
describe('a proposal the server sent as needs_clarification (#492)', () => {
  const single = () => proposal({
    status: 'needs_clarification',
    items: [{ itemId: 'p', title: 'Call the pharmacy', resolvedTime: null, needsClarification: true }],
  });
  const edit = (state: CaptureState, e: CaptureItemEdit) =>
    captureReducer(state, { type: 'editItem', itemId: 'p', edit: e });
  const toggle = (state: CaptureState) => captureReducer(state, { type: 'toggleItem', itemId: 'p' });

  it('1. lets a single flagged item completed with a title and a time be selected and confirmed', () => {
    const done = edit(analyzed(single()), { title: 'Call the pharmacy', localDateTime: '2026-09-15T16:11' });
    expect(done.selected).toContain('p');
    expect(confirmPayload(done).itemIds).toEqual(['p']);
    expect(confirmPayload(done).edits.p).toMatchObject({ title: 'Call the pharmacy', localDateTime: '2026-09-15T16:11' });
  });

  it('2. still refuses a title with no time', () => {
    const titleOnly = toggle(edit(analyzed(single()), { title: 'Call the pharmacy' }));
    expect(titleOnly.selected).not.toContain('p');
    expect(confirmPayload(titleOnly).itemIds).toEqual([]);
  });

  it('3. still refuses a time with no title', () => {
    const timeOnly = toggle(edit(analyzed(single()), { localDateTime: '2026-09-15T16:11' }));
    expect(timeOnly.selected).not.toContain('p');
    expect(confirmPayload(timeOnly).itemIds).toEqual([]);
  });

  it('4. treats the edit sheet\'s "No time" as no answer, not as the clarify answer', () => {
    // The empty string is the "No time" switch. Even with a title it completes
    // nothing — the explicit clarify answer (#474) is a different path and is
    // tested separately below.
    const noTime = toggle(edit(analyzed(single()), { title: 'Call the pharmacy', localDateTime: '' }));
    expect(noTime.selected).not.toContain('p');
    expect(confirmPayload(noTime).itemIds).toEqual([]);
  });

  it('5. keeps a hand-completed flagged item confirmable when the proposal is proposed', () => {
    // One item fine, one flagged: the server emits `proposed`.
    const mixed = analyzed(proposal({
      status: 'proposed',
      items: [
        { itemId: 'a', title: 'Call the clinic', resolvedTime: '2026-09-15T07:00:00.000Z', needsClarification: false },
        { itemId: 'p', title: 'Call the pharmacy', resolvedTime: null, needsClarification: true },
      ],
    }));
    const done = edit(mixed, { title: 'Call the pharmacy', localDateTime: '2026-09-15T16:11' });
    expect(confirmPayload(done).itemIds).toEqual(['a', 'p']);
  });

  it('6. keeps a hand-completed item selected when another question is answered', () => {
    // Both flagged, so the server emits `needs_clarification` — the realistic
    // version of the multi-item case above.
    const both = analyzed(proposal({
      status: 'needs_clarification',
      items: [
        { itemId: 'p', title: 'Call the pharmacy', resolvedTime: null, needsClarification: true },
        { itemId: 'c', title: 'Study probability', resolvedTime: null, needsClarification: true },
      ],
    }));
    const selected = edit(both, { title: 'Call the pharmacy', localDateTime: '2026-09-15T16:11' });
    expect(selected.selected).toContain('p');

    // Answering c settles it; now one item is fine, so the server sends `proposed`.
    const answered = captureReducer(selected, {
      type: 'clarified',
      proposal: proposal({
        status: 'proposed',
        items: [
          { itemId: 'p', title: 'Call the pharmacy', resolvedTime: null, needsClarification: true },
          { itemId: 'c', title: 'Study probability', resolvedTime: null, needsClarification: false, clarification: null },
        ],
      }),
    });
    expect(answered.selected).toContain('p');
    expect(answered.selected).toContain('c');
    expect(confirmPayload(answered).itemIds.sort()).toEqual(['c', 'p']);
  });

  it.each(['no_commitment', 'rejected'] as const)(
    '7. confirms nothing on a %s proposal, whatever the edits say',
    (status) => {
      const terminal = proposal({
        status,
        items: [{ itemId: 'p', title: 'Call the pharmacy', resolvedTime: null, needsClarification: true }],
      });
      expect(confirmableItems(terminal, { p: { title: 'Call the pharmacy', localDateTime: '2026-09-15T16:11' } })).toEqual([]);
      expect(confirmableItems(terminal)).toEqual([]);
    },
  );

  it('8. leaves the #474 "Leave it without a time" answer working exactly as before', () => {
    // The clarify `none` answer settles the item server-side: it comes back
    // unflagged with no time, and the proposal is `proposed`.
    const settled = captureReducer(analyzed(single()), {
      type: 'clarified',
      proposal: proposal({
        status: 'proposed',
        items: [{ itemId: 'p', title: 'Call the pharmacy', resolvedTime: null, needsClarification: false, clarification: null }],
      }),
    });
    expect(settled.selected).toContain('p');
    expect(confirmPayload(settled).itemIds).toEqual(['p']);
    expect(settled.proposal?.items[0]?.resolvedTime).toBeNull();
  });
});

describe('document share selection and selectAll/deselectAll (UC-3.7, #191)', () => {
  const docProposal = (over: Partial<CaptureProposal> = {}) => ({
    version: 'v1',
    proposalId: 'p-doc',
    status: 'proposed' as const,
    items: [
      { itemId: 'item-high', title: 'Midterm Exam', resolvedTime: '2026-10-10T10:00:00.000Z', needsClarification: false },
      { itemId: 'item-low', title: 'Optional Reading Quiz', resolvedTime: '2026-10-15T10:00:00.000Z', needsClarification: false },
      { itemId: 'item-edge', title: 'Assignment 1', resolvedTime: '2026-10-20T10:00:00.000Z', needsClarification: false },
    ],
    seeds: [],
    share: {
      channel: 'pdf',
      kind: 'pdf' as const,
      fileCount: 1,
      totalBytes: 5000,
      ignoredSegments: 0,
      evidenceDropped: false,
      metrics: {},
      suggestedNextAction: null,
      evidence: [
        { itemId: 'item-high', sourceIndex: 0, excerpt: 'Midterm Oct 10', document: { kind: 'exam', page: 2, confidence: 0.95, dueAt: '2026-10-10T10:00:00.000Z', needsClarification: false } },
        { itemId: 'item-low', sourceIndex: 0, excerpt: 'Optional Quiz Oct 15', document: { kind: 'quiz', page: 3, confidence: 0.55, dueAt: '2026-10-15T10:00:00.000Z', needsClarification: false } },
        { itemId: 'item-edge', sourceIndex: 0, excerpt: 'Assignment 1 Oct 20', document: { kind: 'assignment', page: 1, confidence: 0.70, dueAt: '2026-10-20T10:00:00.000Z', needsClarification: false } },
      ],
      document: {
        documentTitle: 'Biology 101',
        courseName: 'Bio 101',
        recurringSessions: [
          { weekday: 1, start: '10:00', end: '12:00', label: 'Lecture' },
        ],
      },
    },
    ...over,
  });

  it('selects items with confidence >= 0.7 by default and leaves confidence < 0.7 unselected', () => {
    const p = docProposal() as unknown as CaptureProposal;
    const selected = defaultSelectedItems(p);
    expect(selected).toContain('item-high'); // 0.95 >= 0.7
    expect(selected).toContain('item-edge'); // 0.70 >= 0.7
    expect(selected).not.toContain('item-low'); // 0.55 < 0.7

    const state = run(
      { type: 'open', source: 'share' },
      { type: 'analyzeSucceeded', proposal: p },
    );
    expect(state.selected.sort()).toEqual(['item-edge', 'item-high'].sort());
  });

  it('selectAll selects all confirmable items', () => {
    const p = docProposal() as unknown as CaptureProposal;
    const state = run(
      { type: 'open', source: 'share' },
      { type: 'analyzeSucceeded', proposal: p },
      { type: 'selectAll' },
    );
    expect(state.selected.sort()).toEqual(['item-edge', 'item-high', 'item-low'].sort());
  });

  it('deselectAll clears all selections', () => {
    const p = docProposal() as unknown as CaptureProposal;
    const state = run(
      { type: 'open', source: 'share' },
      { type: 'analyzeSucceeded', proposal: p },
      { type: 'deselectAll' },
    );
    expect(state.selected).toEqual([]);
  });

  it('wantsDiscardConfirmation handles document shares with default confidence selections', () => {
    const p = docProposal() as unknown as CaptureProposal;
    const initial = run(
      { type: 'open', source: 'share' },
      { type: 'analyzeSucceeded', proposal: p },
    );
    // Fresh state with default selection does not prompt discard confirmation
    expect(wantsDiscardConfirmation(initial)).toBe(false);

    // Toggling an item marks selection modified
    const toggled = captureReducer(initial, { type: 'toggleItem', itemId: 'item-low' });
    expect(wantsDiscardConfirmation(toggled)).toBe(true);

    // Deselect all marks selection modified
    const deselected = captureReducer(initial, { type: 'deselectAll' });
    expect(wantsDiscardConfirmation(deselected)).toBe(true);
  });
});

