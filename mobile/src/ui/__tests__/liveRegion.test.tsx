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
import { render, screen } from '@testing-library/react-native';
import { AccessibilityInfo, Platform, StyleSheet, Text } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { LiveRegion } from '../liveRegion';
import { useAnnounceOnIos } from '../announce';
import { AppProvider } from '../../state/AppContext';
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
  'features/onboarding/SetupChatStep.tsx': 'the row cell is always mounted',
  'features/google/GoogleIntegrationScreen.tsx': 'the status view is always mounted',
  'features/capture/voice/VoiceButton.tsx': 'announced explicitly on every platform',
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
  it('keeps its live region mounted while no toast shows', async () => {
    await render(<SafeAreaProvider initialMetrics={METRICS}><AppProvider><ToastHost /></AppProvider></SafeAreaProvider>);
    expect(screen.getByTestId('toast-live').props.accessibilityLiveRegion).toBe('polite');
    expect(screen.queryByTestId('toast')).toBeNull();
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
