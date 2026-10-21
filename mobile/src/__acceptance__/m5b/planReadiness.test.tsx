import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import {
  NOW,
  Providers,
  TODAY,
  initialState,
  plan,
  prepare,
  readinessResponse,
  showPlan,
  showReadiness,
  teardown,
  type M5bHarness,
  type ReadinessApplied,
} from './harness';
import { KnowsScreen } from '../../features/settings/KnowsScreen';
import { MemoryScreen } from '../../features/memory/MemoryScreen';
import { ReadinessSettingsScreen } from '../../features/settings/ReadinessSettingsScreen';
import { PlanScreen } from '../../screens/PlanScreen';
import { TodayScreen } from '../../screens/TodayScreen';

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

async function loadedPlan(readinessApplied: ReadinessApplied, basisChanged = false, rebuildsLeft = 2) {
  harness = await prepare('en', initialState({ plan: plan(readinessApplied, basisChanged, rebuildsLeft) }));
  await showPlan(harness);
  await waitFor(() => expect(screen.queryByTestId('plan-why')).not.toBeNull());
}

describe('M5b Plan energy', () => {
  it('R4.2 empty Plan saves energy but also builds without choosing', async () => {
    harness = await prepare('en', initialState({ plan: null }));
    await showPlan(harness);
    await waitFor(() => expect(screen.queryByTestId('plan-empty')).not.toBeNull());

    expect(screen.queryByTestId('m5b-plan-energy-question')).not.toBeNull();
    expect(screen.getByTestId('m5b-plan-energy-question').props.accessibilityRole).toBe('radiogroup');
    expect(harness.server.matching('PUT', /^\/api\/mobile\/readiness$/)).toHaveLength(0);
    await fireEvent.press(screen.getByTestId('plan-build'));
    await waitFor(() => expect(harness!.server.matching('POST', new RegExp(`/plans/${TODAY}/build$`))).toHaveLength(1));
  });

  const EFFECT_CASES: [string, Exclude<ReadinessApplied, null>][] = [
    ['check-in low', { source: 'check_in', energy: 2, band: 'low', bufferMinutesAdded: 15, observedAt: '2030-03-29T08:00:00.000Z' }],
    ['check-in steady', { source: 'check_in', energy: 3, band: 'steady', bufferMinutesAdded: 0, observedAt: '2030-03-29T08:00:00.000Z' }],
    ['check-in high', { source: 'check_in', energy: 5, band: 'high', bufferMinutesAdded: 0, observedAt: '2030-03-29T08:00:00.000Z' }],
    ['health low', { source: 'health', energy: null, band: 'low', bufferMinutesAdded: 15, observedAt: '2030-03-29T08:00:00.000Z' }],
    ['health steady', { source: 'health', energy: null, band: 'steady', bufferMinutesAdded: 0, observedAt: '2030-03-29T08:00:00.000Z' }],
    ['health high', { source: 'health', energy: null, band: 'high', bufferMinutesAdded: 0, observedAt: '2030-03-29T08:00:00.000Z' }],
  ];

  it.each(EFFECT_CASES)('R4.2 %s renders one effect line and Change control', async (_case, applied) => {
    await loadedPlan(applied);

    expect(screen.queryByTestId('m5b-plan-energy-effect')).not.toBeNull();
    expect(screen.queryByTestId('m5b-plan-energy-change')).not.toBeNull();
    expect(screen.getByTestId('m5b-plan-energy-change').props.accessibilityRole).toBe('button');
  });

  const UNKNOWN_CASES: [string, ReadinessApplied, boolean, boolean][] = [
    ['unknown unchanged', null, false, false],
    ['unknown changed', null, true, false],
    ['none unchanged', { source: 'none', energy: null, band: null, bufferMinutesAdded: 0, observedAt: null }, false, true],
    ['none changed', { source: 'none', energy: null, band: null, bufferMinutesAdded: 0, observedAt: null }, true, false],
  ];

  it.each(UNKNOWN_CASES)('R4.2 %s draws only allowed energy and notice rows', async (_case, applied, changed, effectVisible) => {
    await loadedPlan(applied, changed);

    expect(screen.queryByTestId('m5b-plan-energy-effect') !== null).toBe(effectVisible);
    expect(screen.queryByTestId('m5b-plan-energy-change')).not.toBeNull();
    expect(screen.queryByTestId('m5b-plan-basis-changed') !== null).toBe(changed);
  });

  const BASIS_CASES: [string, number, boolean][] = [
    ['rebuild available', 1, true],
    ['at cap', 0, false],
  ];

  it.each(BASIS_CASES)('M5B-010 basisChanged with %s selects notice and rebuild availability', async (_case, rebuildsLeft, rebuildVisible) => {
    await loadedPlan({
      source: 'check_in', energy: 4, band: 'high', bufferMinutesAdded: 0,
      observedAt: '2030-03-29T08:00:00.000Z',
    }, true, rebuildsLeft);

    expect(screen.queryByTestId(rebuildsLeft > 0 ? 'm5b-plan-basis-changed' : 'm5b-plan-basis-changed-no-rebuild')).not.toBeNull();
    expect(screen.queryByTestId('plan-regenerate') !== null).toBe(rebuildVisible);
  });

  it('R4.2 Change saves the exact check-in and refetches the Plan', async () => {
    await loadedPlan({
      source: 'check_in', energy: 2, band: 'low', bufferMinutesAdded: 15,
      observedAt: '2030-03-29T08:00:00.000Z',
    });
    const readsBefore = harness!.server.matching('GET', new RegExp(`/plans/${TODAY}$`)).length;

    await fireEvent.press(screen.getByTestId('m5b-plan-energy-change'));
    await fireEvent.press(screen.getByTestId('m5b-plan-energy-4'));
    await waitFor(() => expect(harness!.server.matching('PUT', /^\/api\/mobile\/readiness$/)).toHaveLength(1));

    expect(harness!.server.matching('PUT', /^\/api\/mobile\/readiness$/)[0]?.body)
      .toEqual({ energy: 4, observedAt: NOW.toISOString() });
    await waitFor(() => expect(harness!.server.matching('GET', new RegExp(`/plans/${TODAY}$`)).length).toBeGreaterThan(readsBefore));
  });
});

describe('M5b Readiness status', () => {
  const FRESH_CASES: [string, Record<string, unknown>][] = [
    ['check-in low', { source: 'check_in', energy: 2, band: 'low', bufferMinutes: 15, staleReading: null }],
    ['check-in high', { source: 'check_in', energy: 5, band: 'high', bufferMinutes: 0, staleReading: null }],
    ['health low', { source: 'health', energy: null, band: 'low', bufferMinutes: 15, staleReading: null }],
    ['health steady', { source: 'health', energy: null, band: 'steady', bufferMinutes: 0, staleReading: null }],
  ];

  it.each(FRESH_CASES)('R4.2 %s replaces legacy labels with the plan effect sentence', async (_case, effect) => {
    harness = await prepare('en', initialState({ readiness: readinessResponse(effect) }));
    await showReadiness(harness);
    await waitFor(() => expect(screen.queryByTestId('m5b-readiness-effect')).not.toBeNull());

    expect(screen.queryByTestId('readiness-band')).toBeNull();
    expect(screen.queryByTestId('readiness-source')).toBeNull();
    expect(screen.queryByTestId('readiness-freshness')).toBeNull();
  });

  const NONE_CASES: [string, Record<string, unknown>, string][] = [
    ['stale', { source: 'none', energy: null, band: null, bufferMinutes: 0, staleReading: { source: 'check_in', observedAt: '2030-03-28T08:00:00.000Z' } }, 'm5b-readiness-stale'],
    ['never', { source: 'none', energy: null, band: null, bufferMinutes: 0, staleReading: null }, 'm5b-readiness-never'],
  ];

  it.each(NONE_CASES)('R4.2 none with %s uses the distinct status row', async (_case, effect, testID) => {
    harness = await prepare('en', initialState({ readiness: {
      readiness: null, selectedSource: 'none', freshness: 'missing', planEffect: effect,
    } }));
    await showReadiness(harness);

    await waitFor(() => expect(screen.queryByTestId(testID)).not.toBeNull());
    expect(screen.getByTestId('readiness-energy-2').props.accessibilityRole).toBe('button');
    expect(screen.getByTestId('readiness-energy-2').props.accessibilityState.selected).toBe(false);
  });
});

describe('M5b off parity', () => {
  it('R1.2 / R4.2 / R4.3 capability off leaves Knows, Memory, Plan, Readiness, and Today on their existing surfaces', async () => {
    harness = await prepare('en', initialState({ memoryLearning: false }));
    await render(
      <Providers harness={harness}>
        <KnowsScreen onBack={() => {}} onMemory={() => {}} />
        <MemoryScreen onBack={() => {}} />
        <PlanScreen date={TODAY} onBack={() => {}} />
        <ReadinessSettingsScreen onBack={() => {}} />
        <TodayScreen />
      </Providers>,
    );
    await waitFor(() => expect(screen.queryByTestId('plan-screen')).not.toBeNull());

    expect(harness.server.matching('GET', /^\/api\/mobile\/capabilities\/m5b$/).length).toBeGreaterThan(0);
    expect(screen.queryByTestId('knows-commitment-count')).not.toBeNull();
    expect(screen.queryByTestId('memory-screen-item-memory-1')).not.toBeNull();
    expect(screen.queryByTestId('plan-why')).not.toBeNull();
    expect(screen.queryByTestId('readiness-energy-2')).not.toBeNull();
    expect(screen.queryByTestId('today-scroll')).not.toBeNull();
    expect(screen.queryAllByTestId(/^m5b-/)).toHaveLength(0);
  });
});
