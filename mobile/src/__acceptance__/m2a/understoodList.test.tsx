/**
 * M2a · Task A · criteria 1 and 5 — the assistant shows one semantic summary
 * before any confirmation cards or one-at-a-time clarification UI.
 */
import { StyleSheet } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { captureChatSchema, type CaptureProposal } from '../../api/schemas/capture';
import * as captureEndpoints from '../../api/endpoints/capture';
import { resetAuthForTests } from '../../api/auth';
import { chatServer } from '../../testing/captureChat';
import { openCapture, plain, prepareRoot, say, type RootHarness } from './harness';
import legacyChatFixture from '../../api/__fixtures__/capture.chatProposal.json';

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: jest.fn(() => ({ width: 390, height: 844, scale: 3, fontScale: 2 })),
}));

const HOUR = 3_600_000;
const START = new Date(Date.now() + 48 * HOUR).toISOString();
const END = new Date(Date.parse(START) + 4 * HOUR).toISOString();

const POINTS = [
  { kind: 'commitment', itemId: 'commitment-1', text: 'Study session' },
  { kind: 'possible_goal', seedItemId: 'goal-1', text: 'Learn Italian' },
  { kind: 'consideration', seedItemId: 'consideration-1', text: 'Move closer to work' },
  { kind: 'idea', seedItemId: 'idea-1', text: 'A monthly family dinner' },
  { kind: 'waiting_for', seedItemId: 'waiting-1', text: 'Dana to send the document' },
] as const;

function fivePointProposal(proposalId = 'proposal-five'): CaptureProposal {
  return {
    version: 'v1', proposalId, status: 'proposed',
    items: [{ itemId: 'commitment-1', title: 'Study session', resolvedTime: START, endTime: END, needsClarification: false }],
    seeds: [
      { seedItemId: 'goal-1', kind: 'possible_goal', summary: 'Learn Italian' },
      { seedItemId: 'consideration-1', kind: 'consideration', summary: 'Move closer to work' },
      { seedItemId: 'idea-1', kind: 'idea', summary: 'A monthly family dinner' },
      { seedItemId: 'waiting-1', kind: 'waiting_for', summary: 'Dana to send the document' },
    ],
    understood: [...POINTS],
  };
}

let harness: RootHarness;

beforeEach(async () => {
  harness = await prepareRoot('ar');
});

afterEach(async () => {
  await cleanup();
  harness.client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  await AsyncStorage.clear();
});

async function answerWith(proposal: CaptureProposal): Promise<void> {
  jest.spyOn(captureEndpoints, 'chatCapture').mockImplementation(chatServer(
    () => proposal,
    { reply: () => 'I understood these points.', engine: 'model' },
  ) as never);
  await openCapture(harness);
  await say('Five separate points');
  await waitFor(() => expect(screen.queryByText(proposal.understood![0]!.text)).not.toBeNull());
}

function understoodLines() {
  const assistant = screen.getByTestId('chat-turn-assistant-1');
  const list = within(assistant).getByRole('list');
  return { list, lines: within(list).getAllByRole('listitem') };
}

function actionablePart(line: ReturnType<typeof screen.getByRole>) {
  return within(line).queryByRole('button') ?? line;
}

type RenderNode = { children?: readonly (RenderNode | string | number)[] };
function renderedText(node: RenderNode | string | number): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return (node.children ?? []).map(renderedText).join(' ');
}

function inheritedDirection(node: ReturnType<typeof screen.getByRole>): string | undefined {
  let current: typeof node | null = node;
  while (current) {
    const direction = StyleSheet.flatten(current.props.style)?.direction;
    if (direction) return direction;
    current = current.parent;
  }
  return undefined;
}

describe('the understood message', () => {
  it('A1 understood list first: five points are one numbered list and the old cards and clarify question are absent', async () => {
    await answerWith(fivePointProposal());

    const { lines } = understoodLines();
    expect(lines).toHaveLength(5);
    expect(screen.queryByTestId('chat-schedule')).toBeNull();
    expect(screen.queryByTestId('chat-clarification')).toBeNull();
    expect(screen.queryByTestId('review-card-commitment-1')).toBeNull();
    expect(screen.queryByText('\u0627\u0644\u0627\u0644\u062a\u0632\u0627\u0645\u0627\u062a \u0627\u0644\u0645\u0642\u062a\u0631\u062d\u0629 (1)')).toBeNull(); // «الالتزامات المقترحة (1)»
    expect(screen.queryByText('\u0623\u064a \u0648\u0642\u062a \u0628\u0646\u0627\u0633\u0628\u0643\u061f')).toBeNull(); // «أي وقت بناسبك؟»

    lines.forEach((line, index) => {
      const allText = renderedText(line as unknown as RenderNode);
      expect(allText).toContain(String(index + 1));
      expect(allText).toContain(POINTS[index]!.text);
    });
  });

  it('A1 understood list first: every line has visible kind text, speaks the kind before the point, and opens its card when tapped', async () => {
    await answerWith(fivePointProposal());
    const { lines } = understoodLines();

    for (const [index, line] of lines.entries()) {
      const control = actionablePart(line);
      const spoken = plain(String(control.props.accessibilityLabel ?? line.props.accessibilityLabel ?? ''));
      const visible = renderedText(line as unknown as RenderNode);
      expect(spoken.indexOf(POINTS[index]!.text)).toBeGreaterThan(0);
      expect(visible.replace(POINTS[index]!.text, '').replace(String(index + 1), '').trim().length).toBeGreaterThan(0);
    }

    const targets = [
      'review-card-commitment-1',
      'review-seed-goal-1',
      'review-seed-consideration-1',
      'review-seed-idea-1',
      'review-seed-waiting-1',
    ];
    for (const [index, target] of targets.entries()) {
      const current = understoodLines().lines[index]!;
      await act(async () => { await fireEvent.press(actionablePart(current)); });
      await waitFor(() => expect(screen.queryByTestId(target)).not.toBeNull());
      await act(async () => { await fireEvent.press(screen.getByTestId('review-back')); });
      await waitFor(() => expect(screen.queryByTestId('chat-turn-assistant-1')).not.toBeNull());
    }
  });

  it('A3 range on understood line: the commitment line and its accessibility name show the full 16:00–20:00 range', async () => {
    const start = '2030-01-07T16:00:00.000Z';
    const end = '2030-01-07T20:00:00.000Z';
    const proposal = fivePointProposal('proposal-range');
    proposal.items[0] = { ...proposal.items[0]!, resolvedTime: start, endTime: end };
    await answerWith(proposal);

    const line = understoodLines().lines[0]!;
    const visible = plain(renderedText(line as unknown as RenderNode));
    const spoken = plain(String(actionablePart(line).props.accessibilityLabel ?? line.props.accessibilityLabel ?? ''));
    expect({ visible, spoken }).toEqual(expect.objectContaining({
      visible: expect.stringContaining('16:00\u201320:00'),
      spoken: expect.stringContaining('16:00\u201320:00'),
    }));
  });

  it('A1 one point: it is a tappable line without list chrome and opens the existing review card', async () => {
    const pointText = 'One dentist appointment';
    const proposal: CaptureProposal = {
      version: 'v1', proposalId: 'proposal-one', status: 'proposed', seeds: [],
      items: [{ itemId: 'only-item', title: 'Dentist', resolvedTime: START, needsClarification: false }],
      understood: [{ kind: 'commitment', itemId: 'only-item', text: pointText }],
    };
    await answerWith(proposal);

    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByTestId('review-card-only-item')).toBeNull();
    const lineText = screen.getByText(pointText);
    await act(async () => { await fireEvent.press(lineText); });
    await waitFor(() => expect(screen.queryByTestId('review-card-only-item')).not.toBeNull());
  });

  it('A5 accessibility: at AX5 the RTL list keeps semantic lines, unclamped labels, and 44-point tap targets', async () => {
    await answerWith(fivePointProposal());
    const { list, lines } = understoodLines();
    expect(inheritedDirection(list)).toBe('rtl');

    for (const [index, line] of lines.entries()) {
      const control = actionablePart(line);
      const style = StyleSheet.flatten(control.props.style);
      const spoken = plain(String(control.props.accessibilityLabel ?? line.props.accessibilityLabel ?? ''));
      expect(style?.minHeight).toBeGreaterThanOrEqual(44);
      expect(control.props.numberOfLines).not.toBe(1);
      expect(control.props.ellipsizeMode).toBeUndefined();
      expect(spoken.indexOf(POINTS[index]!.text)).toBeGreaterThan(0);
    }
  });

  it('A6 no regression: an old fixture still opens its cards, while a later response carrying understood starts at the list', async () => {
    const legacy = captureChatSchema.parse(legacyChatFixture);
    const next = fivePointProposal('proposal-after-legacy');
    const chat = jest.spyOn(captureEndpoints, 'chatCapture')
      .mockResolvedValueOnce(legacy)
      .mockImplementationOnce(chatServer(() => next) as never);
    await openCapture(harness);
    await say(legacy.turns[0]!.text);
    const legacyId = legacy.proposal!.items[0]!.itemId;
    await waitFor(() => expect(screen.queryByTestId(`review-card-${legacyId}`)).not.toBeNull());

    await say('Five separate points');
    await waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('chat-schedule')).toBeNull();
    expect(understoodLines().lines).toHaveLength(5);
  });

  it.todo('A5 accessibility: AX5 has no native text clipping in either platform renderer: needs simulator');
});
