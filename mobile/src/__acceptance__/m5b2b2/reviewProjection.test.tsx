/**
 * M5b-2b-2 inspection round 1 (Codex), app findings:
 *
 * - M5B2B2-APP-001: the review route answers with the stored marker, which
 *   has no live `readd` projection. A confirmed re-add must still join the
 *   confirmed list when the re-read after it fails.
 * - M5B2B2-APP-002: dismissing the earlier outcome hides the marker bound to
 *   it (`matchedOutcomeId`, REV-004), the suggestions citing that marker and
 *   their schedule rows at once (owner decision 4) — before, and without,
 *   the re-read. An older server's payload (no `matchedOutcomeId`) behaves
 *   exactly as before.
 *
 * The handler here answers the review the way
 * `src/app/api/mobile/intelligence/observations/[id]/route.ts` does: the raw
 * stored row, never the inbox projection.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { intelligenceInboxSchema, intelligenceObservationReviewSchema } from '../../api/schemas/intelligence';
import {
  NOW,
  ZONE,
  initialState,
  outcome,
  prepare,
  readdMarker,
  readdTestIds,
  showPanel,
  suggestion,
  teardown,
  type M5bHarness,
  type RouteHandler,
  type RouteReply,
} from './harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

type Row = Record<string, unknown>;

let harness: M5bHarness | undefined;

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

/** The stored marker as the review route returns it: bound, with no projection. */
function stored(row: Row): Row {
  const { readd: _readd, ...rest } = row;
  return rest;
}

interface WireState {
  observations: Row[];
  suggestions: Row[];
  schedule: Row[];
  /** Inbox reads after the review: answered later, or refused. */
  afterReview: 'ok' | 'fail' | { gate: Promise<void> };
  reviewed: boolean;
  /** Inbox reads answered after the review. */
  servedAfterReview: number;
  /** What the server holds once the review lands. */
  onReview: (id: string, review: 'confirmed' | 'dismissed', state: WireState) => void;
}

function inboxBody(state: WireState) {
  return {
    success: true,
    observations: state.observations,
    suggestions: state.suggestions,
    schedule: state.schedule,
    basisMode: 'on_nobasis',
  };
}

function wire(state: WireState): RouteHandler {
  return async (request): Promise<RouteReply | undefined> => {
    if (request.path === '/api/mobile/intelligence' && request.method === 'GET') {
      if (state.reviewed && state.afterReview === 'fail') {
        return { status: 500, body: { success: false, error: 'unavailable' } };
      }
      if (state.reviewed && typeof state.afterReview === 'object') await state.afterReview.gate;
      if (state.reviewed) state.servedAfterReview += 1;
      return { status: 200, body: inboxBody(state) };
    }
    if (request.path === '/api/mobile/intelligence/sources/gmail/monitor') {
      return { status: 200, body: { success: true, enabled: false, lastSuccessAt: null, error: null } };
    }
    if (request.path === '/api/mobile/capabilities/m5b') {
      return { status: 200, body: { success: true, memoryLearning: true } };
    }
    const match = /^\/api\/mobile\/intelligence\/observations\/([^/]+)$/.exec(request.path);
    if (match && request.method === 'POST') {
      const id = decodeURIComponent(match[1]!);
      const review = (request.body as { review?: unknown }).review;
      if (review !== 'confirmed' && review !== 'dismissed') return undefined;
      const found = state.observations.find(item => item.id === id);
      if (!found) return { status: 404, body: { success: false, reason: 'not_found' } };
      const moved = { ...stored(found), review, reviewedAt: NOW.toISOString() };
      state.reviewed = true;
      state.onReview(id, review, state);
      return { status: 200, body: { success: true, observation: moved } };
    }
    return undefined;
  };
}

async function loaded(state: WireState) {
  harness = await prepare('en', initialState(), wire(state));
  await showPanel(harness);
  await waitFor(() => expect(screen.queryByTestId('intelligence-statement')).not.toBeNull());
  await waitFor(() => expect(screen.queryByTestId('m5b-learned')).not.toBeNull());
  await fireEvent.press(screen.getByTestId('m5b-learned'));
}

function inboxReads() {
  return harness!.server.matching('GET', /^\/api\/mobile\/intelligence$/).length;
}

const EARLIER = 'earlier';
const OTHER = 'other-outcome';

/** An earlier dropped outcome, a re-add bound to it and one bound elsewhere, each with a citing suggestion. */
function decisionFourState(afterReview: WireState['afterReview'], bind = true): WireState {
  const earlier = outcome(EARLIER, 'dropped', '2030-03-28T08:00:00.000Z');
  const other = outcome(OTHER, 'completed', '2030-03-27T08:00:00.000Z');
  const marker = readdMarker('bound', 'confirmed', 'dropped', '2030-03-29T08:30:00.000Z',
    bind ? { matchedOutcomeId: EARLIER } : {});
  const elsewhere = readdMarker('elsewhere', 'confirmed', 'completed', '2030-03-29T08:20:00.000Z',
    bind ? { matchedOutcomeId: OTHER } : {});
  const backed = { ...suggestion('readd-backed', { title: 'Backed by the re-add' }), observationIds: ['bound'] };
  const unrelated = { ...suggestion('unrelated', { title: 'Backed elsewhere' }), observationIds: ['elsewhere'] };
  const slot = (id: string) => ({
    suggestionId: id,
    slot: { startsAt: '2030-03-30T07:00:00.000Z', endsAt: '2030-03-30T07:30:00.000Z' },
    reason: null,
  });
  return {
    observations: [earlier, other, marker, elsewhere],
    suggestions: [backed, unrelated],
    schedule: [slot('readd-backed'), slot('unrelated')],
    afterReview,
    reviewed: false,
    servedAfterReview: 0,
    onReview: (id, review, current) => {
      if (review === 'dismissed') {
        current.observations = current.observations
          .filter(item => item.id !== id)
          .filter(item => !(id === EARLIER && item.id === 'bound'));
        if (id === EARLIER) {
          current.suggestions = current.suggestions.filter(item => item.id !== 'readd-backed');
          current.schedule = current.schedule.filter(item => item.suggestionId !== 'readd-backed');
        }
      }
    },
  };
}

function expectBoundGone() {
  expect(screen.queryByTestId(readdTestIds.row('bound'))).toBeNull();
  expect(screen.queryByTestId('intelligence-suggestion-readd-backed')).toBeNull();
  expect(screen.queryByTestId('m5b-suggestion-schedule-readd-backed')).toBeNull();
  // Only what cites the dismissed outcome leaves.
  expect(screen.getByTestId(readdTestIds.row('elsewhere'))).toBeTruthy();
  expect(screen.getByTestId('intelligence-suggestion-unrelated')).toBeTruthy();
  expect(screen.getByTestId('m5b-suggestion-schedule-unrelated')).toBeTruthy();
}

describe('M5b-2b-2 review on the real wire (inspection round 1)', () => {
  it('REV-004 the real fixture and review response keep the content-free matchedOutcomeId', () => {
    const fixture = JSON.parse(readFileSync(join(__dirname, '../../api/__fixtures__/intelligence.readd.json'), 'utf8'));
    const parsed = intelligenceInboxSchema.parse(fixture);
    const markers = parsed.observations.filter(item => item.readd !== undefined);
    expect(markers.length).toBeGreaterThan(0);
    for (const marker of markers) expect(marker.matchedOutcomeId).toEqual(expect.any(String));
    for (const row of parsed.observations.filter(item => item.readd === undefined)) {
      expect(row).not.toHaveProperty('matchedOutcomeId');
    }
    const review = intelligenceObservationReviewSchema.parse({
      success: true,
      observation: { ...stored(fixture.observations[0]), review: 'confirmed' },
    });
    expect(review.observation.matchedOutcomeId).toBe(fixture.observations[0].matchedOutcomeId);
    expect(review.observation).not.toHaveProperty('readd');
  });

  it('M5B2B2-APP-001 a confirmed re-add stays as a confirmed row when the review answer has no readd and the re-read fails', async () => {
    const marker = readdMarker('pending-readd', 'pending', 'dropped', '2030-03-29T08:30:00.000Z', { matchedOutcomeId: EARLIER });
    const state: WireState = {
      observations: [outcome(EARLIER, 'dropped', '2030-03-28T08:00:00.000Z'), marker],
      suggestions: [],
      schedule: [],
      afterReview: 'fail',
      reviewed: false,
      servedAfterReview: 0,
      onReview: () => undefined,
    };
    await loaded(state);
    expect(screen.getByTestId(readdTestIds.guess('pending-readd'))).toBeTruthy();
    const readsBefore = inboxReads();

    await fireEvent.press(screen.getByTestId(readdTestIds.right('pending-readd')));
    await waitFor(() => expect(inboxReads()).toBeGreaterThan(readsBefore));
    await waitFor(() => expect(screen.queryByTestId('m5b-learned-status')).not.toBeNull());

    // The response really carried no projection: the row is drawn from the one held.
    const posted = harness!.server.matching('POST', /\/observations\/pending-readd$/);
    expect(posted).toHaveLength(1);
    expect(screen.getByTestId(readdTestIds.row('pending-readd'))).toBeTruthy();
    expect(screen.queryByTestId(readdTestIds.guess('pending-readd'))).toBeNull();
    expect(screen.queryByTestId(readdTestIds.right('pending-readd'))).toBeNull();
    expect(screen.getByTestId(readdTestIds.wrong('pending-readd'))).toBeTruthy();
  });

  it('owner decision 4 / M5B2B2-APP-002 dismissing the earlier outcome hides the bound marker, its suggestion and schedule before a delayed re-read', async () => {
    const gate = deferred<void>();
    const state = decisionFourState({ gate: gate.promise });
    await loaded(state);
    await waitFor(() => expect(screen.queryByTestId('intelligence-suggestion-readd-backed')).not.toBeNull());
    expect(screen.getByTestId('m5b-suggestion-schedule-readd-backed')).toBeTruthy();
    expect(screen.getByTestId(readdTestIds.row('bound'))).toBeTruthy();
    const readsBefore = inboxReads();

    await fireEvent.press(screen.getByTestId(`m5b-learned-wrong-${EARLIER}`));
    await waitFor(() => expect(inboxReads()).toBeGreaterThan(readsBefore));
    await waitFor(() => expect(screen.queryByTestId('m5b-learned-status')).not.toBeNull());

    // The re-read is still waiting: what is gone went with the dismissal itself.
    expectBoundGone();

    expect(state.servedAfterReview).toBe(0);
    gate.resolve();
    await waitFor(() => expect(state.servedAfterReview).toBeGreaterThan(0));
    await jest.advanceTimersByTimeAsync(0);
    expectBoundGone();
  });

  it('owner decision 4 / M5B2B2-APP-002 the bound marker and its suggestion stay gone when the re-read fails', async () => {
    const state = decisionFourState('fail');
    await loaded(state);
    await waitFor(() => expect(screen.queryByTestId('intelligence-suggestion-readd-backed')).not.toBeNull());
    const readsBefore = inboxReads();

    await fireEvent.press(screen.getByTestId(`m5b-learned-wrong-${EARLIER}`));
    await waitFor(() => expect(inboxReads()).toBeGreaterThan(readsBefore));
    await waitFor(() => expect(screen.queryByTestId('m5b-learned-status')).not.toBeNull());

    expectBoundGone();
    await jest.advanceTimersByTimeAsync(1000);
    expectBoundGone();
  });

  it('M5B2B2-APP-002 parity: without matchedOutcomeId (an older server) the dismissal patches only the outcome until the re-read', async () => {
    const gate = deferred<void>();
    const state = decisionFourState({ gate: gate.promise }, false);
    await loaded(state);
    await waitFor(() => expect(screen.queryByTestId('intelligence-suggestion-readd-backed')).not.toBeNull());
    const readsBefore = inboxReads();

    await fireEvent.press(screen.getByTestId(`m5b-learned-wrong-${EARLIER}`));
    await waitFor(() => expect(inboxReads()).toBeGreaterThan(readsBefore));
    await waitFor(() => expect(screen.queryByTestId('m5b-learned-status')).not.toBeNull());

    expect(screen.queryByTestId(`m5b-learned-row-${EARLIER}`)).toBeNull();
    expect(screen.getByTestId(readdTestIds.row('bound'))).toBeTruthy();
    expect(screen.getByTestId('intelligence-suggestion-readd-backed')).toBeTruthy();
    expect(screen.getByTestId('m5b-suggestion-schedule-readd-backed')).toBeTruthy();
    expect(screen.getByTestId(readdTestIds.row('elsewhere'))).toBeTruthy();

    gate.resolve();
    await waitFor(() => expect(screen.queryByTestId('intelligence-suggestion-readd-backed')).toBeNull());
  });
});
