import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { screen, waitFor } from '@testing-library/react-native';
import {
  NOW,
  ZONE,
  initialState,
  panelHandler,
  panelState,
  prepare,
  readdMarker,
  readdTestIds,
  showPanel,
  teardown,
  type Capability,
  type M5bHarness,
} from './harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

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

async function loaded(capability: Capability, observations: Record<string, unknown>[]) {
  const state = panelState({ capability, observations });
  harness = await prepare('en', initialState(), panelHandler(state));
  await showPanel(harness);
  await waitFor(() => expect(screen.queryByTestId('intelligence-statement')).not.toBeNull());
}

describe('M5b-2b-2 compatibility and off-state parity', () => {
  it('R3 App parity hides a marker when an older server sends no readd field', async () => {
    const legacy = readdMarker('legacy') as Record<string, unknown>;
    delete legacy.readd;
    await loaded(true, [legacy]);

    expect(screen.queryByTestId(readdTestIds.row('legacy'))).toBeNull();
    expect(screen.queryByTestId(readdTestIds.guess('legacy'))).toBeNull();
    expect(screen.queryByTestId(readdTestIds.right('legacy'))).toBeNull();
  });

  it.each([false, 'unknown'] as const)('R3 App parity hides re-add rows when capability is %s', async capability => {
    await loaded(capability, [readdMarker(`hidden-${capability}`)]);

    expect(screen.queryByTestId('m5b-learned')).toBeNull();
    expect(screen.queryByTestId(readdTestIds.row(`hidden-${capability}`))).toBeNull();
  });

  it('R3 App parity with M5b off has no re-add rows and makes no extra generate or review requests', async () => {
    await loaded(false, [readdMarker('off')]);

    expect(screen.queryByTestId(readdTestIds.row('off'))).toBeNull();
    expect(harness!.server.matching('GET', /^\/api\/mobile\/intelligence$/)).toHaveLength(1);
    expect(harness!.server.matching('POST', /^\/api\/mobile\/intelligence\/generate$/)).toHaveLength(0);
    expect(harness!.server.matching('POST', /\/api\/mobile\/intelligence\/observations\//)).toHaveLength(0);
  });
});
