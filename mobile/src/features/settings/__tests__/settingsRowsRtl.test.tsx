/**
 * Settings rows in Arabic (first iPhone run, L7 audit).
 *
 * The rows carry no direction of their own: a flex row whose order is
 * icon → words → chevron in source, mirrored by the root View's `direction`
 * (`src/Root.tsx`). What can go wrong in code — and what this asserts is
 * absent — is a row that pins itself LTR (`direction: 'ltr'`, `row-reverse`,
 * a physical `left`/`right`), or a chevron that still points right in RTL.
 * Whether the device draws it mirrored is a device check; jest has no layout.
 */
import React from 'react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, describe, expect, it } from '@jest/globals';
import { cleanup, render, screen, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider } from '../../../state/AppContext';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import { SettingsRow } from '../SettingsChrome';
import { ProductRow } from '../../../ui/product';

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };

afterEach(async () => {
  cleanup();
  await AsyncStorage.clear();
});

async function inLanguage(lang: 'ar' | 'en', node: React.ReactElement) {
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
  return render(<SafeAreaProvider initialMetrics={metrics}><AppProvider>{node}</AppProvider></SafeAreaProvider>);
}

type Node = { type: string; props: Record<string, unknown>; children: (Node | string)[] | null };

/** Every host node under `node`, depth first, in source order. */
function walk(node: Node | string, out: Node[] = []): Node[] {
  if (typeof node === 'string') return out;
  out.push(node);
  for (const child of node.children ?? []) walk(child, out);
  return out;
}

/**
 * Where the chevron's tip is: the polyline '15,5 8,12 15,19' (tip at x=8)
 * points left, which is onward in RTL; '9,5 16,12 9,19' (tip at x=16) right.
 * react-native-svg hands the host a path, so the tip is read from its `d`.
 */
function chevronPoints(nodes: Node[]): string | undefined {
  const path = nodes.find(n => typeof n.props.d === 'string');
  const numbers = String(path?.props.d ?? '').match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
  if (numbers.length < 6) return undefined;
  const [x1, y1, x2, y2, x3, y3] = numbers;
  return `${x1},${y1} ${x2},${y2} ${x3},${y3}`;
}

function assertNoPinnedDirection(nodes: Node[]) {
  for (const node of nodes) {
    const style = StyleSheet.flatten(node.props.style as never) as Record<string, unknown> | undefined;
    if (!style) continue;
    expect(style.direction).toBeUndefined();
    expect(style.flexDirection === 'row-reverse').toBe(false);
    expect(style.left === undefined || style.left === 0).toBe(true);
    expect(style.right === undefined || style.right === 0).toBe(true);
  }
}

describe('SettingsRow', () => {
  it.each([
    ['ar', '15,5 8,12 15,19'],
    ['en', '9,5 16,12 9,19'],
  ] as ['ar' | 'en', string][])('%s: icon, words, then a chevron pointing onward', async (lang, points) => {
    await inLanguage(lang, <SettingsRow label="Calendar" sub="On" icon="calendar" onPress={() => {}} testID="row" />);
    await waitFor(() => expect(screen.queryByTestId('row')).not.toBeNull());
    const row = screen.getByLabelText('Calendar');
    const nodes = walk(row as unknown as Node);
    assertNoPinnedDirection(nodes);
    const rowStyle = StyleSheet.flatten(row.props.style) as Record<string, unknown>;
    expect(rowStyle.flexDirection).toBe('row');
    // Source order: the icon's svg, then the label, then the chevron's svg.
    const svgs = nodes.filter(n => n.type === 'RNSVGSvgView');
    const label = nodes.findIndex(n => n.props.testID === 'row');
    expect(svgs).toHaveLength(2);
    expect(nodes.indexOf(svgs[0]!)).toBeLessThan(label);
    expect(nodes.indexOf(svgs[1]!)).toBeGreaterThan(label);
    expect(chevronPoints(walk(svgs[1]!))).toBe(points);
  });
});

describe('ProductRow', () => {
  it.each([
    ['ar', '15,5 8,12 15,19'],
    ['en', '9,5 16,12 9,19'],
  ] as ['ar' | 'en', string][])('%s: icon, words, then a chevron pointing onward', async (lang, points) => {
    await inLanguage(lang, <ProductRow title="Trust" body="What it knows" icon="shield" onPress={() => {}} id="prow" />);
    await waitFor(() => expect(screen.queryByTestId('prow')).not.toBeNull());
    const row = screen.getByTestId('prow');
    const nodes = walk(row as unknown as Node);
    assertNoPinnedDirection(nodes);
    const svgs = nodes.filter(n => n.type === 'RNSVGSvgView');
    const title = nodes.findIndex(n => (n.children ?? []).includes('Trust'));
    expect(svgs).toHaveLength(2);
    expect(nodes.indexOf(svgs[0]!)).toBeLessThan(title);
    expect(nodes.indexOf(svgs[1]!)).toBeGreaterThan(title);
    expect(chevronPoints(walk(svgs[1]!))).toBe(points);
  });
});

describe('the root', () => {
  it('sets the direction once, from the language', () => {
    const root = readFileSync(join(__dirname, '..', '..', '..', 'Root.tsx'), 'utf8');
    expect(root).toContain("direction: rtl ? 'rtl' : 'ltr'");
  });
});
