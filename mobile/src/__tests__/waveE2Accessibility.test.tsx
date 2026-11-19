/**
 * Wave E (E2): the X2 accessibility findings of the de7fcb84 audit that were
 * confirmed on a device.
 *
 * - CX2.1 / CXX2.1: a toast was never told to VoiceOver (iOS has no live regions).
 * - CX2.3 / CX3.8 / CXX3.4: a failed load and going offline were silent.
 * - CX2.5 / CXX2.9: the widget preview said importance by dot colour only.
 * - CX2.6 / CXX2.6: the first frames after mount ignored Reduce Motion.
 * - CX2.8: the tabs were announced as buttons, with no tab-bar container.
 * - CX2.9: the voice-language chip's own button was under 44 pt.
 * - CX2.10: the scrim that closes a sheet or a dialog had no button role.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo, Animated, Platform, StyleSheet } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { onlineManager } from '@tanstack/react-query';
import { AppProvider, useApp } from '../state/AppContext';
import { ToastHost } from '../ui/toast';
import { QueryBoundary } from '../api/ui/QueryBoundary';
import { OfflineBanner } from '../api/ui/OfflineBanner';
import { NetworkError } from '../api/errors';
import { TabBar } from '../screens/TabBar';
import { BottomSheet } from '../ui/bottomSheet';
import { Dialog } from '../ui/dialog';
import { VoiceLanguageChip } from '../features/capture/voice/VoiceLanguageChip';
import { ScreenIn } from '../ui/motion';
import { WidgetPreviewRow } from '../features/widget/WidgetSettingsScreen';
import en from '../i18n/locales/en.json';

const METRICS: Metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const originalOs = Platform.OS;

function setOs(os: 'ios' | 'android') {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
}

function spyAnnounce() {
  const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
  // Already a jest.fn in RN's preset: it keeps the calls of earlier tests.
  announce.mockClear();
  return announce;
}

afterEach(async () => {
  await cleanup();
  setOs(originalOs as 'ios' | 'android');
  onlineManager.setOnline(true);
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('CX2.1: a toast is told to VoiceOver', () => {
  const app: { current: ReturnType<typeof useApp> | null } = { current: null };
  function Probe() {
    const value = useApp();
    React.useEffect(() => { app.current = value; });
    return null;
  }
  async function showHost() {
    await render(<SafeAreaProvider initialMetrics={METRICS}><AppProvider><ToastHost /><Probe /></AppProvider></SafeAreaProvider>);
  }

  it('announces every toast on iOS, the same words twice in a row too', async () => {
    setOs('ios');
    const announce = spyAnnounce();
    await showHost();
    await act(async () => { app.current!.actions.toast('Marked done'); });
    expect(announce).toHaveBeenCalledWith('Marked done');
    await act(async () => { app.current!.actions.toast('Marked done'); });
    expect(announce.mock.calls.filter(([line]) => line === 'Marked done')).toHaveLength(2);
  });

  it('says the undo window with it when there is one', async () => {
    setOs('ios');
    const announce = spyAnnounce();
    await showHost();
    await act(async () => { app.current!.actions.toast('Postponed', () => undefined); });
    expect(announce).toHaveBeenCalledWith(`Postponed. ${app.current!.tr('toastUndoWithin', { s: 5 })}`);
  });

  it('leaves Android to the live region, so it is not said twice', async () => {
    setOs('android');
    const announce = spyAnnounce();
    await showHost();
    await act(async () => { app.current!.actions.toast('Marked done'); });
    expect(announce).not.toHaveBeenCalled();
  });
});

describe('CX2.3: a failed load and going offline are said', () => {
  it('announces the load failure and marks it as an alert', async () => {
    const announce = spyAnnounce();
    await render(<AppProvider><QueryBoundary isPending={false} error={new NetworkError()} onRetry={() => undefined}><></></QueryBoundary></AppProvider>);
    const box = screen.getByTestId('query-error');
    expect(box.props.accessibilityRole).toBe('alert');
    expect(announce).toHaveBeenCalledTimes(1);
    expect(String(announce.mock.calls[0]![0]).length).toBeGreaterThan(0);
  });

  it('announces once when the connection drops, not while it stays down', async () => {
    const announce = spyAnnounce();
    await render(<SafeAreaProvider initialMetrics={METRICS}><AppProvider><OfflineBanner /></AppProvider></SafeAreaProvider>);
    expect(announce).not.toHaveBeenCalled();
    await act(async () => { onlineManager.setOnline(false); });
    expect(screen.getByTestId('offline-banner')).toBeTruthy();
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(en.offline);
  });
});

describe('CX2.5: the widget preview says importance in a word', () => {
  it.each([
    ['must', en.todayGroupMust],
    ['should', en.todayGroupShould],
    ['nice', en.todayGroupNice],
  ] as const)('a %s row carries «%s» on screen and in its name', async (priority, word) => {
    await render(<AppProvider><WidgetPreviewRow index={1} item={{
      id: 'a', title: 'Call the bank', titleRedacted: false, redactionReason: null, priority, timeLabel: '10:00',
      dueAt: null, category: 'personal', isNextStep: false, link: 'maybesitter://commitment/a',
    }} /></AppProvider>);
    expect(screen.getByText(word)).toBeTruthy();
    expect(String(screen.getByTestId('widget-preview-row').props.accessibilityLabel)).toContain(word);
  });
});

describe('CX2.6: Reduce Motion is honoured from the first frame', () => {
  it('does not start the entrance before the setting is known', async () => {
    // The answer never comes back during this test: the first frames are what is asked about.
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockReturnValue(new Promise<boolean>(() => undefined));
    const timing = jest.spyOn(Animated, 'timing');
    await render(<ScreenIn><></></ScreenIn>);
    expect(timing).toHaveBeenCalled();
    expect((timing.mock.calls[0]![1] as { duration: number }).duration).toBe(0);
  });
});

describe('CX2.8: the bar is a tab bar', () => {
  it('names the bar as a tab list and each screen as a tab', async () => {
    await render(<SafeAreaProvider initialMetrics={METRICS}><AppProvider><TabBar /></AppProvider></SafeAreaProvider>);
    expect(['tabbar', 'tablist']).toContain(screen.getByTestId('tab-bar-row').props.accessibilityRole);
    for (const id of ['tab-today', 'tab-calendar', 'tab-things', 'tab-watching']) {
      expect(screen.getByTestId(id).props.accessibilityRole).toBe('tab');
    }
  });
});

describe('CX2.9: the voice-language chip is a 44 pt target', () => {
  it('its own button is at least 44 high', async () => {
    await render(<AppProvider><VoiceLanguageChip value="ar" onChange={() => undefined} /></AppProvider>);
    const style = StyleSheet.flatten(screen.getByTestId('voice-language').props.style) as { minHeight?: number };
    expect(style.minHeight ?? 0).toBeGreaterThanOrEqual(44);
  });
});

describe('CX2.10: the scrim that closes is a button', () => {
  beforeEach(() => { jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true); });

  it('in a bottom sheet', async () => {
    await render(<SafeAreaProvider initialMetrics={METRICS}><AppProvider><BottomSheet visible onClose={() => undefined}><></></BottomSheet></AppProvider></SafeAreaProvider>);
    expect(screen.getAllByRole('button', { name: en.close }).length).toBeGreaterThan(0);
  });

  it('in a dialog', async () => {
    await render(<AppProvider><Dialog title="Delete?" body="b" confirmLabel="Delete" cancelLabel="Keep it" onConfirm={() => undefined} onCancel={() => undefined} /></AppProvider>);
    // The scrim and the cancel button both say «Keep it»; both are buttons.
    expect(screen.getAllByRole('button', { name: 'Keep it' })).toHaveLength(2);
  });
});
