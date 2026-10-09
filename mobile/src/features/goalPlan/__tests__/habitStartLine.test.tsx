/**
 * The times stage says when a later habit begins (#751, SIM-A4; the owner's
 * words, 2026-10-09: «من الأسبوع الجاي»).
 */
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { act, screen, waitFor } from '@testing-library/react-native';
import en from '../../../i18n/locales/en.json';
import ar from '../../../i18n/locales/ar.json';
import { M3aServer, defaultReply, openGoal, prepare, press, teardown, type M3aHarness } from '../../../__acceptance__/m3a/harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'UTC' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

let harness: M3aHarness | undefined;
afterEach(async () => { if (harness) await teardown(harness); harness = undefined; });

const TODAY = new Date().toISOString().slice(0, 10);

/** The default plan, made today, with the habit (step-2) in week `week`. */
function serverWithHabitInWeek(week: number): M3aServer {
  return new M3aServer(async (request) => {
    const reply = await defaultReply(request);
    const body = JSON.parse(JSON.stringify(reply.body)) as {
      plan?: { steps?: { stepId: string; phase: { unit: string; index: number } }[] };
      times?: { anchor: { localDate: string } };
    };
    for (const step of body.plan?.steps ?? []) if (step.stepId === 'step-2') step.phase = { unit: 'week', index: week };
    if (body.times) body.times.anchor.localDate = TODAY;
    return { ...reply, body };
  });
}

async function openTimes(language: 'ar' | 'en', week: number): Promise<void> {
  harness = await prepare(language, serverWithHabitInWeek(week));
  await openGoal(harness);
  await screen.findByTestId('goal-plan-open');
  await press('goal-plan-open');
  await waitFor(() => expect(screen.queryByTestId('plan-approve')).not.toBeNull());
  await press('plan-approve');
  await waitFor(() => expect(screen.queryByTestId('plan-times-weekly-step-2')).not.toBeNull());
}

const lineOf = () => String(screen.getByTestId('plan-times-weekly-step-2').props.children);

describe('a habit\'s line on the times stage', () => {
  it('says «من الأسبوع الجاي» for a habit in the plan\'s second week', async () => {
    await openTimes('ar', 2);
    expect(lineOf().startsWith(`${ar.xPlanFromNextWeek} · `)).toBe(true);
  });

  it('says it in English too, on the line and on its other times', async () => {
    await openTimes('en', 2);
    expect(lineOf().startsWith(`${en.xPlanFromNextWeek} · `)).toBe(true);
    await press('plan-times-change-step-2');
    expect(screen.getByTestId('plan-times-alt-step-2-1').props.accessibilityLabel).toContain(en.xPlanFromNextWeek);
  });

  it('says nothing more for a habit that begins this week', async () => {
    await openTimes('en', 1);
    expect(lineOf()).not.toContain(en.xPlanFromNextWeek);
    expect(lineOf()).toMatch(/^Mon/);
  });
  // Inspection FU-004: the day is the plan's zone's, not the phone's.
  describe('across midnight and zones', () => {
    afterEach(() => { jest.useRealTimers(); });

    /** A plan anchored in Tokyo on `anchor`, its habit in week 2, read by a phone on UTC. */
    function tokyoServer(anchor: string): M3aServer {
      return new M3aServer(async (request) => {
        const reply = await defaultReply(request);
        const body = JSON.parse(JSON.stringify(reply.body)) as {
          plan?: { steps?: { stepId: string; phase: { unit: string; index: number } }[] };
          times?: { anchor: { localDate: string; timezone: string } };
        };
        for (const step of body.plan?.steps ?? []) if (step.stepId === 'step-2') step.phase = { unit: 'week', index: 2 };
        if (body.times) body.times.anchor = { localDate: anchor, timezone: 'Asia/Tokyo' };
        return { ...reply, body };
      });
    }

    async function openTokyoTimes(anchor: string): Promise<void> {
      harness = await prepare('en', tokyoServer(anchor));
      await openGoal(harness);
      await screen.findByTestId('goal-plan-open');
      await press('goal-plan-open');
      await waitFor(() => expect(screen.queryByTestId('plan-approve')).not.toBeNull());
      await press('plan-approve');
      await waitFor(() => expect(screen.queryByTestId('plan-times-weekly-step-2')).not.toBeNull());
    }

    it('a week that has begun in the plan\'s zone is not «next week», though the phone\'s day is still the one before', async () => {
      // 2030-03-07 20:00 UTC is 2030-03-08 05:00 in Tokyo. The plan was made
      // on 03-01, so its second week began on 03-08: today, in Tokyo.
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'queueMicrotask', 'nextTick'] });
      jest.setSystemTime(new Date('2030-03-07T20:00:00Z'));
      await openTokyoTimes('2030-03-01');
      expect(lineOf()).not.toContain(en.xPlanFromNextWeek);
    });

    it('a line left open stops saying «next week» when the plan\'s zone reaches the week', async () => {
      // 14:30 UTC is 23:30 in Tokyo on 03-07: the second week begins in half an hour.
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'queueMicrotask', 'nextTick'] });
      jest.setSystemTime(new Date('2030-03-07T14:30:00Z'));
      await openTokyoTimes('2030-03-01');
      expect(lineOf().startsWith(`${en.xPlanFromNextWeek} · `)).toBe(true);
      await act(async () => { await jest.advanceTimersByTimeAsync(31 * 60_000); });
      expect(lineOf()).not.toContain(en.xPlanFromNextWeek);
    });
  });
});
