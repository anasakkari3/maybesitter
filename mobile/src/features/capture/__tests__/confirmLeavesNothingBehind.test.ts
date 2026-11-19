/**
 * QA v3, V3-F04-02: a point still waiting for its answer is not lost by a save.
 *
 * Three points, one still asking its day («مبارح … إيميل للدكتور سمير»):
 * «هيك صح», then «احفظ 2» saved the two clear ones, and the third vanished
 * from the chat — not saved, not asked again. A save ends the chat's
 * conversation and its proposal, so whatever the confirm could not carry has
 * to be said, and its words handed back, or it is gone.
 */
import { describe, expect, it } from '@jest/globals';
import { captureReducer, initialCaptureState, type CaptureState, type ChatSavedNote } from '../captureMachine';
import type { CaptureChatAnswer, CaptureConfirmation, CaptureProposal } from '../../../api/schemas/capture';

const proposal = (): CaptureProposal => ({
  version: 'v1', proposalId: 'p1', status: 'proposed', revision: 1, seeds: [],
  items: [
    { itemId: 'i1', title: 'أشتري خبز', resolvedTime: '2030-01-08T09:00:00.000Z', needsClarification: false },
    { itemId: 'i2', title: 'أتصل بأحمد', resolvedTime: '2030-01-08T10:00:00.000Z', needsClarification: false },
    { itemId: 'i3', title: 'إيميل للدكتور سمير', resolvedTime: null, needsClarification: true },
  ],
  understood: [
    { kind: 'commitment', itemId: 'i1', text: 'بكرا لازم أشتري خبز' },
    { kind: 'commitment', itemId: 'i2', text: 'وبعدها أتصل بأحمد' },
    { kind: 'commitment', itemId: 'i3', text: 'لازم أبعت إيميل للدكتور سمير' },
  ],
} as CaptureProposal);
const answer = (p: CaptureProposal): CaptureChatAnswer => ({
  conversationId: 'c1', reply: 'تمام', engine: 'model', proposal: p, turns: [{ role: 'user', text: 'x' }, { role: 'assistant', text: 'تمام' }],
});
const saved = (...ids: string[]): CaptureConfirmation => ({
  success: true, replayed: false, failed: [],
  persisted: ids.map((itemId) => ({ itemId, commitmentId: `c-${itemId}`, title: itemId, resolvedTime: null })),
});
const run = (state: CaptureState, ...events: Parameters<typeof captureReducer>[1][]) => events.reduce(captureReducer, state);
const shown = () => run(initialCaptureState(), { type: 'textChanged', text: 'x' }, { type: 'chatStarted' }, { type: 'chatAnswered', answer: answer(proposal()) }, { type: 'understoodAccepted' });
const lastSaved = (state: CaptureState) => state.earlier.filter((entry): entry is ChatSavedNote => entry.kind === 'saved').at(-1)!;

describe('V3-F04-02 a save leaves nothing behind in silence', () => {
  it('names the point still asking, and puts its words back in the field', () => {
    const state = run(shown(), { type: 'confirmStarted' }, { type: 'confirmSucceeded', confirmation: saved('i1', 'i2') });
    expect(lastSaved(state).leftTitles).toEqual(['إيميل للدكتور سمير']);
    expect(state.text).toBe('لازم أبعت إيميل للدكتور سمير');
    expect(state.status).toBe('editing');
  });

  it('a point the person took out themselves is their choice: not named, not handed back', () => {
    const state = run(shown(), { type: 'toggleItem', itemId: 'i2' }, { type: 'confirmStarted' }, { type: 'confirmSucceeded', confirmation: saved('i1') });
    expect(lastSaved(state).leftTitles).toEqual(['إيميل للدكتور سمير']);
    expect(state.text).toBe('لازم أبعت إيميل للدكتور سمير');
  });

  it('a message already in the field stays; the point is still named', () => {
    const state = run(shown(), { type: 'textChanged', text: 'وكمان شي' }, { type: 'confirmStarted' }, { type: 'confirmSucceeded', confirmation: saved('i1', 'i2') });
    expect(state.text).toBe('وكمان شي');
    expect(lastSaved(state).leftTitles).toEqual(['إيميل للدكتور سمير']);
  });

  it('when everything was saved, nothing is named and the field stays empty', () => {
    const answered = { ...proposal(), items: proposal().items.map((item) => ({ ...item, needsClarification: false, resolvedTime: '2030-01-08T11:00:00.000Z' })) };
    const state = run(initialCaptureState(), { type: 'chatAnswered', answer: answer(answered) }, { type: 'confirmStarted' }, { type: 'confirmSucceeded', confirmation: saved('i1', 'i2', 'i3') });
    expect(lastSaved(state).leftTitles ?? []).toEqual([]);
    expect(state.text).toBe('');
  });
});
