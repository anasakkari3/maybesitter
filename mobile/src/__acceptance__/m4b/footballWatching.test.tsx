import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { screen, waitFor } from '@testing-library/react-native';
import { FootballSettingsScreen } from '../../features/settings/FootballSettingsScreen';
import { WatchingScreen } from '../../features/watching/WatchingScreen';
import i18next from '../../i18n';
import {
  NOW,
  capabilities,
  footballResponse,
  instant,
  prepare,
  press,
  show,
  teardown,
  type M4bHarness,
  type RecordedRequest,
} from './harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

const CLASH = {
  title: 'Dinner', startsAt: instant('2030-03-30', '20:00'), endsAt: instant('2030-03-30', '21:00'), kind: 'commitment',
};
const BUSY = {
  title: null, startsAt: instant('2030-03-30', '20:30'), endsAt: instant('2030-03-30', '21:30'), kind: 'calendar_busy',
};
const WEEKLY = {
  title: 'Weekly class', startsAt: instant('2030-03-30', '20:45'), endsAt: instant('2030-03-30', '21:15'), kind: 'weekly',
};

function held(overrides: Record<string, unknown> = {}) {
  return {
    fixtureId: 'fixture-1', heldVersion: 'held-v1',
    homeTeamName: 'Barcelona', awayTeamName: 'Real Madrid',
    homeTeamId: '81', awayTeamId: '86',
    kickoffUtc: instant('2030-03-30', '20:00'), endUtc: instant('2030-03-30', '22:00'),
    moved: false, clashes: [CLASH], ...overrides,
  };
}

let harness: M4bHarness | undefined;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(async () => {
  await teardown(harness);
  harness = undefined;
  jest.restoreAllMocks();
  jest.useRealTimers();
});

async function showFootball(body: unknown, handler?: (request: RecordedRequest) => { status: number; body: unknown } | undefined): Promise<void> {
  harness = await prepare('en', request => {
    if (request.path === '/api/mobile/football' && request.method === 'GET') return { status: 200, body };
    return handler?.(request);
  });
  await show(harness, <FootballSettingsScreen onBack={() => undefined} />);
  await waitFor(() => expect(screen.queryByTestId('football-club-list')).not.toBeNull());
}

describe('R1.5 football holds', () => {
  it('M4B-REV-007 external-clash capability false renders no held section and requests no held summary', async () => {
    await showFootball(footballResponse(), request => request.path === '/api/mobile/capabilities/m4b'
      ? { status: 200, body: capabilities({ externalClashHold: false }) }
      : undefined);

    expect(screen.queryByTestId('football-held-section')).toBeNull();
    expect(harness!.server.matching('GET', /\/held-items$/)).toHaveLength(0);
    expect(harness!.server.matching('GET', /\/capabilities\/m4b$/)).not.toHaveLength(0);
  });

  it('R1.5 renders a held match with one line per persisted clash', async () => {
    await showFootball(footballResponse({ held: [held({ clashes: [CLASH, BUSY] })], waitingForCoverage: 0 }));

    expect(screen.queryByTestId('football-held-section')).not.toBeNull();
    expect(screen.queryByTestId('football-held-fixture-1')).not.toBeNull();
    expect(screen.queryByTestId('football-fixture-clash-fixture-1-0')).not.toBeNull();
    expect(screen.queryByTestId('football-fixture-clash-fixture-1-1')).not.toBeNull();
    expect(screen.queryByTestId('football-fixture-clash-fixture-1-2')).toBeNull();
  });

  it('R1.5 Add sends the exact hold version and a generated client action id', async () => {
    await showFootball(
      footballResponse({ held: [held()], waitingForCoverage: 0 }),
      request => request.path === '/api/mobile/football/held/fixture-1' && request.method === 'POST'
        ? { status: 200, body: { success: true, action: 'add', fixture: { commitmentId: 'match-1', homeTeamName: 'Barcelona', awayTeamName: 'Real Madrid', kickoffUtc: held().kickoffUtc, collisions: [] } } }
        : undefined,
    );
    await press('football-held-add-fixture-1');

    await waitFor(() => expect(harness!.server.matching('POST', /\/football\/held\/fixture-1$/)).toHaveLength(1));
    expect(harness!.server.matching('POST', /\/football\/held\/fixture-1$/)[0]!.body).toEqual({
      action: 'add', expectedHeldVersion: 'held-v1', clientActionId: expect.any(String),
    });
  });

  it('R1.5 dismiss sends the same hold version with action dismiss', async () => {
    await showFootball(
      footballResponse({ held: [held()], waitingForCoverage: 0 }),
      request => request.path === '/api/mobile/football/held/fixture-1' && request.method === 'POST'
        ? { status: 200, body: { success: true, action: 'dismiss', fixtureId: 'fixture-1' } }
        : undefined,
    );
    await press('football-held-dismiss-fixture-1');

    await waitFor(() => expect(harness!.server.matching('POST', /\/football\/held\/fixture-1$/)).toHaveLength(1));
    expect(harness!.server.matching('POST', /\/football\/held\/fixture-1$/)[0]!.body).toEqual({
      action: 'dismiss', expectedHeldVersion: 'held-v1', clientActionId: expect.any(String),
    });
  });

  it('R1.5 held_changed keeps the warning visible and replaces the row returned by the server', async () => {
    const changed = held({ heldVersion: 'held-v2', kickoffUtc: instant('2030-03-31', '21:00'), moved: true, clashes: [WEEKLY] });
    await showFootball(
      footballResponse({ held: [held()], waitingForCoverage: 0 }),
      request => request.path === '/api/mobile/football/held/fixture-1' && request.method === 'POST'
        ? { status: 409, body: { success: false, error: 'held_changed', held: changed } }
        : undefined,
    );
    await press('football-held-add-fixture-1');

    await waitFor(() => expect(screen.queryByTestId('football-held-changed')).not.toBeNull());
    expect(screen.queryByTestId('football-held-fixture-1')).not.toBeNull();
    expect(screen.queryByTestId('football-fixture-clash-fixture-1-0')).not.toBeNull();
  });

  it('R1.5 moved and coverage states have their distinct observable rows', async () => {
    await showFootball(footballResponse({ held: [held({ moved: true })], waitingForCoverage: 2 }));

    expect(screen.queryByTestId('football-held-fixture-1')).not.toBeNull();
    expect(screen.queryByTestId('football-coverage-note')).not.toBeNull();
  });

  it('M4B-R4-005 a saved fixture renders clashes even while clashState is unknown', async () => {
    await showFootball(footballResponse({
      held: [], waitingForCoverage: 0,
      fixtures: [{
        commitmentId: 'match-1', homeTeamName: 'Barcelona', awayTeamName: 'Real Madrid',
        kickoffUtc: instant('2030-03-30', '20:00'), clashes: [CLASH, BUSY, WEEKLY], clashState: 'unknown',
      }],
    }));

    for (let n = 0; n < 3; n += 1) expect(screen.queryByTestId(`football-fixture-clash-match-1-${n}`)).not.toBeNull();
  });
});

describe('R1.5 held summary on Watching', () => {
  async function showWatching(count: number): Promise<void> {
    process.env.EXPO_PUBLIC_FEATURE_PROACTIVE_LOOP = 'false';
    harness = await prepare('en', request => {
      if (request.path === '/api/mobile/capabilities/m4b') return { status: 200, body: capabilities() };
      if (request.path === '/api/mobile/held-items') {
        return {
          status: 200,
          body: {
            success: true,
            count,
            items: count === 0 ? [] : [{ source: 'football', id: 'fixture-1', title: 'Barcelona – Real Madrid', startsAt: instant('2030-03-30', '20:00') }],
          },
        };
      }
      if (request.path.startsWith('/api/mobile/intelligence')) {
        return { status: 404, body: { success: false, error: 'feature_unavailable', reason: 'feature_unavailable' } };
      }
      return undefined;
    });
    await show(harness, <WatchingScreen />);
    await waitFor(() => expect(screen.queryByTestId('watching-root')).not.toBeNull());
  }

  it('R1.5 count zero hides the held card', async () => {
    await showWatching(0);
    await waitFor(() => expect(harness!.server.matching('GET', /\/held-items$/)).toHaveLength(1));
    expect(screen.queryByTestId('watching-held-card')).toBeNull();
  });

  it('M4B-REV-007 Watching makes no held-items request while external clash hold is false', async () => {
    harness = await prepare('en', request => {
      if (request.path === '/api/mobile/capabilities/m4b') {
        return { status: 200, body: capabilities({ externalClashHold: false }) };
      }
      return undefined;
    });
    await show(harness, <WatchingScreen />);
    await waitFor(() => expect(screen.queryByTestId('watching-root')).not.toBeNull());

    expect(screen.queryByTestId('watching-held-card')).toBeNull();
    expect(harness.server.matching('GET', /\/held-items$/)).toHaveLength(0);
    expect(harness.server.matching('GET', /\/capabilities\/m4b$/)).not.toHaveLength(0);
  });

  it.each([1, 2, 5])('R1.5 count %i shows one card independently of proactive-loop consent', async (count) => {
    const translate = jest.spyOn(i18next, 't');
    await showWatching(count);
    await waitFor(() => expect(screen.queryByTestId('watching-held-card')).not.toBeNull());
    expect(translate).toHaveBeenCalledWith('zHeldCard', expect.objectContaining({ count }));
    expect(screen.queryAllByTestId('watching-held-card')).toHaveLength(1);
    expect(screen.getByTestId('watching-held-open').props.accessibilityRole).toBe('button');
  });
});
