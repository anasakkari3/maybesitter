import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { MemoryScreen } from '../../features/memory/MemoryScreen';
import {
  NOW,
  Providers,
  ZONE,
  fact,
  flatStyle,
  prepareM6b,
  teardown,
  translationPath,
  type M6bHarness,
} from './harness';

process.env.TZ = ZONE;

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: jest.fn(() => ({ width: 390, height: 844, scale: 3, fontScale: 3.12 })),
}));

let harness: M6bHarness | undefined;

interface TestNode {
  props: Record<string, unknown>;
  parent: TestNode | null;
  children: (TestNode | string)[];
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(async () => {
  await teardown(harness);
  harness = undefined;
  jest.useRealTimers();
});

function expectNoClampedDescendant(node: ReturnType<typeof screen.getByTestId>): void {
  const descendants = (root: TestNode): TestNode[] => root.children.flatMap(child => (
    typeof child === 'string' ? [] : [child, ...descendants(child)]
  ));
  const clamped = [node as TestNode, ...descendants(node as TestNode)]
    .filter(descendant => descendant.props.numberOfLines === 1);
  expect(clamped).toHaveLength(0);
}

function expectWrappedAncestor(node: ReturnType<typeof screen.getByTestId>): void {
  let ancestor = (node as TestNode).parent;
  while (ancestor !== null && flatStyle(ancestor).flexWrap !== 'wrap') ancestor = ancestor.parent;
  expect(ancestor).not.toBeNull();
}

describe('M6a-2 accessibility and AX5 layout', () => {
  it.each(['ar', 'en', 'he'] as const)(
    'R2 %s action names its fact, exposes 44 points, wraps at AX5, and panel controls stay operable',
    async language => {
      const content = language === 'en'
        // Arabic: "a long meeting with the school team tomorrow morning".
        ? '\u0627\u062c\u062a\u0645\u0627\u0639 \u0637\u0648\u064a\u0644 \u0645\u0639 \u0641\u0631\u064a\u0642 \u0627\u0644\u0645\u062f\u0631\u0633\u0629 \u0628\u0643\u0631\u0629 \u0627\u0644\u0635\u0628\u062d'
        : 'A long meeting with the school team tomorrow morning';
      const proposal = language === 'ar'
        // Arabic: "a long meeting with the school team on Sunday morning".
        ? '\u0627\u062c\u062a\u0645\u0627\u0639 \u0637\u0648\u064a\u0644 \u0645\u0639 \u0641\u0631\u064a\u0642 \u0627\u0644\u0645\u062f\u0631\u0633\u0629 \u064a\u0648\u0645 \u0627\u0644\u0623\u062d\u062f \u0627\u0644\u0635\u0628\u062d'
        : language === 'he'
          // Hebrew: "a long meeting with the school team on Sunday morning".
          ? '\u05e4\u05d2\u05d9\u05e9\u05d4 \u05d0\u05e8\u05d5\u05db\u05d4 \u05e2\u05dd \u05e6\u05d5\u05d5\u05ea \u05d1\u05d9\u05ea \u05d4\u05e1\u05e4\u05e8 \u05d1\u05d9\u05d5\u05dd \u05e8\u05d0\u05e9\u05d5\u05df \u05d1\u05d1\u05d5\u05e7\u05e8'
          : 'A long meeting with the school team on Sunday morning';
      const id = `mem_ax5_${language}`;
      harness = await prepareM6b(language, {
        memoryItems: [fact(id, content)],
        handler: request => translationPath(id).test(request.path)
          ? {
              status: 200,
              body: {
                success: true,
                proposal: {
                  status: 'ready',
                  text: proposal,
                  from: language === 'en' ? 'ar' : 'en',
                  to: language,
                  memoryId: id,
                },
              },
            }
          : undefined,
      });
      await render(<Providers harness={harness}><MemoryScreen onBack={() => undefined} /></Providers>);
      await waitFor(() => expect(screen.queryByTestId(`m6-translate-action-${id}`)).not.toBeNull());

      const action = screen.getByTestId(`m6-translate-action-${id}`);
      expect(action.props.accessibilityRole).toBe('button');
      expect(String(action.props.accessibilityLabel)).toContain(content);
      expect(Number(flatStyle(action).minHeight)).toBeGreaterThanOrEqual(44);
      expectWrappedAncestor(action);
      expectNoClampedDescendant(action);

      await fireEvent.press(action);
      await waitFor(() => expect(screen.queryByTestId(`m6-translate-panel-${id}`)).not.toBeNull());
      for (const testID of [`m6-translate-request-${id}`, `m6-translate-keep-${id}`]) {
        const button = screen.getByTestId(testID);
        expect(button.props.accessibilityRole).toBe('button');
        expect(Number(flatStyle(button).minHeight)).toBeGreaterThanOrEqual(44);
        expectNoClampedDescendant(button);
      }

      await fireEvent.press(screen.getByTestId(`m6-translate-request-${id}`));
      await waitFor(() => expect(screen.queryByTestId(`m6-translate-proposal-${id}`)).not.toBeNull());
      expect(flatStyle(screen.getByTestId(`m6-translate-proposal-${id}`))).toMatchObject({
        writingDirection: language === 'en' ? 'ltr' : 'rtl',
      });
      expectNoClampedDescendant(screen.getByTestId(`m6-translate-panel-${id}`));
      for (const testID of [`m6-translate-save-${id}`, `m6-translate-keep-${id}`]) {
        expect(Number(flatStyle(screen.getByTestId(testID)).minHeight)).toBeGreaterThanOrEqual(44);
      }
    },
  );
});

