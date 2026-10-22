import React, { useEffect, useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Root } from '../../Root';
import { useApp } from '../../state/AppContext';
import { formatClockRange } from '../../i18n/format';
import { IntelligencePanel } from '../../features/goals/IntelligencePanel';
import { PlanScreen } from '../../screens/PlanScreen';
import {
  BASIS_ID,
  BASIS_WINDOW,
  NOW,
  Providers,
  TODAY,
  initialState,
  memoryItem,
  panelHandler,
  planEnvelope,
  planWithBasis,
  prepare,
  showBasisPlan,
  teardown,
  type M5bHarness,
  type RouteHandler,
} from './harness';
import { plan } from '../m5b/harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

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

function planHandler(value: Record<string, unknown>): RouteHandler {
  return request => request.method === 'GET' && request.path === `/api/mobile/plans/${TODAY}`
    ? { status: 200, body: planEnvelope(value) }
    : undefined;
}

async function loadedPlan(value = planWithBasis()) {
  harness = await prepare('en', initialState(), planHandler(value));
  await showBasisPlan(harness);
  await waitFor(() => expect(screen.queryByTestId('plan-why')).not.toBeNull());
}

function OpenPlan() {
  const { actions } = useApp();
  const openPlan = useRef(actions.openPlan);
  useEffect(() => openPlan.current(TODAY), []);
  return null;
}

async function loadedRoot(memoryExists: boolean) {
  const state = initialState({ memoryItems: [memoryItem(memoryExists ? BASIS_ID : 'some-other-memory')] });
  harness = await prepare('en', state, planHandler(planWithBasis()));
  await render(<Providers harness={harness}><OpenPlan /><Root /></Providers>);
  await waitFor(() => expect(screen.queryByTestId('m5b-plan-memory-basis-fix')).not.toBeNull());
}

describe('M5b-2a R2 plan disclosure', () => {
  it('R2 shows the memory basis window as one LTR clock range and an accessible correction action', async () => {
    await loadedPlan();
    // GA-M5B2A-AMEND-6 (Claude): the line also waits for Memory to answer as
    // openable (M5B2A-R2-002), so it is awaited, not read at once.
    const line = await screen.findByTestId('m5b-plan-memory-basis');

    expect(textOf(line.props.children)).toContain(formatClockRange(BASIS_WINDOW.start, BASIS_WINDOW.end));
    expect(screen.getByTestId('m5b-plan-memory-basis-fix').props.accessibilityRole).toBe('button');
  });

  it('R2 correction opens Memory focused on the basis row with its edit input open', async () => {
    await loadedRoot(true);
    await fireEvent.press(screen.getByTestId('m5b-plan-memory-basis-fix'));

    await waitFor(() => expect(screen.queryByTestId(`memory-screen-focused-${BASIS_ID}`)).not.toBeNull());
    expect(screen.queryByTestId(`memory-screen-edit-input-${BASIS_ID}`)).not.toBeNull();
  });

  it('R2 correction opens Memory unfocused when the named row is gone', async () => {
    await loadedRoot(false);
    await fireEvent.press(screen.getByTestId('m5b-plan-memory-basis-fix'));

    await waitFor(() => expect(screen.queryByTestId('memory-screen-item-some-other-memory')).not.toBeNull());
    expect(screen.queryByTestId(`memory-screen-focused-${BASIS_ID}`)).toBeNull();
    expect(screen.queryByTestId(`memory-screen-edit-input-${BASIS_ID}`)).toBeNull();
  });

  it('R2 memoryBasisChanged with rebuilds left sits beside the existing rebuild control', async () => {
    await loadedPlan(planWithBasis(TODAY, BASIS_ID, { changed: true, rebuildsLeft: 1 }));
    const notice = screen.getByTestId('m5b-plan-memory-changed');
    const rebuild = screen.getByTestId('plan-regenerate');
    expect(notice.parent).toBe(rebuild.parent);
    expect(screen.queryByTestId('m5b-plan-memory-changed-no-rebuild')).toBeNull();
  });

  it('R2 memoryBasisChanged at the cap uses the no-rebuild notice and removes rebuild', async () => {
    await loadedPlan(planWithBasis(TODAY, BASIS_ID, { changed: true, rebuildsLeft: 0 }));
    expect(screen.queryByTestId('m5b-plan-memory-changed-no-rebuild')).not.toBeNull();
    expect(screen.queryByTestId('m5b-plan-memory-changed')).toBeNull();
    expect(screen.queryByTestId('plan-regenerate')).toBeNull();
  });

  it('R2 parity with M5b off has no learned card, basis line, changed notice, or dismissal request', async () => {
    const offPlan = plan();
    const offPanel = panelHandler({ observations: [], capability: false });
    const handler: RouteHandler = request => {
      if (request.path === `/api/mobile/plans/${TODAY}` && request.method === 'GET') {
        return { status: 200, body: planEnvelope(offPlan) };
      }
      return offPanel(request);
    };
    harness = await prepare('en', initialState({ memoryLearning: false }), handler);
    await render(<Providers harness={harness}>
      <PlanScreen date={TODAY} onBack={() => undefined} />
      <IntelligencePanel onChanged={() => undefined} />
    </Providers>);
    await waitFor(() => expect(screen.queryByTestId('intelligence-statement')).not.toBeNull());

    expect(screen.queryByTestId('m5b-learned')).toBeNull();
    expect(screen.queryByTestId('m5b-plan-memory-basis')).toBeNull();
    expect(screen.queryByTestId('m5b-plan-memory-changed')).toBeNull();
    expect(screen.queryByTestId('m5b-plan-memory-changed-no-rebuild')).toBeNull();
    expect(harness.server.matching('POST', /\/intelligence\/observations\//)).toHaveLength(0);
  });
});
