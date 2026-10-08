/**
 * The «عدّل» sheet's kinds (M3b, R006): a line offers its own kind, checked,
 * and only the moves the server makes. Inspection M3B-A-002: the habit and
 * goal kinds were missing, so neither conversion was reachable and a habit or
 * a goal line had no checked radio.
 */
import React from 'react';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { AppProvider } from '../../../state/AppContext';
import { kindOptions, SummaryEditSheet, type PointKind } from '../SummaryEditSheet';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'UTC' }]),
  getLocales: jest.fn(() => [{ languageCode: 'ar', languageTag: 'ar', textDirection: 'rtl' }]),
}));

const METRICS: Metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
afterEach(async () => { await cleanup(); });

const ON = { habit: true, goal: true };
const OFF = { habit: false, goal: false };

describe('kindOptions', () => {
  it('a commitment can become a habit only where habits are offered', () => {
    expect(kindOptions('commitment', ON)).toEqual(['commitment', 'habit', 'possible_goal', 'consideration', 'idea', 'waiting_for']);
    expect(kindOptions('commitment', OFF)).toEqual(['commitment', 'possible_goal', 'consideration', 'idea', 'waiting_for']);
  });

  it('a habit goes back to a commitment, and nowhere else', () => {
    expect(kindOptions('habit', ON)).toEqual(['habit', 'commitment']);
  });

  it('a goal goes back to a possible goal, never to a commitment', () => {
    expect(kindOptions('goal', ON)).toEqual(['goal', 'possible_goal']);
  });

  it('a possible goal can become a goal only where goals are offered; other thoughts never', () => {
    expect(kindOptions('possible_goal', ON)).toContain('goal');
    expect(kindOptions('possible_goal', OFF)).not.toContain('goal');
    expect(kindOptions('idea', ON)).not.toContain('goal');
    expect(kindOptions('idea', ON)).not.toContain('habit');
  });

  it.each<PointKind>(['commitment', 'possible_goal', 'consideration', 'idea', 'waiting_for', 'habit', 'goal'])('%s offers itself', (kind) => {
    expect(kindOptions(kind, ON)).toContain(kind);
  });
});

async function sheet(kind: PointKind, onSave = jest.fn(), extra: { text?: string; timedSeed?: boolean } = {}) {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <SummaryEditSheet kind={kind} offered={ON} text={extra.text ?? 'امشي'} timedSeed={extra.timedSeed ?? false} at={null} onSave={onSave} onCancel={jest.fn()} />
      </AppProvider>
    </SafeAreaProvider>,
  );
  return onSave;
}

describe('SummaryEditSheet', () => {
  it('a habit line shows its own kind checked, and turning it into a commitment sends the kind and no time', async () => {
    const onSave = await sheet('habit');
    expect(screen.getByTestId('understood-edit-kind-habit').props.accessibilityState).toEqual(expect.objectContaining({ checked: true }));
    expect(screen.queryByTestId('understood-edit-kind-goal')).toBeNull();
    await fireEvent.press(screen.getByTestId('understood-edit-kind-commitment'));
    // The commitment asks its day and time afterwards (R006), so the sheet offers none.
    expect(screen.queryByTestId('understood-edit-time')).toBeNull();
    await fireEvent.press(screen.getByTestId('understood-edit-save'));
    expect(onSave).toHaveBeenCalledWith({ kind: 'commitment' });
  });

  it('a commitment line can be turned into a habit', async () => {
    const onSave = await sheet('commitment');
    await fireEvent.press(screen.getByTestId('understood-edit-kind-habit'));
    await fireEvent.press(screen.getByTestId('understood-edit-save'));
    expect(onSave).toHaveBeenCalledWith({ kind: 'habit' });
  });

  it('a goal line shows its own kind checked and offers no commitment', async () => {
    await sheet('goal');
    expect(screen.getByTestId('understood-edit-kind-goal').props.accessibilityState).toEqual(expect.objectContaining({ checked: true }));
    expect(screen.queryByTestId('understood-edit-kind-commitment')).toBeNull();
  });

  it('a habit line takes 120 emoji (the server counts code points); a commitment line stops at 120 units', async () => {
    const onHabit = await sheet('habit');
    await fireEvent.changeText(screen.getByTestId('understood-edit-text'), '🏃'.repeat(121));
    expect(screen.getByTestId('understood-edit-text').props.value).toBe('🏃'.repeat(120));
    await fireEvent.press(screen.getByTestId('understood-edit-save'));
    expect(onHabit).toHaveBeenCalledWith({ text: '🏃'.repeat(120) });
    await cleanup();
    await sheet('commitment');
    await fireEvent.changeText(screen.getByTestId('understood-edit-text'), '🏃'.repeat(70));
    expect(screen.getByTestId('understood-edit-text').props.value).toBe('🏃'.repeat(60));
  });

  it('a timed thought made a commitment counts code points, as the server path it takes does (R4-001)', async () => {
    const onSave = await sheet('consideration', jest.fn(), { timedSeed: true });
    await fireEvent.press(screen.getByTestId('understood-edit-kind-commitment'));
    await fireEvent.changeText(screen.getByTestId('understood-edit-text'), '🏃'.repeat(120));
    await fireEvent.press(screen.getByTestId('understood-edit-save'));
    expect(onSave).toHaveBeenCalledWith({ kind: 'commitment', text: '🏃'.repeat(120) });
  });

  it('switching to a stricter kind cuts the typed words on screen, so what shows is what is sent (R4-002)', async () => {
    const onSave = await sheet('commitment');
    await fireEvent.press(screen.getByTestId('understood-edit-kind-habit'));
    await fireEvent.changeText(screen.getByTestId('understood-edit-text'), '🏃'.repeat(120));
    await fireEvent.press(screen.getByTestId('understood-edit-kind-commitment'));
    expect(screen.getByTestId('understood-edit-text').props.value).toBe('🏃'.repeat(60));
    await fireEvent.press(screen.getByTestId('understood-edit-save'));
    expect(onSave).toHaveBeenCalledWith({ text: '🏃'.repeat(60) });
  });

  it('an untouched long title is never cut and sent as an edit (R4-003)', async () => {
    const long = 'م'.repeat(150);
    const onSave = await sheet('commitment', jest.fn(), { text: long });
    await fireEvent.press(screen.getByTestId('understood-edit-kind-idea'));
    expect(screen.getByTestId('understood-edit-text').props.value).toBe(long);
    await fireEvent.press(screen.getByTestId('understood-edit-save'));
    expect(onSave).toHaveBeenCalledWith({ kind: 'idea' });
  });

  it.each<[PointKind, PointKind]>([['commitment', 'habit'], ['possible_goal', 'goal']])(
    'an untouched title too long for the %s → %s path is shortened on screen and sent as shown (R5-001)', async (from, to) => {
      const long = 'م'.repeat(130);
      const onSave = await sheet(from, jest.fn(), { text: long });
      await fireEvent.press(screen.getByTestId(`understood-edit-kind-${to}`));
      expect(screen.getByTestId('understood-edit-text').props.value).toBe('م'.repeat(120));
      await fireEvent.press(screen.getByTestId('understood-edit-save'));
      expect(onSave).toHaveBeenCalledWith({ kind: to, text: 'م'.repeat(120) });
    },
  );

  it.each<[string, PointKind[], Record<string, unknown> | null]>([
    ['habit and back to commitment', ['habit', 'commitment'], null],
    ['habit, then idea', ['habit', 'idea'], { kind: 'idea' }],
  ])('visiting a stricter kind and leaving it puts an untouched title back (%s, R6-002)', async (_name, path, sent) => {
    const long = 'م'.repeat(130);
    const onSave = jest.fn();
    const onCancel = jest.fn();
    await render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <AppProvider>
          <SummaryEditSheet kind="commitment" offered={ON} text={long} at={null} onSave={onSave} onCancel={onCancel} />
        </AppProvider>
      </SafeAreaProvider>,
    );
    for (const kind of path) await fireEvent.press(screen.getByTestId(`understood-edit-kind-${kind}`));
    expect(screen.getByTestId('understood-edit-text').props.value).toBe(long);
    await fireEvent.press(screen.getByTestId('understood-edit-save'));
    if (sent) expect(onSave).toHaveBeenCalledWith(sent);
    else { expect(onSave).not.toHaveBeenCalled(); expect(onCancel).toHaveBeenCalled(); }
  });

  it('an untouched timed thought made a commitment keeps its words: that path does not check them (R6-001)', async () => {
    const long = 'م'.repeat(130);
    const onSave = await sheet('consideration', jest.fn(), { text: long, timedSeed: true });
    await fireEvent.press(screen.getByTestId('understood-edit-kind-commitment'));
    expect(screen.getByTestId('understood-edit-text').props.value).toBe(long);
    await fireEvent.press(screen.getByTestId('understood-edit-save'));
    expect(onSave).toHaveBeenCalledWith({ kind: 'commitment' });
  });
});
