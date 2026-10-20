import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ACCOUNT_A,
  ACCOUNT_B,
  NOW,
  TODAY,
  initialState,
  prepare,
  showToday,
  teardown,
  type Energy,
  type M5bHarness,
} from './harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

const HIDDEN_A = `m5b.todayEnergyAskHidden.v1:${ACCOUNT_A.uid}`;
const STORAGE_GET = jest.mocked(AsyncStorage.getItem).getMockImplementation();
const STORAGE_SET = jest.mocked(AsyncStorage.setItem).getMockImplementation();
let harness: M5bHarness | undefined;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(async () => {
  jest.mocked(AsyncStorage.getItem).mockImplementation(STORAGE_GET!);
  jest.mocked(AsyncStorage.setItem).mockImplementation(STORAGE_SET!);
  await teardown(harness);
  harness = undefined;
  jest.useRealTimers();
});

async function showEnergy(energy: Energy) {
  harness = await prepare('en', initialState({ energy }));
  const view = await showToday(harness);
  await waitFor(() => expect(screen.queryByTestId('next-step-card')).not.toBeNull());
  return view;
}

describe('M5b Today energy states', () => {
  it('R4.3 check-in line and Change save refetch both next step and Plan', async () => {
    await showEnergy({ source: 'check_in', level: 2, band: 'low', changedPick: false });
    const nextBefore = harness!.server.matching('GET', /^\/api\/mobile\/recommendations\/next-step$/).length;
    const planBefore = harness!.server.matching('GET', new RegExp(`/plans/${TODAY}$`)).length;

    expect(screen.queryByTestId('m5b-today-energy')).not.toBeNull();
    expect(screen.queryByTestId('m5b-today-energy-change')).not.toBeNull();
    await fireEvent.press(screen.getByTestId('m5b-today-energy-change'));
    await fireEvent.press(screen.getByTestId('m5b-today-energy-4'));

    await waitFor(() => expect(harness!.server.matching('PUT', /^\/api\/mobile\/readiness$/)).toHaveLength(1));
    expect(harness!.server.matching('PUT', /^\/api\/mobile\/readiness$/)[0]?.body)
      .toEqual({ energy: 4, observedAt: NOW.toISOString() });
    await waitFor(() => expect(harness!.server.matching('GET', /^\/api\/mobile\/recommendations\/next-step$/).length).toBeGreaterThan(nextBefore));
    await waitFor(() => expect(harness!.server.matching('GET', new RegExp(`/plans/${TODAY}$`)).length).toBeGreaterThan(planBefore));
    expect(screen.getByTestId('m5b-today-energy-saved').props.accessibilityLiveRegion).toBe('polite');
  });

  const HEALTH_CASES: [string, Energy['band']][] = [
    ['low', 'low'], ['steady', 'steady'], ['high', 'high'], ['unknown', null],
  ];

  it.each(HEALTH_CASES)('M5B-013 health %s renders the health line without inventing a level', async (_case, band) => {
    await showEnergy({ source: 'health', level: null, band, changedPick: false });

    expect(screen.queryByTestId('m5b-today-energy-health')).not.toBeNull();
    expect(screen.queryByTestId('m5b-today-energy-question')).toBeNull();
  });

  it('M5B-015 changedPick adds the lighter line under the final displayed card', async () => {
    await showEnergy({ source: 'check_in', level: 2, band: 'low', changedPick: true });

    expect(screen.queryByTestId('m5b-today-energy-lighter')).not.toBeNull();
    expect(screen.queryByTestId('next-step-title')).not.toBeNull();
  });

  it('R4.3 no fresh reading renders an optional 1-5 radiogroup and accessible hide control', async () => {
    await showEnergy({ source: 'none', level: null, band: null, changedPick: false });

    expect(screen.queryByTestId('m5b-today-energy-question')).not.toBeNull();
    expect(screen.getByTestId('m5b-today-energy-question').props.accessibilityRole).toBe('radiogroup');
    for (const energy of [1, 2, 3, 4, 5]) {
      const control = screen.getByTestId(`m5b-today-energy-${energy}`);
      expect(control.props.accessibilityRole).toBe('radio');
      expect(control.props.accessibilityState).toMatchObject({ selected: false });
    }
    const hide = screen.getByTestId('m5b-today-energy-hide');
    expect(hide.props.accessibilityRole).toBe('button');
    expect(typeof hide.props.accessibilityLabel).toBe('string');
    expect(hide.props.accessibilityLabel.length).toBeGreaterThan(0);
  });

  it('R4.3 a refused changed card keeps the energy context and shows the existing stale state', async () => {
    await showEnergy({ source: 'check_in', level: 2, band: 'low', changedPick: true });
    await fireEvent.press(screen.getByTestId('next-step-accept'));

    await waitFor(() => expect(screen.queryByTestId('next-step-stale')).not.toBeNull());
    expect(screen.queryByTestId('m5b-today-energy')).not.toBeNull();
    expect(screen.queryByTestId('m5b-today-energy-lighter')).not.toBeNull();
  });

  it('R4.3 capability off leaves Today without any M5b energy row', async () => {
    harness = await prepare('en', initialState({
      memoryLearning: false,
      energy: { source: 'none', level: null, band: null, changedPick: false },
    }));
    await showToday(harness);
    await waitFor(() => expect(screen.queryByTestId('next-step-card')).not.toBeNull());

    expect(harness.server.matching('GET', /^\/api\/mobile\/capabilities\/m5b$/)).toHaveLength(1);
    expect(screen.queryAllByTestId(/^m5b-today-/)).toHaveLength(0);
    expect(screen.queryByTestId('next-step-title')).not.toBeNull();
  });
});

describe('M5B-018 hide for the local day', () => {
  it('M5B-018 persists across a remount and comes back on the next Asia/Jerusalem day', async () => {
    const view = await showEnergy({ source: 'none', level: null, band: null, changedPick: false });
    await fireEvent.press(screen.getByTestId('m5b-today-energy-hide'));

    await waitFor(() => expect(screen.queryByTestId('m5b-today-energy-question')).toBeNull());
    expect(await AsyncStorage.getItem(HIDDEN_A)).toBe(TODAY);
    await view.unmount();
    const sameDay = await showToday(harness!);
    await waitFor(() => expect(screen.queryByTestId('next-step-card')).not.toBeNull());
    expect(screen.queryByTestId('m5b-today-energy-question')).toBeNull();

    await sameDay.unmount();
    jest.setSystemTime(new Date('2030-03-30T09:00:00.000Z'));
    await showToday(harness!);
    await waitFor(() => expect(screen.queryByTestId('m5b-today-energy-question')).not.toBeNull());
  });

  it('M5B-018 account switch does not reuse account A hide state for account B', async () => {
    harness = await prepare('en', initialState({
      energy: { source: 'none', level: null, band: null, changedPick: false },
    }));
    await AsyncStorage.setItem(HIDDEN_A, TODAY);
    await showToday(harness);
    await waitFor(() => expect(screen.queryByTestId('next-step-card')).not.toBeNull());
    expect(screen.queryByTestId('m5b-today-energy-question')).toBeNull();

    await act(async () => { harness!.repository.emit(ACCOUNT_B); });
    await waitFor(() => expect(screen.queryByTestId('m5b-today-energy-question')).not.toBeNull());
    expect(await AsyncStorage.getItem(`m5b.todayEnergyAskHidden.v1:${ACCOUNT_B.uid}`)).toBeNull();
  });

  it('M5B-018 storage read failure fails open and shows the question', async () => {
    const original = jest.mocked(AsyncStorage.getItem).getMockImplementation();
    jest.mocked(AsyncStorage.getItem).mockImplementation(key => {
      if (key === HIDDEN_A) return Promise.reject(new Error('storage read failed'));
      return original!(key);
    });
    await showEnergy({ source: 'none', level: null, band: null, changedPick: false });

    await waitFor(() => expect(screen.queryByTestId('m5b-today-energy-question')).not.toBeNull());
  });

  it('M5B-018 storage write failure fails open and restores the question', async () => {
    const original = jest.mocked(AsyncStorage.setItem).getMockImplementation();
    jest.mocked(AsyncStorage.setItem).mockImplementation((key, value) => {
      if (key === HIDDEN_A) return Promise.reject(new Error('storage write failed'));
      return original!(key, value);
    });
    await showEnergy({ source: 'none', level: null, band: null, changedPick: false });
    await fireEvent.press(screen.getByTestId('m5b-today-energy-hide'));

    await waitFor(() => expect(screen.queryByTestId('m5b-today-energy-question')).not.toBeNull());
  });
});
