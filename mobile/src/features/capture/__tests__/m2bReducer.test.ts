/**
 * M2b in the reducer: the dictated draft's voice state, the structured edit's
 * own transition, and the choices that follow an id across it.
 */
import { describe, expect, it } from '@jest/globals';
import { captureReducer, confirmPayload, initialCaptureState, type CaptureState } from '../captureMachine';
import type { CaptureChatAnswer, CaptureProposal } from '../../../api/schemas/capture';

const proposal = (over: Partial<CaptureProposal> = {}): CaptureProposal => ({
  version: 'v1', proposalId: 'p1', status: 'proposed', revision: 3, seeds: [],
  items: [{ itemId: 'i1', title: 'Call Dana', resolvedTime: '2030-01-08T09:00:00.000Z', needsClarification: false }],
  ...over,
});
const answer = (p: CaptureProposal | null): CaptureChatAnswer => ({
  conversationId: 'c1', reply: 'ok', engine: 'rules', proposal: p, turns: [{ role: 'user', text: 'x' }, { role: 'assistant', text: 'ok' }],
});
const run = (state: CaptureState, ...events: Parameters<typeof captureReducer>[1][]) => events.reduce(captureReducer, state);

describe('the dictated draft', () => {
  it('keeps up to three distinct alternatives other than the draft, and is spoken', () => {
    const state = run(initialCaptureState(), { type: 'dictationFinished', text: 'call Dana', alternatives: ['call Dana', 'call Dina', 'call Dina', 'call Deena', 'call Dena', 'call Dona'] });
    expect(state.alternatives).toEqual(['call Dina', 'call Deena', 'call Dena']);
    expect(state.spoken).toBe(true);
  });
  it('typing drops the alternatives but stays spoken; emptying the field forgets it was spoken', () => {
    const dictated = run(initialCaptureState(), { type: 'dictationFinished', text: 'buy milk and bread', alternatives: ['buy milk and bred'] });
    const typed = captureReducer(dictated, { type: 'textChanged', text: 'buy milk' });
    expect([typed.alternatives, typed.spoken]).toEqual([[], true]);
    expect(captureReducer(typed, { type: 'textChanged', text: '' }).spoken).toBe(false);
  });
  it('a chosen chip replaces the draft and the chips go; a send clears them, an answer forgets spoken', () => {
    const dictated = run(initialCaptureState(), { type: 'dictationFinished', text: 'call Dana', alternatives: ['call Dina'] });
    const chosen = captureReducer(dictated, { type: 'alternativeChosen', text: 'call Dina' });
    expect([chosen.text, chosen.alternatives, chosen.spoken]).toEqual(['call Dina', [], true]);
    const sending = captureReducer(dictated, { type: 'chatStarted' });
    expect(sending.alternatives).toEqual([]);
    const answered = captureReducer(sending, { type: 'chatAnswered', answer: answer(null) });
    expect([answered.text, answered.spoken]).toEqual(['', false]);
  });
});

describe('a structured edit', () => {
  const shown = () => run(initialCaptureState(), { type: 'textChanged', text: 'first' }, { type: 'chatStarted' }, { type: 'chatAnswered', answer: answer(proposal()) });

  it('keeps the unsent draft, its spoken state and its chips', () => {
    const drafting = run(shown(), { type: 'dictationFinished', text: 'next thing', alternatives: ['next thin'] });
    const edited = captureReducer(drafting, { type: 'editAnswered', answer: answer(proposal({ revision: 4 })) });
    expect([edited.text, edited.spoken, edited.alternatives, edited.proposal?.revision]).toEqual(['next thing', true, ['next thin'], 4]);
  });
  it('clears the folded staged title and time but keeps the staged priority', () => {
    const staged = captureReducer(shown(), { type: 'editItem', itemId: 'i1', edit: { title: 'Call Dana and Rami', localDateTime: '2030-01-09T10:00', priority: 'high' } });
    const edited = captureReducer(staged, { type: 'editAnswered', folded: 'i1', answer: answer(proposal({ revision: 4, items: [{ ...proposal().items[0]!, title: 'Call Dana and Rami', resolvedTime: '2030-01-09T10:00:00.000Z' }] })) });
    expect(edited.edits.i1).toEqual({ priority: 'high' });
    expect(confirmPayload(edited)).toEqual(expect.objectContaining({ revision: 4 }));
  });
  it('an item that became a seed takes its staged choices with it', () => {
    const staged = captureReducer(shown(), { type: 'editItem', itemId: 'i1', edit: { priority: 'high' } });
    const edited = captureReducer(staged, { type: 'editAnswered', folded: 'i1', answer: answer(proposal({ revision: 4, items: [], seeds: [{ seedItemId: 'i1', kind: 'idea', summary: 'Call Dana' }] })) });
    expect(edited.edits).toEqual({});
    expect(edited.selected).toEqual([]);
  });
});

describe('a 409 with the current proposal', () => {
  it('replaces the proposal of the same id and leaves confirming', () => {
    const shown = run(initialCaptureState('share'), { type: 'analyzeSucceeded', proposal: proposal() }, { type: 'confirmStarted' });
    const replaced = captureReducer(shown, { type: 'proposalReplaced', proposal: proposal({ revision: 5, items: [{ ...proposal().items[0]!, title: 'Current' }] }) });
    expect([replaced.status, replaced.proposal?.revision, replaced.proposal?.items[0]?.title]).toEqual(['needsConfirmation', 5, 'Current']);
  });
  it('ignores a proposal of another id', () => {
    const shown = run(initialCaptureState('share'), { type: 'analyzeSucceeded', proposal: proposal() });
    expect(captureReducer(shown, { type: 'proposalReplaced', proposal: proposal({ proposalId: 'other' }) })).toBe(shown);
  });
});
