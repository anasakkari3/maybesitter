/**
 * Which requests the capture flow makes, and what it reports (UC-2.R2, #172).
 *
 * The gateway is a recording fake, so these are assertions about calls rather
 * than about a rendered screen — which is what the acceptance criteria are
 * actually about.
 */
import { describe, expect, it } from '@jest/globals';
import { captureReducer, initialCaptureState, type CaptureEvent, type CaptureState } from '../captureMachine';
import { analyzeCapture, confirmCapture, undoCapture, type CaptureGateway } from '../captureFlowActions';
import type { CaptureConfirmation, CaptureProposal } from '../../../api/schemas/capture';

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
    persisted: [{ itemId: 'a', commitmentId: 'c-a', title: 'Call the clinic', resolvedTime: '2026-09-15T07:00:00.000Z' }],
    failed: [],
    ...over,
  };
}

/** Records every call, so "which requests happened" is readable. */
function gateway(over: Partial<CaptureGateway> = {}) {
  const calls: string[] = [];
  const confirms: { proposalId: string; itemIds: string[]; edits: Record<string, unknown> }[] = [];
  const removed: string[] = [];
  const base: CaptureGateway = {
    async propose(text) { calls.push(`propose:${text}`); return proposal(); },
    async confirm(input) { calls.push(`confirm:${input.itemIds.join('+')}`); confirms.push(input); return confirmation(); },
    async remove(id) { calls.push(`remove:${id}`); removed.push(id); return {}; },
  };
  return { gateway: { ...base, ...over }, calls, confirms, removed };
}

const run = (...events: CaptureEvent[]): CaptureState => events.reduce(captureReducer, initialCaptureState());
const analyzed = (p: CaptureProposal = proposal()): CaptureState =>
  run({ type: 'textChanged', text: 'call the clinic tomorrow at 9' }, { type: 'analyzeStarted' }, { type: 'analyzeSucceeded', proposal: p });

const classify = (error: unknown) =>
  (error as { kind?: 'network' | 'validation' | 'extraction' }).kind ?? 'extraction';

describe('analyze', () => {
  it('asks once, with the text as typed', async () => {
    const g = gateway();
    const outcome = await analyzeCapture(g.gateway, 'call the clinic tomorrow at 9', classify);

    expect(outcome).toEqual({ ok: true, proposal: proposal() });
    expect(g.calls).toEqual(['propose:call the clinic tomorrow at 9']);
  });

  it('reports the failure kind without throwing', async () => {
    for (const kind of ['network', 'validation', 'extraction'] as const) {
      const g = gateway({ propose: async () => { throw { kind }; } });
      expect(await analyzeCapture(g.gateway, 'x', classify)).toEqual({ ok: false, kind });
    }
  });
});

describe('nothing is written before confirm', () => {
  it('analyze makes no call that could create or change a commitment', async () => {
    const g = gateway();
    await analyzeCapture(g.gateway, 'buy milk tomorrow at 4pm', classify);

    // One propose, and nothing else. A confirm or a remove here would be the
    // whole invariant failing.
    expect(g.calls).toEqual(['propose:buy milk tomorrow at 4pm']);
    expect(g.confirms).toEqual([]);
    expect(g.removed).toEqual([]);
  });
});

describe('confirm', () => {
  it('sends only the selected items', async () => {
    const g = gateway();
    const state = captureReducer(analyzed(), { type: 'toggleItem', itemId: 'b' });

    await confirmCapture(g.gateway, state);

    expect(g.confirms).toHaveLength(1);
    expect(g.confirms[0]!.itemIds).toEqual(['a']);
    expect(g.confirms[0]!.proposalId).toBe('p1');
  });

  it('never sends an item that needs clarification', async () => {
    const g = gateway();
    const state = analyzed(proposal({
      items: [
        { itemId: 'a', title: 'Call the clinic', resolvedTime: '2026-09-15T07:00:00.000Z', needsClarification: false },
        { itemId: 'b', title: 'Pay the bill', resolvedTime: null, needsClarification: true },
      ],
    }));

    await confirmCapture(g.gateway, state);

    expect(g.confirms[0]!.itemIds).toEqual(['a']);
  });

  it('makes no request at all when nothing is selected', async () => {
    const g = gateway();
    const steps: CaptureEvent[] = [{ type: 'toggleItem', itemId: 'a' }, { type: 'toggleItem', itemId: 'b' }];
    const state = steps.reduce(captureReducer, analyzed());

    // Null rather than a refused request: the server would say no, and the user
    // would see an error for having deselected everything.
    expect(await confirmCapture(g.gateway, state)).toBeNull();
    expect(g.calls).toEqual([]);
  });

  it('treats a 200 whose body says success:false as a failure', async () => {
    const g = gateway({
      async confirm() {
        return confirmation({ success: false, persisted: [], failed: [{ itemId: 'a', reason: 'invalid_selection' }], failureCode: 'invalid_selection' });
      },
    });

    expect(await confirmCapture(g.gateway, analyzed())).toEqual({ ok: false, reason: 'invalid_selection' });
  });

  it('reports a thrown failure rather than propagating it', async () => {
    const error = new Error('boom');
    error.name = 'NetworkError';
    const g = gateway({ confirm: async () => { throw error; } });

    expect(await confirmCapture(g.gateway, analyzed())).toEqual({ ok: false, reason: 'NetworkError' });
  });

  it('carries edits only for items being confirmed', async () => {
    const g = gateway();
    const steps: CaptureEvent[] = [
      { type: 'editItem', itemId: 'a', edit: { title: 'Ring the clinic' } },
      { type: 'editItem', itemId: 'b', edit: { title: 'Settle the bill' } },
      { type: 'toggleItem', itemId: 'b' },
    ];
    const state = steps.reduce(captureReducer, analyzed());

    await confirmCapture(g.gateway, state);

    expect(Object.keys(g.confirms[0]!.edits)).toEqual(['a']);
  });
});

describe('undo', () => {
  const persisted = [
    { itemId: 'a', commitmentId: 'c-a', title: 'One', resolvedTime: null },
    { itemId: 'b', commitmentId: 'c-b', title: 'Two', resolvedTime: null },
    { itemId: 'c', commitmentId: 'c-c', title: 'Three', resolvedTime: null },
  ];

  it('deletes exactly what the server said it saved, one at a time', async () => {
    const g = gateway();
    const outcome = await undoCapture(g.gateway, persisted);

    expect(g.removed).toEqual(['c-a', 'c-b', 'c-c']);
    expect(outcome).toEqual({ undone: ['c-a', 'c-b', 'c-c'], stillSaved: [] });
  });

  it('never claims a full undo when one delete failed', async () => {
    // The worst available outcome is "Undone" while a commitment is still there.
    const g = gateway({
      async remove(id) {
        if (id === 'c-b') throw new Error('nope');
        return {};
      },
    });

    const outcome = await undoCapture(g.gateway, persisted);

    expect(outcome.undone).toEqual(['c-a', 'c-c']);
    expect(outcome.stillSaved).toEqual(['c-b']);
    // And it keeps going after the failure rather than abandoning the rest.
    expect(outcome.undone).toContain('c-c');
  });

  it('reports every id as still saved when none could be deleted', async () => {
    const g = gateway({ remove: async () => { throw new Error('offline'); } });

    expect(await undoCapture(g.gateway, persisted)).toEqual({
      undone: [],
      stillSaved: ['c-a', 'c-b', 'c-c'],
    });
  });

  it('deletes nothing when the server saved nothing', async () => {
    const g = gateway();
    expect(await undoCapture(g.gateway, [])).toEqual({ undone: [], stillSaved: [] });
    expect(g.removed).toEqual([]);
  });
});
