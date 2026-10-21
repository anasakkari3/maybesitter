import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { screen, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { isolateAuto } from '../../../i18n/bidi';
import {
  M3aServer, defaultReply, openGoal, prepare, press, teardown, type M3aHarness,
} from '../../../__acceptance__/m3a/harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'UTC' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

/**
 * M6b BB-07 with Codex M6B-R3-004 and R4-003: every plan title the flow draws —
 * the draft's steps and its removed ones, the times screen, the confirm screen
 * and the result — keeps a quoted goal in its own direction, and a title in
 * another language than the app's reads in its own direction (the templates
 * follow the goal's script, not the UI's). Rendered, not read from the source.
 */
const FIXTURE_TITLES = ['Plan three lunches', 'Walk after lunch', 'Prepare walking shoes', 'Find a class', 'Review the routine', 'Buy a scale'];

interface Case {
  name: string;
  ui: 'ar' | 'en';
  /** Each fixture title as the server would write it in the goal's language. */
  titles: readonly string[];
  /** The quoted goal, and how it must be drawn. */
  quoted: string;
  isolated: string;
  /** The words every title carries, to find them on screen. */
  marker: RegExp;
  direction: 'ltr' | 'rtl';
}

const AR_GOAL = 'إنهاء المشروع M6D';
const HE_GOAL = 'לסיים פרויקט M6D';
const EN_GOAL = 'Finish M6D project';
const CASES: Case[] = [
  {
    name: 'English titles quoting an Arabic goal, English app',
    ui: 'en', titles: FIXTURE_TITLES.map((title) => `${title} for “${AR_GOAL}”`),
    quoted: `“${AR_GOAL}”`, isolated: `“${isolateAuto(AR_GOAL)}”`, marker: /M6D/, direction: 'ltr',
  },
  {
    name: 'English titles in the Arabic app',
    ui: 'ar', titles: FIXTURE_TITLES.map((title) => `${title} for “${EN_GOAL}”`),
    quoted: `“${EN_GOAL}”`, isolated: `“${isolateAuto(EN_GOAL)}”`, marker: /M6D/, direction: 'ltr',
  },
  {
    name: 'Arabic titles in the English app',
    ui: 'en', titles: FIXTURE_TITLES.map((_, index) => `خطوة ${index + 1} لـ«${AR_GOAL}»`),
    quoted: `«${AR_GOAL}»`, isolated: `«${isolateAuto(AR_GOAL)}»`, marker: /M6D/, direction: 'rtl',
  },
  {
    name: 'Hebrew titles in the English app',
    ui: 'en', titles: FIXTURE_TITLES.map((_, index) => `שלב ${index + 1} של "${HE_GOAL}"`),
    quoted: `"${HE_GOAL}"`, isolated: `"${isolateAuto(HE_GOAL)}"`, marker: /M6D/, direction: 'rtl',
  },
];

function rewriting(body: unknown, titles: readonly string[]): unknown {
  let json = JSON.stringify(body);
  FIXTURE_TITLES.forEach((title, index) => { json = json.split(`"${title}"`).join(JSON.stringify(titles[index])); });
  return JSON.parse(json) as unknown;
}

function textOf(children: unknown): string {
  if (Array.isArray(children)) return children.map(textOf).join('');
  return typeof children === 'string' || typeof children === 'number' ? String(children) : '';
}

/**
 * Every drawn text carrying the goal carries it isolated, at least `least` do,
 * and each one that is a whole title (not a sentence around one) is set in the
 * title's own direction.
 */
function expectTitles(c: Case, least: number): void {
  const nodes = screen.queryAllByText(c.marker);
  expect(nodes.length).toBeGreaterThanOrEqual(least);
  let standalone = 0;
  for (const node of nodes) {
    const text = textOf(node.props.children);
    expect(text).toContain(c.isolated);
    if (!c.titles.some((title) => text === title.replace(c.quoted, c.isolated))) continue;
    standalone += 1;
    expect(StyleSheet.flatten(node.props.style)?.writingDirection).toBe(c.direction);
  }
  expect(standalone).toBeGreaterThan(0);
}

let harness: M3aHarness | undefined;
afterEach(async () => {
  await teardown(harness!);
  harness = undefined;
});

describe('plan titles with a quoted goal', () => {
  for (const c of CASES) {
    it(`${c.name}: isolated on the draft (steps and removed), times, confirm and result screens`, async () => {
      harness = await prepare(c.ui, new M3aServer(async (request) => {
        const reply = defaultReply(request);
        return { ...reply, body: rewriting(reply.body, c.titles) };
      }));
      await openGoal(harness);
      await screen.findByTestId('goal-plan-open');
      await press('goal-plan-open');
      await waitFor(() => expect(screen.queryByTestId('plan-approve')).not.toBeNull());
      expect(screen.queryByTestId('plan-removed-removed-1')).not.toBeNull();
      // Five steps and the removed one.
      expectTitles(c, 6);

      await press('plan-approve');
      await waitFor(() => expect(screen.queryByTestId('plan-times-step-step-1')).not.toBeNull());
      expectTitles(c, 4);

      await press('plan-times-none-step-none');
      await waitFor(() => expect(harness!.server.matching('PATCH', /\/times\/step-none$/)).toHaveLength(1));
      await press('plan-times-next');
      await waitFor(() => expect(screen.queryByTestId('plan-confirm')).not.toBeNull());
      expect(screen.queryByTestId('plan-will-stay-removed-1')).not.toBeNull();
      expectTitles(c, 5);

      await press('plan-confirm');
      await waitFor(() => expect(screen.queryByTestId('plan-result')).not.toBeNull());
      expectTitles(c, 6);
    });
  }
});
