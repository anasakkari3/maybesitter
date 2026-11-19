/**
 * «احفظ هاليوم» through the real query layer (QA v3, V3-F15-01).
 *
 * `WeekScreen.test.tsx` replaces the hooks; this one keeps them, with the
 * routes answered by the m5b harness, because the defect lived between the
 * press and the hook: the guard read `save.isPending` from the last render,
 * so a second press before React re-rendered sent a second save. The first
 * saved the day; the second came back 409 «هاليوم صار إلو خطة», and the
 * first answer's «حفظنا خطة هاليوم» was never drawn — the person was told
 * the save failed when it had worked.
 */
import React from 'react';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import weekFixture from '../../../api/__fixtures__/plan.week.json';
import acceptedFixture from '../../../api/__fixtures__/plan.weekAccepted.json';
import alreadyFixture from '../../../api/__fixtures__/plan.weekAlreadyPlanned.json';
import { Providers, initialState, prepare, teardown, type M5bHarness, type RouteHandler, type RouteReply } from '../../../__acceptance__/m5b/harness';
import { strings } from '../../../i18n/strings';
import { WeekScreen } from '../WeekScreen';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'ar', languageTag: 'ar', textDirection: 'rtl' }]),
}));

let harness: M5bHarness | undefined;
afterEach(async () => {
  if (harness) await teardown(harness);
  harness = undefined;
});

/** The server: the first save stores the day; any later one finds it planned. */
function server(): { handler: RouteHandler; saves: () => number; release: () => void } {
  let saves = 0;
  let release: () => void = () => undefined;
  const first = new Promise<RouteReply>(resolve => { release = () => resolve({ status: 200, body: acceptedFixture }); });
  return {
    handler: request => {
      if (request.path === '/api/mobile/plans/week' && request.method === 'POST') return { status: 200, body: weekFixture };
      if (request.path === '/api/mobile/plans/week/accept' && request.method === 'POST') {
        saves += 1;
        return saves === 1 ? first : { status: 409, body: alreadyFixture };
      }
      return undefined;
    },
    saves: () => saves,
    release: () => release(),
  };
}

describe('«احفظ هاليوم» (V3-F15-01)', () => {
  it('a second press before the screen redraws sends nothing, and the saved day says it was saved', async () => {
    const routes = server();
    harness = await prepare('ar', initialState(), routes.handler);
    await render(<Providers harness={harness}><WeekScreen /></Providers>);
    const t = strings.ar;
    await waitFor(() => expect(screen.getAllByText(t.weekSaveDay).length).toBeGreaterThan(0));
    const day = (screen.getAllByTestId(/^week-save-/)[0]!.props.testID as string).replace('week-save-', '');
    const button = screen.getByTestId(`week-save-${day}`);

    // Two presses in the same frame: the second must not reach the server.
    // `fireEvent.press` awaits a render of its own; the press is sent twice
    // inside one act instead, which is what two quick taps are.
    // The host's click handler is Pressable's own path to `onPress`.
    const click = button.props.onClick as ((event: object) => void) | undefined;
    expect(typeof click).toBe('function');
    const event = { nativeEvent: {}, persist: () => undefined };
    await act(async () => {
      click!(event);
      click!(event);
      await Promise.resolve();
    });
    await waitFor(() => expect(routes.saves()).toBeGreaterThan(0));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(routes.saves()).toBe(1);
    await act(async () => { routes.release(); });

    await waitFor(() => expect(screen.getByTestId(`week-saved-${day}`).props.children).toBe(t.weekSavedToast));
    expect(screen.queryByTestId(`week-error-${day}`)).toBeNull();
    expect(routes.saves()).toBe(1);
  });

  it('the guard lets go once a save settles: after a failure the day can be saved again', async () => {
    let saves = 0;
    const handler: RouteHandler = request => {
      if (request.path === '/api/mobile/plans/week' && request.method === 'POST') return { status: 200, body: weekFixture };
      if (request.path === '/api/mobile/plans/week/accept' && request.method === 'POST') {
        saves += 1;
        return saves === 1 ? { status: 500, body: { success: false, error: 'offline' } } : { status: 200, body: acceptedFixture };
      }
      return undefined;
    };
    harness = await prepare('ar', initialState(), handler);
    await render(<Providers harness={harness}><WeekScreen /></Providers>);
    const t = strings.ar;
    await waitFor(() => expect(screen.getAllByText(t.weekSaveDay).length).toBeGreaterThan(0));
    const day = (screen.getAllByTestId(/^week-save-/)[0]!.props.testID as string).replace('week-save-', '');
    const press = async () => {
      const click = screen.getByTestId(`week-save-${day}`).props.onClick as (event: object) => void;
      await act(async () => { click({ nativeEvent: {}, persist: () => undefined }); await Promise.resolve(); });
    };

    await press();
    await waitFor(() => expect(screen.getByTestId(`week-error-${day}`)).toBeTruthy());
    await press();
    await waitFor(() => expect(saves).toBe(2));
    await waitFor(() => expect(screen.getByTestId(`week-saved-${day}`).props.children).toBe(t.weekSavedToast));
  });
});
