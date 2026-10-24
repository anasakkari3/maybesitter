/**
 * #802: the chat's reply is announced when something new arrives — not when
 * its words or objects change, not on reopening, not behind an entry
 * question it was already heard behind (Q802-REV-001, Q802-R2-001/002).
 */
import { AccessibilityInfo } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { renderHook } from '@testing-library/react-native';
import { useAnnounceArrival } from '../../../ui/announce';
import { captureReducer, initialCaptureState, type CaptureState } from '../captureMachine';
import type { CaptureChatAnswer, CaptureChatTurn } from '../../../api/schemas/capture';

let announce: jest.SpiedFunction<typeof AccessibilityInfo.announceForAccessibility>;
beforeEach(() => {
  announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
  announce.mockClear();
});
afterEach(() => { jest.restoreAllMocks(); });

type Props = { arrival: number | null; text: string | null; paused: boolean };
async function hook(initial: Props) {
  return renderHook((props: Props) => useAnnounceArrival(props.arrival, props.text, props.paused), { initialProps: initial });
}

describe('useAnnounceArrival', () => {
  it('what is there at mount is already heard, and a new arrival is said once', async () => {
    const { rerender } = await hook({ arrival: 3, text: 'old', paused: false });
    expect(announce).not.toHaveBeenCalled();
    await rerender({ arrival: 3, text: 'old', paused: false });
    expect(announce).not.toHaveBeenCalled();
    await rerender({ arrival: 4, text: 'old', paused: false });
    await rerender({ arrival: 4, text: 'old', paused: false });
    expect(announce.mock.calls).toEqual([['old']]);
  });

  it('a conversation reopened behind an entry question is not said again on continuing (Q802-R2-001)', async () => {
    const { rerender } = await hook({ arrival: 3, text: 'old', paused: true });
    await rerender({ arrival: 3, text: 'old', paused: false });
    expect(announce).not.toHaveBeenCalled();
  });

  it('an arrival held back by the pause is said once, when the pause ends', async () => {
    const { rerender } = await hook({ arrival: null, text: null, paused: true });
    await rerender({ arrival: 1, text: 'new', paused: true });
    expect(announce).not.toHaveBeenCalled();
    await rerender({ arrival: 1, text: 'new', paused: false });
    await rerender({ arrival: 1, text: 'new', paused: false });
    expect(announce.mock.calls).toEqual([['new']]);
  });

  it('no reply keeps the last one heard', async () => {
    const { rerender } = await hook({ arrival: 2, text: 'kept', paused: false });
    await rerender({ arrival: null, text: null, paused: false });
    await rerender({ arrival: 2, text: 'kept', paused: false });
    expect(announce).not.toHaveBeenCalled();
  });
});

const turn = (role: CaptureChatTurn['role'], text: string): CaptureChatTurn => ({ role, text });
const answer = (turns: CaptureChatTurn[]): CaptureChatAnswer => ({ conversationId: 'c1', reply: turns.at(-1)?.text ?? '', engine: 'rules', proposal: null, turns });
const run = (state: CaptureState, ...events: Parameters<typeof captureReducer>[1][]) => events.reduce(captureReducer, state);

describe('replyArrival in the reducer', () => {
  const first = [turn('user', 'hello'), turn('assistant', 'Tell me more.')];
  const answered = () => run(initialCaptureState(), { type: 'textChanged', text: 'hello' }, { type: 'chatStarted' }, { type: 'chatAnswered', answer: answer(first) });

  it('moves with each reply, even one with the same words', () => {
    const one = answered();
    expect(one.replyArrival).toBe(1);
    const two = run(one, { type: 'textChanged', text: 'again' }, { type: 'chatStarted' },
      { type: 'chatAnswered', answer: answer([...first, turn('user', 'again'), turn('assistant', 'Tell me more.')]) });
    expect(two.replyArrival).toBe(2);
  });

  it('moves for a sent message even when the bounded window comes back the same (Q802-R3-001)', () => {
    const window = Array.from({ length: 6 }, () => [turn('user', 'again'), turn('assistant', 'Tell me more.')]).flat();
    const full = run(initialCaptureState(), { type: 'textChanged', text: 'again' }, { type: 'chatStarted' }, { type: 'chatAnswered', answer: answer(window) });
    const same = run(full, { type: 'textChanged', text: 'again' }, { type: 'chatStarted' }, { type: 'chatAnswered', answer: answer(window.map((t) => ({ ...t }))) });
    expect(same.replyArrival).toBe(full.replyArrival + 1);
  });

  it('moves for an edit answer in another conversation with the same words', () => {
    const one = answered();
    const elsewhere = captureReducer(one, { type: 'editAnswered', answer: { ...answer(first.map((t) => ({ ...t }))), conversationId: 'c2' } });
    expect(elsewhere.replyArrival).toBe(2);
  });

  it('stays when an answer brings the same turns back as new objects — a stale 409 (Q802-R2-002)', () => {
    const one = answered();
    const replayed = captureReducer(one, { type: 'editAnswered', answer: answer(first.map((t) => ({ ...t }))) });
    expect(replayed.turns).not.toBe(one.turns);
    expect(replayed.replyArrival).toBe(1);
  });

  it('moves for an edit that says something new', () => {
    const one = answered();
    const edited = captureReducer(one, { type: 'editAnswered', answer: answer([...first, turn('assistant', 'Changed it.')]) });
    expect(edited.replyArrival).toBe(2);
  });

  it('an undo moves it only when the saved line is the newest message (Q802-R3-002)', () => {
    const saved: CaptureState = { ...answered(), turns: [], conversationId: null,
      earlier: [{ kind: 'saved', persisted: [], failed: [], collisions: [], weeklySaved: [], failedTitles: [] }] } as CaptureState;
    expect(captureReducer(saved, { type: 'undoRecorded', stillSaved: [] } as never).replyArrival).toBe(saved.replyArrival + 1);
    const later = { ...saved, turns: [turn('user', 'thanks'), turn('assistant', 'Any time.')], conversationId: 'c3' } as CaptureState;
    expect(captureReducer(later, { type: 'undoRecorded', stillSaved: [] } as never).replyArrival).toBe(later.replyArrival);
  });

  it('is never reset, so a fresh conversation\'s first reply is new', () => {
    const one = answered();
    const fresh = captureReducer(one, { type: 'reset' });
    expect(fresh.replyArrival).toBe(1);
    const next = run(fresh, { type: 'textChanged', text: 'hello' }, { type: 'chatStarted' }, { type: 'chatAnswered', answer: answer(first) });
    expect(next.replyArrival).toBe(2);
  });
});
