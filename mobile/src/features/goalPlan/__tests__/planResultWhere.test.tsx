import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { screen, waitFor, within } from '@testing-library/react-native';
import {
  M3aServer, RESULT, defaultReply, openGoal, prepare, press, teardown, type M3aHarness,
} from '../../../__acceptance__/m3a/harness';
import { strings } from '../../../i18n/strings';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'UTC' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

/**
 * QA v3 V3-F22-06/08: «Save 2 steps» answered «2 steps are now in Today and
 * Plan», but a step that repeats is saved as a habit, and a habit shows on
 * neither Today nor Plan — only under My things › Habits. The English run
 * saved two repeating steps and found nothing on Today. The result now says
 * where each kind went: one-time steps on Today, repeating ones under Habits,
 * and never promises Plan (saving a goal plan builds no day plan).
 */
let harness: M3aHarness | undefined;
afterEach(async () => {
  await teardown(harness);
  harness = undefined;
});

const textOf = (testID: string): string => {
  const node = screen.getByTestId(testID);
  const children = node.props.children as unknown;
  return Array.isArray(children) ? children.join('') : String(children);
};

type Saved = (typeof RESULT.saved)[number];

/**
 * The times the person reviews, with every step not in `saved` moved to a
 * later week, so the confirm answer below is the one the client accepts for
 * them (the client holds the answer to the reviewed times).
 */
function laterExcept(body: unknown, keep: ReadonlySet<string>, moved: ReadonlySet<string>): unknown {
  if (Array.isArray(body)) return body.map((item) => laterExcept(item, keep, moved));
  if (!body || typeof body !== 'object') return body;
  const record = body as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) out[key] = laterExcept(value, keep, moved);
  if ('timesId' in record && Array.isArray(record.steps)) {
    out.steps = (record.steps as Array<{ stepId: string; kind: string }>).map((step) => (moved.has(step.stepId)
      ? { stepId: step.stepId, kind: step.kind, later: { weekIndex: 2 } } : step));
  }
  return out;
}

async function confirmWith(language: 'en' | 'ar', saved: readonly Saved[]): Promise<void> {
  const keep = new Set(saved.map((item) => item.stepId));
  const moved = new Set(RESULT.saved.filter((item) => !keep.has(item.stepId)).map((item) => item.stepId));
  const stayed = [
    ...RESULT.saved.filter((item) => moved.has(item.stepId))
      .map((item) => ({ stepId: item.stepId, title: item.title, why: { kind: 'later_week', weekIndex: 2 } })),
    ...RESULT.stayed,
  ];
  harness = await prepare(language, new M3aServer(async (request) => {
    if (request.path.endsWith('/confirm')) return { status: 200, body: { success: true, ...RESULT, saved, stayed } };
    const reply = defaultReply(request);
    return { ...reply, body: laterExcept(reply.body, keep, moved) };
  }));
  await openGoal(harness);
  await screen.findByTestId('goal-plan-open');
  await press('goal-plan-open');
  await waitFor(() => expect(screen.queryByTestId('plan-approve')).not.toBeNull());
  await press('plan-approve');
  await waitFor(() => expect(screen.queryByTestId('plan-times-next')).not.toBeNull());
  if (keep.has('step-none')) {
    await press('plan-times-none-step-none');
    await waitFor(() => expect(harness!.server.matching('PATCH', /\/times\/step-none$/)).toHaveLength(1));
  }
  await press('plan-times-next');
  await waitFor(() => expect(screen.queryByTestId('plan-confirm')).not.toBeNull());
  await press('plan-confirm');
  await waitFor(() => expect(screen.queryByTestId('plan-result')).not.toBeNull());
}

const COMMITMENTS = RESULT.saved.filter((item) => item.entity === 'commitment');
const HABITS = RESULT.saved.filter((item) => item.entity === 'habit');

describe('the saved-plan result says where each step went', () => {
  it('two one-time steps and one repeating step, in English', async () => {
    await confirmWith('en', RESULT.saved);
    expect(textOf('plan-result-where-steps')).toBe('2 steps are now in Today or the days ahead.');
    expect(textOf('plan-result-where-habits')).toBe('1 repeating step is now under Habits in My things.');
    expect(screen.queryByText(/Today and Plan/)).toBeNull();
  });

  it('only repeating steps (the English QA run): nothing claims Today', async () => {
    await confirmWith('en', HABITS);
    expect(screen.queryByTestId('plan-result-where-steps')).toBeNull();
    expect(textOf('plan-result-where-habits')).toBe('1 repeating step is now under Habits in My things.');
    expect(screen.queryByText(/in Today/)).toBeNull();
  });

  it('only one-time steps, in Arabic: no habits line, and no promise about the plan', async () => {
    await confirmWith('ar', COMMITMENTS);
    expect(textOf('plan-result-where-steps')).toBe('خطوتين صاروا بيومك أو بالأيام الجاية.');
    expect(screen.queryByTestId('plan-result-where-habits')).toBeNull();
    expect(screen.queryByText(/وبالخطة/)).toBeNull();
  });

  // Reviewer of #875: when every step stays for a later week the confirm
  // still runs, and the result said «Plan saved» over an empty list.
  it('nothing saved: the title says so, and no where-line claims anything', async () => {
    await confirmWith('en', []);
    expect(within(screen.getByTestId('plan-result-title')).queryByText('Nothing saved yet')).not.toBeNull();
    expect(screen.queryByText('Plan saved')).toBeNull();
    expect(screen.queryByTestId('plan-result-where-steps')).toBeNull();
    expect(screen.queryByTestId('plan-result-where-habits')).toBeNull();
  });

  it('nothing saved, in Arabic', async () => {
    await confirmWith('ar', []);
    expect(within(screen.getByTestId('plan-result-title')).queryByText('ما انحفظ إشي هلّق')).not.toBeNull();
    expect(screen.queryByText(strings.ar.xPlanSavedTitle)).toBeNull();
  });

  it('something saved keeps the saved title', async () => {
    await confirmWith('en', RESULT.saved);
    expect(within(screen.getByTestId('plan-result-title')).queryByText('Plan saved')).not.toBeNull();
  });

  it('every language carries both sentences', () => {
    for (const lang of ['ar', 'en', 'he'] as const) {
      expect(typeof strings[lang].xPlanSavedStepsN).toBe('string');
      expect(typeof strings[lang].xPlanSavedHabitsN).toBe('string');
      expect(typeof strings[lang].xPlanNothingSavedTitle).toBe('string');
    }
  });
});
