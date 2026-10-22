import { AccessibilityInfo } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import {
  NOW,
  ZONE,
  initialState,
  outcome,
  panelHandler,
  panelState,
  prepare,
  readdMarker,
  readdTestIds,
  showPanel,
  suggestion,
  teardown,
  type M5bHarness,
  type ReaddPanelState,
} from './harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

let harness: M5bHarness | undefined;

const REVIEW_CASES: ['right' | 'wrong', 'confirmed' | 'dismissed'][] = [
  ['right', 'confirmed'],
  ['wrong', 'dismissed'],
];

const STOPPED_CASES: ['right' | 'wrong', false | 'unknown'][] = [
  ['right', false],
  ['wrong', 'unknown'],
];

beforeEach(() => {
  process.env.TZ = ZONE;
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(async () => {
  await teardown(harness);
  harness = undefined;
  jest.useRealTimers();
});

async function loaded(state: ReaddPanelState) {
  harness = await prepare('en', initialState(), panelHandler(state));
  const view = await showPanel(harness);
  await waitFor(() => expect(screen.queryByTestId('intelligence-statement')).not.toBeNull());
  return view;
}

async function openLearned() {
  await waitFor(() => expect(screen.queryByTestId('m5b-learned')).not.toBeNull());
  await fireEvent.press(screen.getByTestId('m5b-learned'));
}

describe('M5b-2b-2 learned re-add rows', () => {
  it('R3 App a pending re-add has the guess tag and both review actions', async () => {
    await loaded(panelState({ observations: [readdMarker('pending')] }));
    await openLearned();

    expect(screen.getByTestId(readdTestIds.row('pending'))).toBeTruthy();
    expect(screen.getByTestId(readdTestIds.guess('pending'))).toBeTruthy();
    expect(screen.getByTestId(readdTestIds.right('pending')).props.accessibilityRole).toBe('button');
    expect(screen.getByTestId(readdTestIds.wrong('pending')).props.accessibilityRole).toBe('button');
  });

  it('R3 App a confirmed re-add joins the confirmed list with only the wrong action', async () => {
    await loaded(panelState({ observations: [readdMarker('confirmed', 'confirmed', 'completed')] }));
    await openLearned();

    expect(screen.getByTestId(readdTestIds.row('confirmed'))).toBeTruthy();
    expect(screen.queryByTestId(readdTestIds.guess('confirmed'))).toBeNull();
    expect(screen.queryByTestId(readdTestIds.right('confirmed'))).toBeNull();
    expect(screen.getByTestId(readdTestIds.wrong('confirmed')).props.accessibilityRole).toBe('button');
  });

  it('R3 App keeps the three newest pending re-adds above the five newest confirmed rows', async () => {
    const pending = [1, 2, 3, 4].map(day => readdMarker(
      `p${day}`,
      'pending',
      day % 2 === 0 ? 'completed' : 'dropped',
      `2030-03-${20 + day}T08:00:00.000Z`,
    ));
    const confirmed = [1, 2, 3, 4, 5, 6].map(day => readdMarker(
      `c${day}`,
      'confirmed',
      day % 2 === 0 ? 'completed' : 'dropped',
      `2030-03-${20 + day}T07:00:00.000Z`,
    ));
    await loaded(panelState({ observations: [...confirmed, ...pending] }));
    await openLearned();

    expect(screen.getAllByTestId(/^m5b-learned-readd-/).map(node => node.props.testID)).toEqual([
      readdTestIds.row('p4'),
      readdTestIds.row('p3'),
      readdTestIds.row('p2'),
      readdTestIds.row('c6'),
      readdTestIds.row('c5'),
      readdTestIds.row('c4'),
      readdTestIds.row('c3'),
      readdTestIds.row('c2'),
    ]);
    expect(screen.queryByTestId(readdTestIds.row('p1'))).toBeNull();
    expect(screen.queryByTestId(readdTestIds.row('c1'))).toBeNull();
  });

  it.each(REVIEW_CASES)('R3 App fresh capability precedes every %s tap and the request moves to %s', async (action, review) => {
    const state = panelState({ observations: [readdMarker(action)] });
    await loaded(state);
    await openLearned();
    state.order.length = 0;

    await fireEvent.press(screen.getByTestId(readdTestIds[action](action)));
    await waitFor(() => expect(harness!.server.matching('POST', new RegExp(`/observations/${action}$`))).toHaveLength(1));

    expect(state.order.slice(0, 2)).toEqual(['capability', `review:${action}:${review}`]);
    expect(harness!.server.matching('POST', new RegExp(`/observations/${action}$`))[0]?.body).toEqual({ review });
  });

  it.each(REVIEW_CASES)('R3 App an unchanged 200 after %s is unavailable and announces no %s success', async (action, _review) => {
    const id = `unchanged-${action}`;
    const state = panelState({
      observations: [readdMarker(id)],
      unchangedIds: new Set([id]),
    });
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
    announce.mockClear();
    await loaded(state);
    await openLearned();
    const capabilitiesBefore = harness!.server.matching('GET', /^\/api\/mobile\/capabilities\/m5b$/).length;
    const inboxBefore = harness!.server.matching('GET', /^\/api\/mobile\/intelligence$/).length;

    await fireEvent.press(screen.getByTestId(readdTestIds[action](id)));
    await waitFor(() => expect(harness!.server.matching('GET', /^\/api\/mobile\/intelligence$/).length).toBeGreaterThan(inboxBefore));

    expect(harness!.server.matching('GET', /^\/api\/mobile\/capabilities\/m5b$/).length)
      .toBeGreaterThanOrEqual(capabilitiesBefore + 2);
    expect(screen.queryByTestId(readdTestIds.row(id))).not.toBeNull();
    expect(screen.queryByTestId(readdTestIds.right(id))).not.toBeNull();
    expect(screen.queryByTestId('m5b-learned-status')).toBeNull();
    expect(announce).not.toHaveBeenCalled();
  });

  it.each(STOPPED_CASES)('R3 App a fresh %s tap sends no review when capability is %s', async (action, capability) => {
    const id = `stopped-${action}`;
    const state = panelState({ observations: [readdMarker(id)] });
    await loaded(state);
    await openLearned();
    state.capability = capability;
    const capabilitiesBefore = harness!.server.matching('GET', /^\/api\/mobile\/capabilities\/m5b$/).length;

    await fireEvent.press(screen.getByTestId(readdTestIds[action](id)));
    await waitFor(() => expect(harness!.server.matching('GET', /^\/api\/mobile\/capabilities\/m5b$/).length).toBeGreaterThan(capabilitiesBefore));

    expect(harness!.server.matching('POST', new RegExp(`/observations/${id}$`))).toHaveLength(0);
  });

  it('R3 App a successful confirmation rereads the inbox and announces from the panel live region', async () => {
    const state = panelState({ observations: [readdMarker('announce')] });
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
    announce.mockClear();
    await loaded(state);
    await openLearned();
    const readsBefore = harness!.server.matching('GET', /^\/api\/mobile\/intelligence$/).length;

    await fireEvent.press(screen.getByTestId(readdTestIds.right('announce')));
    await waitFor(() => expect(harness!.server.matching('GET', /^\/api\/mobile\/intelligence$/).length).toBeGreaterThan(readsBefore));

    expect(screen.getByTestId('intelligence-status').props.accessibilityLiveRegion).toBe('polite');
    expect(screen.getByTestId('m5b-learned-status').props.children).toEqual(expect.any(String));
    expect(announce).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId(readdTestIds.right('announce'))).toBeNull();
    expect(screen.getByTestId(readdTestIds.wrong('announce'))).toBeTruthy();
  });

  it('owner decision 4 dismissing the earlier outcome removes the re-add row and its suggestions immediately', async () => {
    const marker = readdMarker('marker', 'confirmed', 'dropped', '2030-03-29T08:30:00.000Z');
    const earlier = outcome('earlier', 'dropped', '2030-03-28T08:00:00.000Z');
    const backed = suggestion('readd-backed', { title: 'Backed by the re-add' }) as Record<string, unknown>;
    backed.observationIds = ['marker'];
    const state = panelState({
      observations: [earlier, marker],
      suggestions: [backed],
      onMoved: (id, review, current) => {
        if (id !== 'earlier' || review !== 'dismissed') return;
        current.observations = current.observations.filter(item => item.id !== 'marker');
        current.suggestions = current.suggestions.filter(item => item.id !== 'readd-backed');
      },
    });
    await loaded(state);
    await waitFor(() => expect(screen.queryByTestId('intelligence-suggestion-readd-backed')).not.toBeNull());
    await openLearned();
    expect(screen.getByTestId(readdTestIds.row('marker'))).toBeTruthy();

    await fireEvent.press(screen.getByTestId('m5b-learned-wrong-earlier'));
    await waitFor(() => expect(screen.queryByTestId('intelligence-suggestion-readd-backed')).toBeNull());

    expect(screen.queryByTestId(readdTestIds.row('marker'))).toBeNull();
  });
});
