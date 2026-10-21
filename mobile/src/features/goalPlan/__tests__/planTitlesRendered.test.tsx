import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { screen, waitFor } from '@testing-library/react-native';
import { isolateAuto } from '../../../i18n/bidi';
import {
  M3aServer, defaultReply, openGoal, prepare, press, teardown, type M3aHarness,
} from '../../../__acceptance__/m3a/harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'UTC' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

/**
 * M6b BB-07 with Codex M6B-R3-004: every plan title the flow draws — the draft's
 * steps and its removed ones, the times screen, the confirm screen and the
 * result — keeps a quoted goal in its own direction. Rendered, not read from
 * the source: a title inside a sentence (`fill(...)`) counts too.
 */
const GOAL = 'إنهاء المشروع M6D';
const QUOTED = `“${GOAL}”`;
const ISOLATED = `“${isolateAuto(GOAL)}”`;
const TITLES = ['Plan three lunches', 'Walk after lunch', 'Prepare walking shoes', 'Find a class', 'Review the routine', 'Buy a scale'];

function quoting(body: unknown): unknown {
  let json = JSON.stringify(body);
  for (const title of TITLES) json = json.split(`"${title}"`).join(JSON.stringify(`${title} for ${QUOTED}`));
  return JSON.parse(json) as unknown;
}

function textOf(children: unknown): string {
  if (Array.isArray(children)) return children.map(textOf).join('');
  return typeof children === 'string' || typeof children === 'number' ? String(children) : '';
}

/** Every drawn text that carries the goal carries it isolated; and at least `least` do. */
function expectEveryTitleIsolated(least: number): void {
  const texts = screen.queryAllByText(new RegExp(GOAL.split(' ').pop()!)).map((node) => textOf(node.props.children));
  expect(texts.length).toBeGreaterThanOrEqual(least);
  for (const text of texts) expect(text).toContain(ISOLATED);
}

let harness: M3aHarness;

beforeEach(async () => {
  harness = await prepare('en', new M3aServer(async (request) => {
    const reply = defaultReply(request);
    return { ...reply, body: quoting(reply.body) };
  }));
});
afterEach(async () => {
  await teardown(harness);
});

describe('plan titles with a quoted goal', () => {
  it('stay isolated on the draft (steps and removed), times, confirm and result screens', async () => {
    await openGoal(harness);
    await screen.findByTestId('goal-plan-open');
    await press('goal-plan-open');
    await waitFor(() => expect(screen.queryByTestId('plan-approve')).not.toBeNull());
    expect(screen.queryByTestId('plan-removed-removed-1')).not.toBeNull();
    // Five steps and the removed one.
    expectEveryTitleIsolated(6);

    await press('plan-approve');
    await waitFor(() => expect(screen.queryByTestId('plan-times-step-step-1')).not.toBeNull());
    expectEveryTitleIsolated(4);

    await press('plan-times-none-step-none');
    await waitFor(() => expect(harness.server.matching('PATCH', /\/times\/step-none$/)).toHaveLength(1));
    await press('plan-times-next');
    await waitFor(() => expect(screen.queryByTestId('plan-confirm')).not.toBeNull());
    expect(screen.queryByTestId('plan-will-stay-removed-1')).not.toBeNull();
    expectEveryTitleIsolated(5);

    await press('plan-confirm');
    await waitFor(() => expect(screen.queryByTestId('plan-result')).not.toBeNull());
    expectEveryTitleIsolated(6);
  });
});
