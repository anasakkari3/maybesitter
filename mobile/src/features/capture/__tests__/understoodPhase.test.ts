/**
 * M2a (audit 2026-10-06 #5, #6): «هيك فهمت» before the cards, as a phase of
 * the capture reducer keyed to the proposal it summarises.
 */
import { describe, expect, it } from '@jest/globals';
import { captureReducer, initialCaptureState, showsUnderstood, type CaptureState } from '../captureMachine';
import type { CaptureChatAnswer, CaptureProposal } from '../../../api/schemas/capture';

function proposal(proposalId: string, understood = true): CaptureProposal {
  return {
    version: 'v1', proposalId, status: 'proposed',
    items: [{ itemId: `${proposalId}-item`, title: 'Dentist', resolvedTime: '2030-01-07T16:00:00.000Z', needsClarification: false }],
    seeds: [{ seedItemId: `${proposalId}-seed`, kind: 'consideration', summary: 'Moving' }],
    ...(understood ? { understood: [
      { kind: 'commitment' as const, itemId: `${proposalId}-item`, text: 'Dentist tomorrow' },
      { kind: 'consideration' as const, seedItemId: `${proposalId}-seed`, text: 'Thinking about moving' },
    ] } : {}),
  };
}

function answer(p: CaptureProposal | null): CaptureChatAnswer {
  return { conversationId: 'c1', reply: 'Here is what I understood.', engine: 'rules', proposal: p,
    turns: [{ role: 'user', text: 'dentist and moving' }, { role: 'assistant', text: 'Here is what I understood.' }] };
}

function answered(p: CaptureProposal | null, from: CaptureState = initialCaptureState()): CaptureState {
  const sent = captureReducer(captureReducer(from, { type: 'textChanged', text: 'dentist and moving' }), { type: 'chatStarted' });
  return captureReducer(sent, { type: 'chatAnswered', answer: answer(p) });
}

describe('the understood phase', () => {
  it('starts at the summary, opens the cards, and goes back to the same summary', () => {
    const shown = answered(proposal('p1'));
    expect(showsUnderstood(shown)).toBe(true);
    const cards = captureReducer(shown, { type: 'understoodAccepted' });
    expect(showsUnderstood(cards)).toBe(false);
    expect(cards.reviewOf).toBe('p1');
    const back = captureReducer(cards, { type: 'understoodReopened' });
    expect(showsUnderstood(back)).toBe(true);
    // Back keeps what the person did on the cards.
    const toggled = captureReducer(cards, { type: 'toggleItem', itemId: 'p1-item' });
    expect(captureReducer(toggled, { type: 'understoodReopened' }).selected).toEqual(toggled.selected);
  });

  it('a new proposal id starts at its own summary; the same id keeps the cards open', () => {
    const cards = captureReducer(answered(proposal('p1')), { type: 'understoodAccepted' });
    expect(showsUnderstood(answered(proposal('p2'), cards))).toBe(true);
    expect(showsUnderstood(answered(proposal('p1'), cards))).toBe(false);
    // The reducer forgets the old one outright, not only by comparison.
    expect(answered(proposal('p2'), cards).reviewOf).toBeNull();
  });

  it('a clarification of the same proposal keeps the cards open', () => {
    const cards = captureReducer(answered(proposal('p1')), { type: 'understoodAccepted' });
    const clarified = captureReducer(cards, { type: 'clarified', proposal: { ...proposal('p1'), status: 'proposed' } });
    expect(showsUnderstood(clarified)).toBe(false);
    expect(clarified.reviewOf).toBe('p1');
  });

  it('without usable lines the cards show at once, as before', () => {
    expect(showsUnderstood(answered(proposal('p1', false)))).toBe(false);
    const wrong = { ...proposal('p1'), understood: [{ kind: 'commitment' as const, itemId: 'p1-item', text: 'Dentist' }] };
    expect(showsUnderstood(answered(wrong))).toBe(false);
    // Nothing to accept or reopen then.
    const legacy = answered(proposal('p1', false));
    expect(captureReducer(legacy, { type: 'understoodAccepted' })).toBe(legacy);
    expect(captureReducer(legacy, { type: 'understoodReopened' })).toBe(legacy);
  });

  it('only the chat has the summary: a share or meeting review never does', () => {
    const adopted = captureReducer(initialCaptureState('share'), { type: 'analyzeSucceeded', proposal: proposal('p1') });
    expect(showsUnderstood(adopted)).toBe(false);
  });

  it('a save, Back to the composer, and a reset forget which cards were open', () => {
    const cards = captureReducer(answered(proposal('p1')), { type: 'understoodAccepted' });
    expect(captureReducer(cards, { type: 'backToComposer' }).reviewOf).toBeNull();
    expect(captureReducer(cards, { type: 'reset' }).reviewOf).toBeNull();
    const confirming = captureReducer(cards, { type: 'confirmStarted' });
    expect(captureReducer(confirming, { type: 'understoodReopened' })).toBe(confirming);
    const saved = captureReducer(confirming, { type: 'confirmSucceeded',
      confirmation: { persisted: [{ itemId: 'p1-item', commitmentId: 'c-1', title: 'Dentist' }], failed: [] } as never });
    expect(saved.reviewOf).toBeNull();
  });
});
