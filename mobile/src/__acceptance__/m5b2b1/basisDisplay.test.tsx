import React, { useEffect, useRef } from 'react';
import { StyleSheet } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Root } from '../../Root';
import { isolateAuto } from '../../i18n/bidi';
import { useApp } from '../../state/AppContext';
import {
  MEMORY_A,
  MEMORY_B,
  MEMORY_C,
  MEMORY_D,
  MemoryCorrectionDriver,
  NOW,
  Providers,
  SUGGESTION_ID,
  inbox,
  initialState,
  memory,
  noRetries,
  prepare,
  showPanel,
  suggestion,
  teardown,
  type M5bHarness,
  type RouteHandler,
  type RouteReply,
} from './harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: jest.fn(() => ({ width: 390, height: 844, scale: 3, fontScale: 3.12 })),
}));

const CONTENT = new Map([
  [MEMORY_A, 'Morning focus'],
  [MEMORY_B, 'Quiet room'],
  [MEMORY_C, 'Thirty minute blocks'],
  [MEMORY_D, 'Fourth memory'],
]);

let harness: M5bHarness | undefined;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(async () => {
  await teardown(harness);
  harness = undefined;
  jest.useRealTimers();
});

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).join('');
  if (React.isValidElement<{ children?: unknown }>(value)) return textOf(value.props.children);
  return '';
}

function intelligenceHandler(memoryIds: string[], basisMode?: 'on_basis' | 'on_nobasis'): RouteHandler {
  return request => request.method === 'GET' && request.path === '/api/mobile/intelligence'
    ? {
      status: 200,
      body: inbox(
        [suggestion(SUGGESTION_ID, { memoryIds })],
        basisMode === undefined ? {} : { basisMode },
      ),
    }
    : undefined;
}

function OpenWatching() {
  const { actions } = useApp();
  const open = useRef(actions.switchTab);
  useEffect(() => open.current('watching'), []);
  return null;
}

async function mountPanel(
  language: 'ar' | 'en' | 'he' = 'en',
  options: { cited?: string[]; listed?: string[]; memoryLearning?: boolean; children?: React.ReactNode } = {},
) {
  const cited = options.cited ?? [MEMORY_A];
  const listed = options.listed ?? cited;
  harness = await prepare(language, initialState({
    memoryLearning: options.memoryLearning ?? true,
    memoryItems: listed.map(id => memory(id, CONTENT.get(id))),
  }), intelligenceHandler(cited, options.memoryLearning === false ? undefined : 'on_basis'));
  noRetries(harness);
  await showPanel(harness, options.children);
  await waitFor(() => expect(screen.queryByTestId(`intelligence-suggestion-${SUGGESTION_ID}`)).not.toBeNull());
}

describe('M5b-2b-1 suggestion basis display', () => {
  it('R3 shows one fresh, isolated line per cited memory and never more than the three the wire permits', async () => {
    await mountPanel('en', { cited: [MEMORY_A, MEMORY_B, MEMORY_C], listed: [MEMORY_A, MEMORY_B, MEMORY_C, MEMORY_D] });

    const lines = [MEMORY_A, MEMORY_B, MEMORY_C].map(id => screen.getByTestId(`m5b-suggestion-basis-${SUGGESTION_ID}-${id}`));
    expect(lines).toHaveLength(3);
    for (const [index, id] of [MEMORY_A, MEMORY_B, MEMORY_C].entries()) {
      expect(textOf(lines[index]!.props.children)).toContain(isolateAuto(CONTENT.get(id)!));
    }
    expect(screen.queryByTestId(`m5b-suggestion-basis-${SUGGESTION_ID}-${MEMORY_D}`)).toBeNull();
  });

  it('R3 fetches Memory since mount and hides a citation whose id is absent from that fresh list', async () => {
    await mountPanel('en', { cited: [MEMORY_A], listed: [MEMORY_B] });

    expect(harness!.server.matching('GET', /^\/api\/mobile\/memory$/).length).toBeGreaterThan(0);
    expect(screen.queryByTestId(`m5b-suggestion-basis-${SUGGESTION_ID}-${MEMORY_A}`)).toBeNull();
    expect(screen.queryByTestId(`intelligence-suggestion-${SUGGESTION_ID}`)).not.toBeNull();
  });

  it('R3 hides the basis from the first frame of a correction in flight', async () => {
    let resolvePatch!: (reply: RouteReply) => void;
    const patch = new Promise<RouteReply>(resolve => { resolvePatch = resolve; });
    const base = intelligenceHandler([MEMORY_A], 'on_basis');
    const handler: RouteHandler = request => {
      if (request.method === 'PATCH' && request.path === `/api/mobile/memory/${MEMORY_A}`) return patch;
      return base(request);
    };
    harness = await prepare('en', initialState({ memoryItems: [memory(MEMORY_A, CONTENT.get(MEMORY_A))] }), handler);
    noRetries(harness);
    await showPanel(harness, <MemoryCorrectionDriver />);
    await waitFor(() => expect(screen.queryByTestId(`m5b-suggestion-basis-${SUGGESTION_ID}-${MEMORY_A}`)).not.toBeNull());

    await fireEvent.press(screen.getByTestId('gate-correct-memory'));
    await waitFor(() => expect(harness!.server.matching('PATCH', new RegExp(`/memory/${MEMORY_A}$`))).toHaveLength(1));
    expect(screen.queryByTestId(`m5b-suggestion-basis-${SUGGESTION_ID}-${MEMORY_A}`)).toBeNull();
    await act(async () => resolvePatch({ status: 400, body: { success: false, error: 'invalid' } }));
  });

  it('R3 correction opens Memory focused on the cited id', async () => {
    harness = await prepare('en', initialState({ memoryItems: [memory(MEMORY_A, CONTENT.get(MEMORY_A))] }), intelligenceHandler([MEMORY_A], 'on_basis'));
    noRetries(harness);
    await render(
      <Providers harness={harness}>
        <OpenWatching />
        <Root />
      </Providers>,
    );
    await waitFor(() => expect(screen.queryByTestId(`m5b-suggestion-basis-fix-${SUGGESTION_ID}-${MEMORY_A}`)).not.toBeNull());

    await fireEvent.press(screen.getByTestId(`m5b-suggestion-basis-fix-${SUGGESTION_ID}-${MEMORY_A}`));
    await waitFor(() => expect(screen.queryByTestId(`memory-screen-focused-${MEMORY_A}`)).not.toBeNull());
  });

  it.each(['ar', 'en', 'he'] as const)('REV-005 / AX5 %s gives repeated correction controls distinct memory-naming labels and wrapping lines', async language => {
    await mountPanel(language, { cited: [MEMORY_A, MEMORY_B], listed: [MEMORY_A, MEMORY_B] });

    const controls = [MEMORY_A, MEMORY_B].map(id => screen.getByTestId(`m5b-suggestion-basis-fix-${SUGGESTION_ID}-${id}`));
    const labels = controls.map(control => String(control.props.accessibilityLabel));
    expect(new Set(labels).size).toBe(2);
    expect(labels[0]).toContain(CONTENT.get(MEMORY_A));
    expect(labels[1]).toContain(CONTENT.get(MEMORY_B));
    for (const [index, id] of [MEMORY_A, MEMORY_B].entries()) {
      expect(controls[index]!.props.accessibilityRole).toBe('button');
      const line = screen.getByTestId(`m5b-suggestion-basis-${SUGGESTION_ID}-${id}`);
      expect(line.props.numberOfLines).not.toBe(1);
      expect(line.props.ellipsizeMode).toBeUndefined();
      expect(StyleSheet.flatten(line.props.style)?.flexWrap ?? 'wrap').toBe('wrap');
    }
  });

  it('R3 parity: M5b off shows no basis line and makes no memory-list request', async () => {
    await mountPanel('en', { cited: [], listed: [MEMORY_A], memoryLearning: false });

    expect(screen.queryAllByTestId(new RegExp(`^m5b-suggestion-basis-${SUGGESTION_ID}-`))).toHaveLength(0);
    expect(harness!.server.matching('GET', /^\/api\/mobile\/memory$/)).toHaveLength(0);
    expect(harness!.server.matching('GET', /^\/api\/mobile\/intelligence$/)).toHaveLength(1);
  });
});
