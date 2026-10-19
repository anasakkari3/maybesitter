import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { FootballSettingsScreen } from '../../features/settings/FootballSettingsScreen';
import { Root } from '../../Root';
import {
  ITEM_ID,
  NOW,
  capabilities,
  footballResponse,
  instant,
  prepare,
  press,
  providers,
  show,
  showDetails,
  teardown,
  type M4bHarness,
} from './harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: jest.fn(() => ({ width: 390, height: 844, scale: 3, fontScale: 3.12 })),
}));

const LANGUAGES = ['ar', 'en', 'he'] as const;
const CLASH = {
  title: 'Dinner', startsAt: instant('2030-03-30', '20:00'), endsAt: instant('2030-03-30', '21:00'), kind: 'commitment',
};
const SLOT = {
  startsAt: instant('2030-03-30', '17:00'), endsAt: instant('2030-03-30', '18:00'),
  localDate: '2030-03-30', localTime: '17:00', why: 'light_day', slotToken: 'layout-slot-token',
};

let harness: M4bHarness | undefined;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(async () => {
  await teardown(harness);
  harness = undefined;
  jest.useRealTimers();
});

function unclipped(testID: string): void {
  const node = screen.getByTestId(testID);
  expect(node.props.numberOfLines).not.toBe(1);
  expect(node.props.ellipsizeMode).toBeUndefined();
}

describe('M4b locales and AX5 layout contracts', () => {
  it.each(LANGUAGES)('R1.5 %s held row and its actions remain present and unclamped at AX5', async (language) => {
    harness = await prepare(language, request => request.path === '/api/mobile/football'
      ? {
        status: 200,
        body: footballResponse({
          held: [{
            fixtureId: 'fixture-layout', heldVersion: 'layout-v1', homeTeamName: 'Barcelona', awayTeamName: 'Real Madrid',
            kickoffUtc: instant('2030-03-30', '20:00'), endUtc: instant('2030-03-30', '22:00'), moved: false, clashes: [CLASH],
          }],
          waitingForCoverage: 0,
        }),
      }
      : undefined);
    await show(harness, <FootballSettingsScreen onBack={() => undefined} />);

    await waitFor(() => expect(screen.queryByTestId('football-held-fixture-layout')).not.toBeNull());
    unclipped('football-held-fixture-layout');
    expect(screen.queryByTestId('football-held-add-fixture-layout')).not.toBeNull();
    expect(screen.queryByTestId('football-held-dismiss-fixture-layout')).not.toBeNull();
  });

  it.each(LANGUAGES)('R2.3 %s impact line and radio chips remain present and unclamped at AX5', async (language) => {
    const proposal = {
      version: 'v1', proposalId: 'layout-proposal', revision: 2, status: 'proposed', seeds: [],
      items: [{
        itemId: 'layout-evening', title: 'Birthday dinner', resolvedTime: instant('2030-03-29', '21:00'),
        endTime: instant('2030-03-29', '23:30'), needsClarification: false,
        impacts: [{
          kind: 'late_before_important', role: 'evening', otherTitle: 'Math exam',
          otherStartsAt: instant('2030-03-30', '09:00'), otherEndsAt: instant('2030-03-30', '11:00'),
          readiness: null, prep: null,
        }],
      }],
      understood: [{ kind: 'commitment', itemId: 'layout-evening', text: 'Birthday dinner' }],
    };
    harness = await prepare(language, request => {
      if (request.path === '/api/mobile/capabilities/m4b') return { status: 200, body: capabilities() };
      if (request.path === '/api/mobile/capture/chat') {
        return {
          status: 200,
          body: {
            conversationId: 'layout-conversation', reply: 'Review.', engine: 'rules', proposal,
            turns: [{ role: 'user', text: 'Dinner and exam' }, { role: 'assistant', text: 'Review.' }],
          },
        };
      }
      return undefined;
    });
    await render(providers(harness, <Root />));
    await waitFor(() => expect(screen.queryByTestId('tab-capture')).not.toBeNull());
    await press('tab-capture');
    await waitFor(() => expect(screen.queryByTestId('capture-input')).not.toBeNull());
    await act(async () => { await fireEvent.changeText(screen.getByTestId('capture-input'), 'Dinner and exam'); });
    await press('capture-analyze');
    await waitFor(() => expect(harness!.server.matching('POST', /\/capture\/chat$/)).toHaveLength(1));
    if (screen.queryByTestId('understood-confirm')) await press('understood-confirm');

    await waitFor(() => expect(screen.queryByTestId('impact-line-layout-evening')).not.toBeNull());
    unclipped('impact-line-layout-evening');
    unclipped('impact-ready-group-layout-evening');
    for (const answer of ['ready', 'not_ready', 'unsure']) {
      expect(screen.queryByTestId(`impact-ready-layout-evening-${answer}`)).not.toBeNull();
    }
  });

  it.each(LANGUAGES)('R3.3 %s postpone slot remains present and unclamped at AX5', async (language) => {
    harness = await prepare(language, request => request.path === `/api/mobile/commitments/${ITEM_ID}/postpone-slots`
      ? { status: 200, body: { success: true, complete: true, slots: [SLOT] } }
      : undefined);
    await showDetails(harness);
    await press('details-postpone');

    await waitFor(() => expect(screen.queryByTestId('postpone-slot-0')).not.toBeNull());
    unclipped('postpone-slot-0');
    expect(screen.getByTestId('postpone-slot-0').props.accessibilityRole).toBe('button');
  });
});
