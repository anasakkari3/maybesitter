/**
 * Live regions that TalkBack can actually hear (POLISH-MOBILE review I1).
 *
 * Android announces a live region when content changes *inside* a view that
 * already carries the region. A region mounted together with its text — the
 * `{failed ? <View accessibilityLiveRegion="polite">…</View> : null}` shape —
 * arrives in one step, as a subtree change of a parent that is not a region,
 * and TalkBack says nothing. So a region is mounted before its text, and only
 * the text is conditional (`LiveRegion`).
 *
 * The census below keeps the shape out: a live region is `LiveRegion`, never
 * mounted behind a condition, or one of the listed always-mounted views.
 */
import React from 'react';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { act, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo, Animated, Platform, StyleSheet, Text } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { LiveRegion } from '../liveRegion';
import { useAnnounceOnIos } from '../announce';
import { AppProvider, useApp } from '../../state/AppContext';
import { ToastHost } from '../toast';

const SRC = join(__dirname, '..', '..');

/**
 * Raw `accessibilityLiveRegion` is allowed only here, each always mounted.
 * VoiceButton's note is the one exception, and it announces itself on every
 * platform (`announceForAccessibility`), so the region is not what is heard.
 */
const RAW_ALLOWED: Record<string, string> = {
  'ui/liveRegion.tsx': 'the component itself',
  'ui/toast.tsx': 'the host view is always mounted; only the pill is conditional',
  'screens/ReviewScreen.tsx': 'review-prep-live wraps whichever line shows',
  'screens/PlanScreen.tsx': 'plan-accept-slot is always mounted and measured; the button or the accepted line inside it changes',
  'features/onboarding/SetupChatStep.tsx': 'the row cell is always mounted',
  'features/google/GoogleIntegrationScreen.tsx': 'the status view is always mounted',
  'features/capture/voice/VoiceButton.tsx': 'announced explicitly on every platform',
  'features/capture/SayItChatPage.tsx': 'chat-live is always mounted under the conversation; the typing bubble or the newest reply inside it changes',
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === '__tests__' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry) ? [path] : [];
  });
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

/** Where a JSX element that is mounted behind `?` or `&&` opens a live region. */
function conditionalRegions(source: string): number[] {
  const lines: number[] = [];
  const opener = /<LiveRegion\b|<(?:View|Animated\.View)\b(?=(?:[^<>]|=>)*accessibilityLiveRegion=)/g;
  for (const match of source.matchAll(opener)) {
    const before = source.slice(0, match.index).replace(/\s+$/, '');
    if (/(\?|&&|\?\s*\(|&&\s*\()$/.test(before)) lines.push(source.slice(0, match.index).split('\n').length);
  }
  return lines;
}

describe('the live-region census', () => {
  const files = sourceFiles(SRC).map((path) => ({ rel: relative(SRC, path), text: stripComments(readFileSync(path, 'utf8')) }));

  it('uses a raw accessibilityLiveRegion only in the listed always-mounted views', () => {
    const raw = files.filter((file) => file.text.includes('accessibilityLiveRegion=')).map((file) => file.rel);
    expect(raw.filter((rel) => !(rel in RAW_ALLOWED))).toEqual([]);
  });

  it('never mounts a live region behind a condition', () => {
    const found = files.flatMap((file) => conditionalRegions(file.text).map((line) => `${file.rel}:${line}`));
    expect(found).toEqual([]);
  });

  it('would catch the shape it exists for', () => {
    expect(conditionalRegions('{failed ? (\n  <View accessibilityLiveRegion="polite"><Txt/></View>\n) : null}')).toEqual([2]);
    expect(conditionalRegions('{failed ? <LiveRegion><Txt/></LiveRegion> : null}')).toEqual([1]);
    expect(conditionalRegions('{ok && <LiveRegion><Txt/></LiveRegion>}')).toEqual([1]);
    expect(conditionalRegions('<LiveRegion>{failed ? <Txt/> : null}</LiveRegion>')).toEqual([]);
  });
});

describe('LiveRegion', () => {
  it('is mounted, polite and out of the layout while it has nothing to say', async () => {
    await render(<LiveRegion testID="live" style={{ paddingTop: 8 }}>{null}</LiveRegion>);
    const live = screen.getByTestId('live');
    expect(live.props.accessibilityLiveRegion).toBe('polite');
    // Out of the flow, so an empty region adds no gap or padding to its parent.
    expect(StyleSheet.flatten(live.props.style)).toMatchObject({ position: 'absolute' });
  });

  it('takes its own style once it has a line', async () => {
    await render(<LiveRegion testID="live" style={{ paddingTop: 8 }}><Text>x</Text></LiveRegion>);
    expect(StyleSheet.flatten(screen.getByTestId('live').props.style)).toEqual({ paddingTop: 8 });
  });
});

const METRICS: Metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };

describe('the toast host', () => {
  const app: { current: ReturnType<typeof useApp> | null } = { current: null };
  function Probe() {
    const value = useApp();
    React.useEffect(() => { app.current = value; });
    return null;
  }
  async function showHost() {
    await render(<SafeAreaProvider initialMetrics={METRICS}><AppProvider><ToastHost /><Probe /></AppProvider></SafeAreaProvider>);
  }

  /**
   * Everything inside the region a screen reader could be told about: every
   * label and every line of text, except in subtrees hidden from it. Android
   * raises a live-region change for a text change anywhere that is not hidden.
   */
  type Node = ReturnType<typeof screen.getByTestId>;
  function readable(node: Node | string): string {
    if (typeof node === 'string') return node;
    const props = node.props as { importantForAccessibility?: string; accessibilityElementsHidden?: boolean; accessibilityLabel?: string };
    if (props.importantForAccessibility === 'no-hide-descendants' || props.accessibilityElementsHidden) return '';
    const own = typeof node.type === 'string' && props.accessibilityLabel ? [props.accessibilityLabel] : [];
    return [...own, ...(node.children as (Node | string)[]).map(readable)].filter(Boolean).join(' | ');
  }

  afterEach(() => { jest.useRealTimers(); });

  it('keeps its live region mounted while no toast shows', async () => {
    await showHost();
    expect(screen.getByTestId('toast-live').props.accessibilityLiveRegion).toBe('polite');
    expect(screen.queryByTestId('toast')).toBeNull();
  });

  /*
   * POLISH-MOBILE review n6: the 5→1 countdown ticked inside the region, so
   * TalkBack could announce the toast again every second. The region says
   * the message and the undo window once; the ticking digits are hidden.
   */
  it('says the message and the undo window once, and nothing changes as the countdown ticks', async () => {
    jest.useFakeTimers({ now: new Date('2026-09-28T09:00:00.000Z') });
    await showHost();
    await act(async () => { app.current!.actions.toast('Marked done', () => undefined); });
    const window = app.current!.tr('toastUndoWithin', { s: 5 });
    const first = readable(screen.getByTestId('toast-live'));
    expect(first).toContain('Marked done');
    expect(first.split(window)).toHaveLength(2);
    await act(async () => { jest.advanceTimersByTime(2_000); });
    // The digits did tick; they are hidden, so only a hidden-inclusive query finds them.
    expect(screen.getByText('3', { includeHiddenElements: true })).toBeTruthy();
    expect(readable(screen.getByTestId('toast-live'))).toBe(first);
  });

  /*
   * Review n3: a new toast fades in from nothing, not from where the last one
   * was. The fade runs on the native driver, which Jest does not animate, so
   * the reset itself is what is observed.
   */
  it('puts the fade back to transparent when one toast gives way to the next', async () => {
    jest.useFakeTimers({ now: new Date('2026-09-28T09:00:00.000Z') });
    await showHost();
    await act(async () => { app.current!.actions.toast('First'); });
    await act(async () => { jest.advanceTimersByTime(1_000); });
    const setValue = jest.spyOn(Animated.Value.prototype, 'setValue');
    await act(async () => { app.current!.actions.toast('Second'); });
    expect(setValue).toHaveBeenCalledWith(0);
    setValue.mockRestore();
  });
});

/*
 * POLISH-MOBILE review m4: the iOS-only guard was held by no test, because
 * Jest's Platform is iOS. On Android the live region speaks; announcing too
 * would say every line twice.
 */
describe('useAnnounceOnIos', () => {
  const originalOs = Platform.OS;
  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: originalOs, configurable: true });
  });

  function Probe({ text }: { text: string | null }) {
    useAnnounceOnIos(text);
    return null;
  }

  it('tells VoiceOver on iOS', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
    announce.mockClear();
    await render(<Probe text="line" />);
    expect(announce).toHaveBeenCalledWith('line');
    announce.mockRestore();
  });

  it('says nothing itself on Android, where the live region speaks', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
    announce.mockClear();
    await render(<Probe text="line" />);
    expect(announce).not.toHaveBeenCalled();
    announce.mockRestore();
  });
});
