import React, { Profiler, useEffect, useRef, useState } from 'react';
import { BackHandler, Pressable, View } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { basisCorrectionCountForTests, basisStateHeldForTests, queryKeys, resetBasisCorrections, useSetPersonalizationConsent } from '../../../api/queries';
import personalizationRecorded from '../../../api/__fixtures__/consents.personalizationRecorded.json';
import { ACCOUNT_A } from '../../../__acceptance__/m5b/harness';
import {
  BASIS_ID, MemoryMutationDriver, NOW, Providers, TODAY, deferred, initialState, memoryItem, outcome, panelHandler,
  planEnvelope, planWithBasis, prepare, showPanel, teardown, type M5bHarness, type RouteHandler, type RouteReply,
} from '../../../__acceptance__/m5b2a/harness';
import { PlanScreen } from '../../../screens/PlanScreen';
import { Root } from '../../../Root';
import { useApp } from '../../../state/AppContext';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

/** M5b-2a Task A inspection r1 (Codex M5B2A-REV-001…003). */
let harness: M5bHarness | undefined;
beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(NOW); });
afterEach(async () => { await teardown(harness); harness = undefined; jest.useRealTimers(); });

function planOnly(value: Record<string, unknown>, extra?: RouteHandler): RouteHandler {
  return (request) => {
    if (request.method === 'GET' && request.path === `/api/mobile/plans/${TODAY}`) return { status: 200, body: planEnvelope(value) };
    return extra?.(request);
  };
}

describe('M5b-2a inspection fixes', () => {
  it('REV-001: a cached on-mode plan shows no memory line or notice while M5b is off', async () => {
    harness = await prepare('en', initialState({ memoryLearning: false }), planOnly(planWithBasis(TODAY, BASIS_ID, { changed: true, rebuildsLeft: 0 })));
    await render(<Providers harness={harness}><PlanScreen date={TODAY} onBack={() => undefined} /></Providers>);
    await waitFor(() => expect(screen.queryByTestId('plan-why')).not.toBeNull());
    await act(async () => { await jest.advanceTimersByTimeAsync(100); });
    expect(screen.queryByTestId('m5b-plan-memory-basis')).toBeNull();
    expect(screen.queryByTestId('m5b-plan-memory-changed-no-rebuild')).toBeNull();
    expect(screen.queryByTestId('m5b-plan-memory-changed')).toBeNull();
  });

  it('REV-002: resetting on an account change forgets a correction that never settled', async () => {
    const held = deferred<RouteReply>();
    harness = await prepare('en', initialState({ memoryItems: [memoryItem(BASIS_ID)] }), planOnly(planWithBasis(), (request) => (
      request.method === 'PATCH' && request.path === `/api/mobile/memory/${BASIS_ID}` ? held.promise : undefined
    )));
    await render(<Providers harness={harness}><View>
      <PlanScreen date={TODAY} onBack={() => undefined} />
      <MemoryMutationDriver />
    </View></Providers>);
    await waitFor(() => expect(screen.queryByTestId('m5b-plan-memory-basis')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('gate-patch'));
    await waitFor(() => expect(screen.queryByTestId('m5b-plan-memory-basis')).toBeNull());
    await act(async () => { resetBasisCorrections(harness!.client); });
    await waitFor(() => expect(screen.queryByTestId('m5b-plan-memory-basis')).not.toBeNull());
  });

  it('REV-003: a dismissal the server confirmed removes the row even when the inbox re-read fails', async () => {
    const base = panelHandler({ observations: [outcome('confirmed-gone')] });
    let reads = 0;
    harness = await prepare('en', initialState(), (request) => {
      if (request.method === 'GET' && request.path === '/api/mobile/intelligence') {
        reads += 1;
        if (reads > 1) return { status: 503, body: { success: false, error: 'unavailable' } };
      }
      return base(request);
    });
    await showPanel(harness);
    await waitFor(() => expect(screen.queryByTestId('m5b-learned')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('m5b-learned'));
    await fireEvent.press(screen.getByTestId('m5b-learned-wrong-confirmed-gone'));
    await waitFor(() => expect(reads).toBeGreaterThan(1));
    expect(screen.queryByTestId('m5b-learned-row-confirmed-gone')).toBeNull();
    expect(screen.queryByTestId('m5b-learned-status')).not.toBeNull();
  });

  it('REV-006: a succeeded correction is dropped once no cached plan answer began before it', async () => {
    let reads = 0;
    harness = await prepare('en', initialState({ memoryItems: [memoryItem(BASIS_ID)] }), (request) => {
      if (request.method === 'GET' && request.path === `/api/mobile/plans/${TODAY}`) {
        reads += 1;
        return { status: 200, body: planEnvelope(reads === 1 ? planWithBasis() : { ...planWithBasis(), memoryBasis: null }) };
      }
      if (request.method === 'PATCH' && request.path === `/api/mobile/memory/${BASIS_ID}`) {
        return { status: 200, body: { success: true, memory: memoryItem(`${BASIS_ID}-new`) } };
      }
      return undefined;
    });
    await render(<Providers harness={harness}><View>
      <PlanScreen date={TODAY} onBack={() => undefined} />
      <MemoryMutationDriver />
    </View></Providers>);
    await waitFor(() => expect(screen.queryByTestId('m5b-plan-memory-basis')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('gate-patch'));
    await waitFor(() => expect(reads).toBeGreaterThan(1));
    await act(async () => { await jest.advanceTimersByTimeAsync(50); });
    expect(harness.client.getQueryData(queryKeys.plan(ACCOUNT_A.uid, TODAY))).toBeDefined();
    expect(basisCorrectionCountForTests(harness.client, ACCOUNT_A.uid)).toBe(0);
  });

  it('R2-002: a plan does not name a memory the person cannot open (the memory module answers 404)', async () => {
    harness = await prepare('en', initialState(), planOnly(planWithBasis(), (request) => (
      request.method === 'GET' && request.path === '/api/mobile/memory'
        ? { status: 404, body: { success: false, error: 'not found', reason: 'feature_unavailable' } }
        : undefined
    )));
    await render(<Providers harness={harness}><PlanScreen date={TODAY} onBack={() => undefined} /></Providers>);
    await waitFor(() => expect(screen.queryByTestId('plan-why')).not.toBeNull());
    await waitFor(() => expect(harness!.server.matching('GET', /^\/api\/mobile\/memory$/).length).toBeGreaterThan(0));
    await act(async () => { await jest.advanceTimersByTimeAsync(100); });
    expect(screen.queryByTestId('m5b-plan-memory-basis')).toBeNull();
  });

  const memoryGet = (request: { method: string; path: string }) => request.method === 'GET' && request.path === '/api/mobile/memory';
  const killed: RouteReply = { status: 404, body: { success: false, error: 'not found', reason: 'feature_unavailable' } };

  it('R3-003: a fresh memory list that no longer names the basis memory closes the line', async () => {
    harness = await prepare('en', initialState({ memoryItems: [memoryItem('some-other-memory')] }), planOnly(planWithBasis()));
    await render(<Providers harness={harness}><PlanScreen date={TODAY} onBack={() => undefined} /></Providers>);
    await waitFor(() => expect(screen.queryByTestId('plan-why')).not.toBeNull());
    await waitFor(() => expect(harness!.server.matching('GET', /^\/api\/mobile\/memory$/).length).toBeGreaterThan(0));
    await act(async () => { await jest.advanceTimersByTimeAsync(100); });
    expect(screen.queryByTestId('m5b-plan-memory-basis')).toBeNull();
  });

  it('R3-003: a list cached before this screen proves nothing until Memory answers again', async () => {
    const held = deferred<RouteReply>();
    harness = await prepare('en', initialState(), planOnly(planWithBasis(), (request) => (memoryGet(request) ? held.promise : undefined)));
    harness.client.setQueryData(queryKeys.memory(ACCOUNT_A.uid), { items: [memoryItem(BASIS_ID)], suggestions: [], adaptive: null });
    await render(<Providers harness={harness}><PlanScreen date={TODAY} onBack={() => undefined} /></Providers>);
    await waitFor(() => expect(screen.queryByTestId('plan-why')).not.toBeNull());
    await waitFor(() => expect(harness!.server.matching('GET', /^\/api\/mobile\/memory$/).length).toBeGreaterThan(0));
    await act(async () => { await jest.advanceTimersByTimeAsync(100); });
    expect(screen.queryByTestId('m5b-plan-memory-basis')).toBeNull();
    await act(async () => { held.resolve(killed); await jest.advanceTimersByTimeAsync(100); });
    expect(screen.queryByTestId('m5b-plan-memory-basis')).toBeNull();
  });

  it('R3-003: a memory module killed while the line is up closes it at the next recheck', async () => {
    let moduleOn = true;
    harness = await prepare('en', initialState(), planOnly(planWithBasis(), (request) => (memoryGet(request) && !moduleOn ? killed : undefined)));
    await render(<Providers harness={harness}><PlanScreen date={TODAY} onBack={() => undefined} /></Providers>);
    await waitFor(() => expect(screen.queryByTestId('m5b-plan-memory-basis')).not.toBeNull());
    moduleOn = false;
    await act(async () => { await jest.advanceTimersByTimeAsync(61_000); });
    await waitFor(() => expect(screen.queryByTestId('m5b-plan-memory-basis')).toBeNull());
  });

  const planGet = (request: { method: string; path: string }) => request.method === 'GET' && request.path === `/api/mobile/plans/${TODAY}`;

  it('R3-004: a settled plan request leaves no per-account entry behind', async () => {
    harness = await prepare('en', initialState(), planOnly(planWithBasis()));
    await render(<Providers harness={harness}><PlanScreen date={TODAY} onBack={() => undefined} /></Providers>);
    await waitFor(() => expect(screen.queryByTestId('m5b-plan-memory-basis')).not.toBeNull());
    await act(async () => { await jest.advanceTimersByTimeAsync(100); });
    expect(basisStateHeldForTests(harness.client, ACCOUNT_A.uid)).toBe(false);
  });

  it('R3-004: a plan request that settles after an account reset recreates nothing of the old account', async () => {
    const held = deferred<RouteReply>();
    harness = await prepare('en', initialState(), (request) => (planGet(request) ? held.promise : undefined));
    await render(<Providers harness={harness}><PlanScreen date={TODAY} onBack={() => undefined} /></Providers>);
    await waitFor(() => expect(harness!.server.matching('GET', new RegExp(`^/api/mobile/plans/${TODAY}$`)).length).toBeGreaterThan(0));
    expect(basisStateHeldForTests(harness.client, ACCOUNT_A.uid)).toBe(true);
    await act(async () => { resetBasisCorrections(harness!.client); });
    expect(basisStateHeldForTests(harness.client, ACCOUNT_A.uid)).toBe(false);
    await act(async () => { held.resolve({ status: 200, body: planEnvelope(planWithBasis()) }); await jest.advanceTimersByTimeAsync(100); });
    expect(basisStateHeldForTests(harness.client, ACCOUNT_A.uid)).toBe(false);
  });

  it('R3-004: a correction that fails after an account reset recreates nothing of the old account', async () => {
    const held = deferred<RouteReply>();
    harness = await prepare('en', initialState(), planOnly(planWithBasis(), (request) => (
      request.method === 'PATCH' && request.path === `/api/mobile/memory/${BASIS_ID}` ? held.promise : undefined
    )));
    await render(<Providers harness={harness}><View>
      <PlanScreen date={TODAY} onBack={() => undefined} />
      <MemoryMutationDriver />
    </View></Providers>);
    await waitFor(() => expect(screen.queryByTestId('m5b-plan-memory-basis')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('gate-patch'));
    await waitFor(() => expect(basisCorrectionCountForTests(harness!.client, ACCOUNT_A.uid)).toBe(1));
    await act(async () => { resetBasisCorrections(harness!.client); });
    await act(async () => { held.resolve({ status: 500, body: { success: false, error: 'boom' } }); await jest.advanceTimersByTimeAsync(100); });
    expect(basisStateHeldForTests(harness.client, ACCOUNT_A.uid)).toBe(false);
  });

  it('R4-002: another panel action takes the dismissal line out of the region', async () => {
    const pending = outcome('p1', 'completed', undefined, { kind: 'preference', source: 'manual', review: 'pending', reviewedAt: null, outcome: undefined });
    harness = await prepare('en', initialState(), panelHandler({ observations: [outcome('o1'), pending] }));
    await showPanel(harness);
    await waitFor(() => expect(screen.queryByTestId('m5b-learned')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('m5b-learned'));
    await fireEvent.press(screen.getByTestId('m5b-learned-wrong-o1'));
    await waitFor(() => expect(screen.queryByTestId('m5b-learned-status')).not.toBeNull());
    const card = screen.getByTestId('intelligence-observation-p1');
    await fireEvent.press(within(card).getByText("Yes, that's right"));
    await act(async () => { await jest.advanceTimersByTimeAsync(100); });
    expect(screen.queryByTestId('m5b-learned-status')).toBeNull();
  });

  it('R4-002: a dismissal takes the previous action\'s failed-refresh line out of the region', async () => {
    let reads = 0;
    const base = panelHandler({ observations: [outcome('o1'), outcome('o2')] });
    harness = await prepare('en', initialState(), (request) => {
      if (request.method === 'GET' && request.path === '/api/mobile/intelligence') {
        reads += 1;
        if (reads === 2) return { status: 503, body: { success: false, error: 'unavailable' } };
      }
      return base(request);
    });
    await showPanel(harness);
    await waitFor(() => expect(screen.queryByTestId('m5b-learned')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('m5b-learned'));
    await fireEvent.press(screen.getByTestId('m5b-learned-wrong-o1'));
    await waitFor(() => expect(screen.queryByTestId('intelligence-refresh-failed')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('m5b-learned-wrong-o2'));
    await waitFor(() => expect(reads).toBeGreaterThan(2));
    await act(async () => { await jest.advanceTimersByTimeAsync(100); });
    expect(screen.queryByTestId('intelligence-refresh-failed')).toBeNull();
  });

  it('R4-003: deleting the basis row and pressing Back at once never draws the old basis line', async () => {
    function OpenPlan() {
      const { actions } = useApp();
      const open = useRef(actions.openPlan);
      useEffect(() => open.current(TODAY), []);
      return null;
    }
    // As the real server: once the row is deleted, a plan answer names no basis.
    let deleted = false;
    harness = await prepare('en', initialState(), (request) => {
      if (request.method === 'DELETE' && request.path === `/api/mobile/memory/${BASIS_ID}`) {
        deleted = true;
        return { status: 200, body: { success: true, deleted: 1 } };
      }
      if (request.method === 'GET' && request.path === `/api/mobile/plans/${TODAY}`) {
        return { status: 200, body: planEnvelope(deleted ? { ...planWithBasis(), memoryBasis: null } : planWithBasis()) };
      }
      return undefined;
    });
    let leaving = false;
    let drawnAfterBack = false;
    const probe = () => { if (leaving && screen.queryByTestId('m5b-plan-memory-basis')) drawnAfterBack = true; };
    await render(<Providers harness={harness}><Profiler id="r4-003" onRender={probe}><OpenPlan /><Root /></Profiler></Providers>);
    await waitFor(() => expect(screen.queryByTestId('m5b-plan-memory-basis-fix')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('m5b-plan-memory-basis-fix'));
    await waitFor(() => expect(screen.queryByTestId(`memory-screen-focused-${BASIS_ID}`)).not.toBeNull());
    await fireEvent.press(screen.getByText('Cancel'));
    await fireEvent.press(screen.getByTestId(`memory-screen-delete-${BASIS_ID}`));
    expect(screen.queryByTestId('memory-undo-bar')).not.toBeNull();
    leaving = true;
    await fireEvent.press(screen.getByTestId('header-back'));
    await waitFor(() => expect(screen.queryByTestId('plan-why')).not.toBeNull());
    await act(async () => { await jest.advanceTimersByTimeAsync(100); });
    expect(drawnAfterBack).toBe(false);
    expect(screen.queryByTestId('m5b-plan-memory-basis')).toBeNull();
    expect(harness.server.matching('DELETE', new RegExp(`^/api/mobile/memory/${BASIS_ID}$`)).length).toBe(1);
    expect(deleted).toBe(true);
  });

  it('R4-004: a correction made with no plan cached or on its way is dropped once it succeeds', async () => {
    harness = await prepare('en', initialState(), () => undefined);
    await render(<Providers harness={harness}><MemoryMutationDriver /></Providers>);
    await fireEvent.press(screen.getByTestId('gate-patch'));
    await waitFor(() => expect(harness!.server.matching('PATCH', new RegExp(`^/api/mobile/memory/${BASIS_ID}$`)).length).toBe(1));
    await act(async () => { await jest.advanceTimersByTimeAsync(100); });
    expect(basisCorrectionCountForTests(harness.client, ACCOUNT_A.uid)).toBe(0);
  });

  it('R4-004: the last old plan answer leaving the cache drops the correction it was holding', async () => {
    function Toggle() {
      const [shown, setShown] = useState(true);
      return <View>
        {shown ? <PlanScreen date={TODAY} onBack={() => undefined} /> : null}
        <Pressable testID="hide-plan" onPress={() => setShown(false)} />
        <MemoryMutationDriver />
      </View>;
    }
    harness = await prepare('en', initialState(), planOnly(planWithBasis()));
    await render(<Providers harness={harness}><Toggle /></Providers>);
    await waitFor(() => expect(screen.queryByTestId('plan-why')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('hide-plan'));
    await fireEvent.press(screen.getByTestId('gate-patch'));
    await waitFor(() => expect(harness!.server.matching('PATCH', new RegExp(`^/api/mobile/memory/${BASIS_ID}$`)).length).toBe(1));
    await act(async () => { await jest.advanceTimersByTimeAsync(100); });
    // The cached answer began before the correction succeeded, so it is held.
    expect(basisCorrectionCountForTests(harness.client, ACCOUNT_A.uid)).toBe(1);
    await act(async () => { harness!.client.removeQueries({ queryKey: queryKeys.plan(ACCOUNT_A.uid, TODAY) }); });
    expect(basisCorrectionCountForTests(harness.client, ACCOUNT_A.uid)).toBe(0);
  });

  it('R5-001: Android Back from Memory sends a held delete before the Plan screen draws', async () => {
    function OpenPlan() {
      const { actions } = useApp();
      const open = useRef(actions.openPlan);
      useEffect(() => open.current(TODAY), []);
      return null;
    }
    // The platform asks the newest hardware-back listener first, until one handles it.
    const handlers: (() => boolean | null | undefined)[] = [];
    type Handler = Parameters<typeof BackHandler.addEventListener>[1];
    const addListener = BackHandler.addEventListener.bind(BackHandler);
    jest.spyOn(BackHandler, 'addEventListener').mockImplementation((event, handler) => {
      const entry = () => (handler as Handler)({} as never);
      if (event === 'hardwareBackPress') handlers.push(entry);
      const sub = addListener(event, handler);
      return { remove: () => { const at = handlers.indexOf(entry); if (at >= 0) handlers.splice(at, 1); sub.remove(); } };
    });
    const pressBack = () => { for (const handler of [...handlers].reverse()) if (handler()) return; };
    let deleted = false;
    harness = await prepare('en', initialState(), (request) => {
      if (request.method === 'DELETE' && request.path === `/api/mobile/memory/${BASIS_ID}`) {
        deleted = true;
        return { status: 200, body: { success: true, deleted: 1 } };
      }
      if (request.method === 'GET' && request.path === `/api/mobile/plans/${TODAY}`) {
        return { status: 200, body: planEnvelope(deleted ? { ...planWithBasis(), memoryBasis: null } : planWithBasis()) };
      }
      return undefined;
    });
    let deletesWhenPlanDrew: number | null = null;
    const probe = () => {
      if (leaving && deletesWhenPlanDrew === null && screen.queryByTestId('plan-why')) {
        deletesWhenPlanDrew = basisCorrectionCountForTests(harness!.client, ACCOUNT_A.uid);
      }
    };
    let leaving = false;
    await render(<Providers harness={harness}><Profiler id="r5-001" onRender={probe}><OpenPlan /><Root /></Profiler></Providers>);
    await waitFor(() => expect(screen.queryByTestId('m5b-plan-memory-basis-fix')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('m5b-plan-memory-basis-fix'));
    await waitFor(() => expect(screen.queryByTestId(`memory-screen-focused-${BASIS_ID}`)).not.toBeNull());
    await fireEvent.press(screen.getByText('Cancel'));
    await fireEvent.press(screen.getByTestId(`memory-screen-delete-${BASIS_ID}`));
    expect(basisCorrectionCountForTests(harness.client, ACCOUNT_A.uid)).toBe(0);
    leaving = true;
    await act(async () => { pressBack(); });
    await waitFor(() => expect(screen.queryByTestId('plan-why')).not.toBeNull());
    // The delete's correction already existed when the Plan screen first drew.
    expect(deletesWhenPlanDrew).toBe(1);
    await act(async () => { await jest.advanceTimersByTimeAsync(100); });
    expect(screen.queryByTestId('m5b-plan-memory-basis')).toBeNull();
    expect(deleted).toBe(true);
  });

  it('R5-001: an undone delete shows the basis again', async () => {
    function OpenPlan() {
      const { actions } = useApp();
      const open = useRef(actions.openPlan);
      useEffect(() => open.current(TODAY), []);
      return null;
    }
    harness = await prepare('en', initialState(), planOnly(planWithBasis()));
    await render(<Providers harness={harness}><OpenPlan /><Root /></Providers>);
    await waitFor(() => expect(screen.queryByTestId('m5b-plan-memory-basis-fix')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('m5b-plan-memory-basis-fix'));
    await waitFor(() => expect(screen.queryByTestId(`memory-screen-focused-${BASIS_ID}`)).not.toBeNull());
    await fireEvent.press(screen.getByText('Cancel'));
    await fireEvent.press(screen.getByTestId(`memory-screen-delete-${BASIS_ID}`));
    await fireEvent.press(screen.getByTestId('memory-undo'));
    await fireEvent.press(screen.getByTestId('header-back'));
    await waitFor(() => expect(screen.queryByTestId('m5b-plan-memory-basis')).not.toBeNull());
    expect(harness.server.matching('DELETE', new RegExp(`^/api/mobile/memory/${BASIS_ID}$`)).length).toBe(0);
  });

  it('R5-002: withdrawing personalization hides the basis at once, and a failed plan re-read does not bring it back', async () => {
    let withdrawn = false;
    harness = await prepare('en', initialState(), (request) => {
      if (request.method === 'PUT' && request.path === '/api/mobile/consents/personalization') {
        withdrawn = true;
        return { status: 200, body: personalizationRecorded };
      }
      if (request.method === 'GET' && request.path === `/api/mobile/plans/${TODAY}`) {
        return withdrawn ? { status: 503, body: { success: false, error: 'unavailable' } } : { status: 200, body: planEnvelope(planWithBasis()) };
      }
      return undefined;
    });
    function Withdraw() {
      const consent = useSetPersonalizationConsent();
      return <Pressable testID="withdraw" onPress={() => { void consent.mutateAsync({ state: 'declined', version: 'v1' }).catch(() => undefined); }} />;
    }
    await render(<Providers harness={harness}><View>
      <PlanScreen date={TODAY} onBack={() => undefined} />
      <Withdraw />
    </View></Providers>);
    await waitFor(() => expect(screen.queryByTestId('m5b-plan-memory-basis')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('withdraw'));
    expect(screen.queryByTestId('m5b-plan-memory-basis')).toBeNull();
    await waitFor(() => expect(withdrawn).toBe(true));
    await act(async () => { await jest.advanceTimersByTimeAsync(1000); });
    expect(screen.queryByTestId('m5b-plan-memory-basis')).toBeNull();
  });

  it('R5-003: a cached week or saved week does not hold succeeded corrections forever', async () => {
    harness = await prepare('en', initialState(), () => undefined);
    harness.client.setQueryData(queryKeys.week(ACCOUNT_A.uid, 'none'), { days: [] });
    harness.client.setQueryData(queryKeys.savedWeek(ACCOUNT_A.uid), { days: [] });
    await render(<Providers harness={harness}><MemoryMutationDriver /></Providers>);
    await fireEvent.press(screen.getByTestId('gate-patch'));
    await waitFor(() => expect(harness!.server.matching('PATCH', new RegExp(`^/api/mobile/memory/${BASIS_ID}$`)).length).toBe(1));
    await act(async () => { await jest.advanceTimersByTimeAsync(100); });
    expect(basisCorrectionCountForTests(harness.client, ACCOUNT_A.uid)).toBe(0);
  });

  // A write that may have landed: committed then 500, and a lost answer.
  const ambiguous: [string, () => RouteReply | Promise<RouteReply>][] = [
    ['commit-then-500', () => ({ status: 500, body: { success: false, error: 'audit_failed' } })],
    ['lost answer', () => Promise.reject(new TypeError('Network request failed'))],
  ];

  it.each(ambiguous.flatMap(([label, reply]) => (['patch', 'delete', 'delete-all'] as const).map((operation) => [operation, label, reply] as const)))(
    'R6-001: a %s whose answer is %s keeps the basis hidden, even through a failing plan re-read',
    async (operation, _label, reply) => {
      let failedWrite = false;
      harness = await prepare('en', initialState(), (request) => {
        const method = operation === 'patch' ? 'PATCH' : 'DELETE';
        const path = operation === 'delete-all' ? '/api/mobile/memory' : `/api/mobile/memory/${BASIS_ID}`;
        if (request.method === method && request.path === path) { failedWrite = true; return reply(); }
        if (request.method === 'GET' && request.path === `/api/mobile/plans/${TODAY}`) {
          return failedWrite ? { status: 503, body: { success: false, error: 'unavailable' } } : { status: 200, body: planEnvelope(planWithBasis()) };
        }
        return undefined;
      });
      await render(<Providers harness={harness}><View>
        <PlanScreen date={TODAY} onBack={() => undefined} />
        <MemoryMutationDriver />
      </View></Providers>);
      await waitFor(() => expect(screen.queryByTestId('m5b-plan-memory-basis')).not.toBeNull());
      await fireEvent.press(screen.getByTestId(operation === 'patch' ? 'gate-patch' : operation === 'delete' ? 'gate-delete' : 'gate-delete-all'));
      await waitFor(() => expect(failedWrite).toBe(true));
      await act(async () => { await jest.advanceTimersByTimeAsync(1000); });
      expect(screen.queryByTestId('m5b-plan-memory-basis')).toBeNull();
      expect(basisCorrectionCountForTests(harness.client, ACCOUNT_A.uid)).toBe(1);
    },
  );

  it('R6-001: a withdrawal whose answer is a 500 keeps the basis hidden through a failing plan re-read', async () => {
    let sent = false;
    harness = await prepare('en', initialState(), (request) => {
      if (request.method === 'PUT' && request.path === '/api/mobile/consents/personalization') {
        sent = true;
        return { status: 500, body: { success: false, error: 'audit_failed' } };
      }
      if (request.method === 'GET' && request.path === `/api/mobile/plans/${TODAY}`) {
        return sent ? { status: 503, body: { success: false, error: 'unavailable' } } : { status: 200, body: planEnvelope(planWithBasis()) };
      }
      return undefined;
    });
    function Withdraw() {
      const consent = useSetPersonalizationConsent();
      return <Pressable testID="withdraw" onPress={() => { void consent.mutateAsync({ state: 'declined', version: 'v1' }).catch(() => undefined); }} />;
    }
    await render(<Providers harness={harness}><View>
      <PlanScreen date={TODAY} onBack={() => undefined} />
      <Withdraw />
    </View></Providers>);
    await waitFor(() => expect(screen.queryByTestId('m5b-plan-memory-basis')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('withdraw'));
    await waitFor(() => expect(sent).toBe(true));
    await act(async () => { await jest.advanceTimersByTimeAsync(1000); });
    expect(screen.queryByTestId('m5b-plan-memory-basis')).toBeNull();
  });

  it('R6-001: a refused withdrawal (400) shows the basis again with no plan re-read', async () => {
    let reads = 0;
    harness = await prepare('en', initialState(), (request) => {
      if (request.method === 'PUT' && request.path === '/api/mobile/consents/personalization') return { status: 400, body: { success: false, error: 'invalid' } };
      if (request.method === 'GET' && request.path === `/api/mobile/plans/${TODAY}`) { reads += 1; return { status: 200, body: planEnvelope(planWithBasis()) }; }
      return undefined;
    });
    function Withdraw() {
      const consent = useSetPersonalizationConsent();
      return <Pressable testID="withdraw" onPress={() => { void consent.mutateAsync({ state: 'declined', version: 'v1' }).catch(() => undefined); }} />;
    }
    await render(<Providers harness={harness}><View>
      <PlanScreen date={TODAY} onBack={() => undefined} />
      <Withdraw />
    </View></Providers>);
    await waitFor(() => expect(screen.queryByTestId('m5b-plan-memory-basis')).not.toBeNull());
    const before = reads;
    await fireEvent.press(screen.getByTestId('withdraw'));
    await waitFor(() => expect(screen.queryByTestId('m5b-plan-memory-basis')).not.toBeNull());
    await act(async () => { await jest.advanceTimersByTimeAsync(100); });
    expect(reads).toBe(before);
  });

  const mountReads: [string, RouteReply][] = [
    ['omits the row', { status: 200, body: { items: [memoryItem('some-other-memory')], suggestions: [], adaptive: null } }],
    ['answers 404', { status: 404, body: { success: false, error: 'not found', reason: 'feature_unavailable' } }],
  ];
  it.each(mountReads)('R6-003: a cached list still holding the row opens Memory unfocused when the mount-time read %s', async (_label, reply) => {
    function OpenMemoryFocused() {
      const { actions } = useApp();
      return <Pressable testID="open-memory-focused" onPress={() => actions.openMemoryFocused(BASIS_ID)} />;
    }
    const held = deferred<RouteReply>();
    let reads = 0;
    harness = await prepare('en', initialState(), (request) => {
      if (request.method === 'GET' && request.path === '/api/mobile/memory') { reads += 1; return held.promise; }
      return undefined;
    });
    await render(<Providers harness={harness}><Root /><OpenMemoryFocused /></Providers>);
    await act(async () => { await jest.advanceTimersByTimeAsync(100); });
    // Freshly cached a moment ago, before another device deleted the row.
    harness.client.setQueryData(queryKeys.memory(ACCOUNT_A.uid), { items: [memoryItem(BASIS_ID)], suggestions: [], adaptive: null });
    const before = reads;
    await fireEvent.press(screen.getByTestId('open-memory-focused'));
    await waitFor(() => expect(reads).toBeGreaterThan(before));
    // While the mount-time read is on its way, the cached row is listed but not opened.
    expect(screen.queryByTestId(`memory-screen-item-${BASIS_ID}`)).not.toBeNull();
    expect(screen.queryByTestId(`memory-screen-focused-${BASIS_ID}`)).toBeNull();
    expect(screen.queryByTestId(`memory-screen-edit-input-${BASIS_ID}`)).toBeNull();
    await act(async () => { held.resolve(reply); await jest.advanceTimersByTimeAsync(5000); });
    expect(screen.queryByTestId(`memory-screen-focused-${BASIS_ID}`)).toBeNull();
    expect(screen.queryByTestId(`memory-screen-edit-input-${BASIS_ID}`)).toBeNull();
  });

  it('R6-003: the mount-time read still holding the row opens it focused', async () => {
    function OpenMemoryFocused() {
      const { actions } = useApp();
      return <Pressable testID="open-memory-focused" onPress={() => actions.openMemoryFocused(BASIS_ID)} />;
    }
    harness = await prepare('en', initialState(), () => undefined);
    await render(<Providers harness={harness}><Root /><OpenMemoryFocused /></Providers>);
    await act(async () => { await jest.advanceTimersByTimeAsync(100); });
    await fireEvent.press(screen.getByTestId('open-memory-focused'));
    await waitFor(() => expect(screen.queryByTestId(`memory-screen-focused-${BASIS_ID}`)).not.toBeNull());
  });
});
