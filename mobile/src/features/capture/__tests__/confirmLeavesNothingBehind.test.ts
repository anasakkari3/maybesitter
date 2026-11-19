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
    expect(lastSaved(state).leftHandedBack).toBe(true);
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
    // Nothing was handed back, so the line must not say it was (review of #877).
    expect(lastSaved(state).leftHandedBack).toBe(false);
  });

  it('when everything was saved, nothing is named and the field stays empty', () => {
    const answered = { ...proposal(), items: proposal().items.map((item) => ({ ...item, needsClarification: false, resolvedTime: '2030-01-08T11:00:00.000Z' })) };
    const state = run(initialCaptureState(), { type: 'chatAnswered', answer: answer(answered) }, { type: 'confirmStarted' }, { type: 'confirmSucceeded', confirmation: saved('i1', 'i2', 'i3') });
    expect(lastSaved(state).leftTitles ?? []).toEqual([]);
    expect(state.text).toBe('');
  });
});

/*
 * QA v3, V3-F24-01: an idea and a waiting-for inside a mixed capture.
 * The chat showed «عم تفكّر فيه: وبفكر يمكن أتعلم جيتار بالصيف» and «وناطر
 * رد…», the person saved, and neither was kept (ideas 0). Outside the
 * thought entry a thought is kept only by its own «خلّيه» (R002, the server
 * refuses it in the confirm); a save that ends the conversation used to take
 * the undecided ones with it in silence.
 */
const mixed = (entry: 'thought' | null = null): CaptureProposal => ({
  version: 'v1', proposalId: 'p2', status: 'proposed', revision: 1, entry,
  items: [{ itemId: 'i1', title: 'أشتري خبز', resolvedTime: '2030-01-08T09:00:00.000Z', needsClarification: false }],
  seeds: [
    { seedItemId: 's1', kind: 'idea', summary: 'وبفكر يمكن أتعلم جيتار بالصيف' },
    { seedItemId: 's2', kind: 'waiting_for', summary: 'وناطر رد من شركة التدريب' },
  ],
} as CaptureProposal);
const shownMixed = (entry: 'thought' | null = null) => run(initialCaptureState(), { type: 'textChanged', text: 'x' }, { type: 'chatStarted' }, { type: 'chatAnswered', answer: { ...answer(mixed(entry)), conversationId: 'c2' } });

describe('V3-F24-01 a save never takes an undecided thought with it in silence', () => {
  it('names the thoughts nobody kept or set aside, and hands their words back', () => {
    const state = run(shownMixed(), { type: 'confirmStarted' }, { type: 'confirmSucceeded', confirmation: saved('i1') });
    // A thought is named as a thought, not as a point with an open question (review of #877).
    expect(lastSaved(state).leftTitles ?? []).toEqual([]);
    expect(lastSaved(state).leftThoughts).toEqual(['وبفكر يمكن أتعلم جيتار بالصيف', 'وناطر رد من شركة التدريب']);
    expect(lastSaved(state).leftHandedBack).toBe(true);
    expect(state.text).toBe('وبفكر يمكن أتعلم جيتار بالصيف\nوناطر رد من شركة التدريب');
  });

  it('a thought kept with «خلّيه» or set aside with «مش هلّق» is decided: not named', () => {
    const state = run(shownMixed(), { type: 'seedDecided', seedItemId: 's1' }, { type: 'seedDecided', seedItemId: 's2' },
      { type: 'confirmStarted' }, { type: 'confirmSucceeded', confirmation: saved('i1') });
    expect(lastSaved(state).leftTitles ?? []).toEqual([]);
    expect(lastSaved(state).leftThoughts ?? []).toEqual([]);
    expect(state.text).toBe('');
  });

  it('from the thought entry the confirm saves thoughts itself: one taken out is the person\'s choice', () => {
    const state = run(shownMixed('thought'), { type: 'confirmStarted' }, { type: 'confirmSucceeded', confirmation: { ...saved('i1'), seedsPersisted: [{ seedItemId: 's1', pointId: 's1', seedId: 'x1', kind: 'idea', title: 'جيتار' }] } as CaptureConfirmation });
    expect(lastSaved(state).leftTitles ?? []).toEqual([]);
    expect(lastSaved(state).leftThoughts ?? []).toEqual([]);
  });
});

/* The saved line's words (review of #877): one or several, a point or a thought, handed back or not. */
describe('the left-behind copy', () => {
  // Imported here so the reducer cases above stay free of i18next.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tFor } = require('../../../i18n') as typeof import('../../../i18n');
  const ar = tFor('ar');
  const he = tFor('he');
  it('Arabic: one point, several points, one thought, several thoughts', () => {
    expect(ar('chatSavedLeftAsking', { n: 1, titles: '«أ»' })).toBe('ما انحفظ «أ»: سؤاله لسّا ما انجاوب.');
    expect(ar('chatSavedLeftAsking', { n: 2, titles: '«أ»، «ب»' })).toBe('ما انحفظوا «أ»، «ب»: أسئلتهم لسّا ما انجاوبت.');
    expect(ar('chatSavedLeftThoughts', { n: 1, titles: '«أ»' })).toBe('ما انحفظ «أ»: هاد إشي عم تفكّر فيه، وبينحفظ بس بـ«خلّيه».');
    expect(ar('chatSavedLeftThoughts', { n: 3, titles: '«أ»، «ب»، «ج»' })).toBe('ما انحفظوا «أ»، «ب»، «ج»: هدول أشياء عم تفكّر فيها، وبينحفظوا بس بـ«خلّيه».');
    expect(ar('chatSavedLeftBack')).toBe('رجّعت الكلام عالخانة تحت: كمّله وابعته.');
  });
  it('Hebrew: one and several', () => {
    expect(he('chatSavedLeftAsking', { n: 1, titles: '"א"' })).toBe('"א" לא נשמר: השאלה שלו לא נענתה.');
    expect(he('chatSavedLeftAsking', { n: 2, titles: '"א", "ב"' })).toBe('"א", "ב" לא נשמרו: השאלות שלהם לא נענו.');
  });
});
