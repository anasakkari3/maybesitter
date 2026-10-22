import React from 'react';
import { AccessibilityInfo } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { isolateAuto } from '../../i18n/bidi';
import {
  NOW,
  initialState,
  outcome,
  panelHandler,
  prepare,
  showPanel,
  teardown,
  type M5bHarness,
} from './harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

let harness: M5bHarness | undefined;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(async () => {
  await teardown(harness);
  harness = undefined;
  jest.useRealTimers();
});

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).join('');
  if (React.isValidElement<{ children?: unknown }>(value)) return textOf(value.props.children);
  return '';
}

async function loaded(options: Parameters<typeof panelHandler>[0]) {
  harness = await prepare('en', initialState(), panelHandler(options));
  const view = await showPanel(harness);
  await waitFor(() => expect(screen.queryByTestId('intelligence-statement')).not.toBeNull());
  return view;
}

describe('M5b-2a R1 learned outcomes', () => {
  it('R1 shows only the five newest confirmed, non-dismissed behaviour outcomes in newest-first order', async () => {
    const rows = [
      outcome('old', 'completed', '2030-03-20T08:00:00.000Z'),
      outcome('one', 'completed', '2030-03-21T08:00:00.000Z'),
      outcome('two', 'postponed', '2030-03-22T08:00:00.000Z'),
      outcome('three', 'dropped', '2030-03-23T08:00:00.000Z'),
      outcome('four', 'completed', '2030-03-24T08:00:00.000Z'),
      outcome('five', 'postponed', '2030-03-25T08:00:00.000Z'),
      outcome('dismissed', 'completed', '2030-03-26T08:00:00.000Z', { review: 'dismissed' }),
      outcome('manual', 'completed', '2030-03-27T08:00:00.000Z', { source: 'manual' }),
    ];
    await loaded({ observations: rows });

    expect(screen.getByTestId('m5b-learned').props.accessibilityState).toEqual(expect.objectContaining({ expanded: false }));
    await fireEvent.press(screen.getByTestId('m5b-learned'));
    const learned = screen.getAllByTestId(/^m5b-learned-row-/).map(node => node.props.testID);
    expect(learned).toEqual([
      'm5b-learned-row-five', 'm5b-learned-row-four', 'm5b-learned-row-three',
      'm5b-learned-row-two', 'm5b-learned-row-one',
    ]);
    expect(screen.queryByTestId('m5b-learned-row-old')).toBeNull();
    expect(screen.queryByTestId('m5b-learned-row-dismissed')).toBeNull();
    expect(screen.queryByTestId('m5b-learned-row-manual')).toBeNull();
    for (const id of ['five', 'four', 'three', 'two', 'one']) {
      expect(textOf(screen.getByTestId(`m5b-learned-row-${id}`).props.children)).toContain(isolateAuto(`Title ${id}`));
      expect(screen.getByTestId(`m5b-learned-wrong-${id}`).props.accessibilityRole).toBe('button');
    }
  });

  const hiddenCases: [string, ReturnType<typeof outcome>[], true | false | 'unknown'][] = [
    ['no outcomes', [], true],
    ['capability off', [outcome('off')], false],
    ['capability unknown', [outcome('unknown')], 'unknown'],
  ];

  it.each(hiddenCases)('R1 parity hides the card with %s', async (_case, observations, capability) => {
    await loaded({ observations: [...observations], capability });
    expect(screen.queryByTestId('m5b-learned')).toBeNull();
    expect(screen.queryByTestId('m5b-learned-status')).not.toBeNull();
  });

  it('R1 parity hides the card for an older inbox with no outcome field', async () => {
    const { outcome: _outcome, ...legacy } = outcome('legacy');
    await loaded({ observations: [legacy] });
    expect(screen.queryByTestId('m5b-learned')).toBeNull();
  });

  it('R1 dismissal probes fresh capability before sending exactly one dismissed review', async () => {
    const order: string[] = [];
    await loaded({ observations: [outcome('fresh')], order });
    await fireEvent.press(screen.getByTestId('m5b-learned'));
    order.length = 0;

    await fireEvent.press(screen.getByTestId('m5b-learned-wrong-fresh'));
    await waitFor(() => expect(harness!.server.matching('POST', /\/intelligence\/observations\/fresh$/)).toHaveLength(1));

    expect(order.slice(0, 2)).toEqual(['capability', 'dismiss']);
    expect(harness!.server.matching('POST', /\/intelligence\/observations\/fresh$/)[0]?.body)
      .toEqual({ review: 'dismissed' });
  });

  it('R1 dismissal sends nothing when the fresh capability answer is false', async () => {
    const options: Parameters<typeof panelHandler>[0] = { observations: [outcome('stopped')], capability: true };
    await loaded(options);
    await fireEvent.press(screen.getByTestId('m5b-learned'));
    options.capability = false;
    // A capability transition after render is represented by the fresh reply;
    // the row must remain from the already-rendered inbox.
    expect(screen.getByTestId('m5b-learned-row-stopped')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('m5b-learned-wrong-stopped'));
    await waitFor(() => expect(harness!.server.matching('GET', /^\/api\/mobile\/capabilities\/m5b$/).length).toBeGreaterThan(1));
    expect(harness!.server.matching('POST', /\/intelligence\/observations\/stopped$/)).toHaveLength(0);
    expect(screen.queryByTestId('m5b-learned-row-stopped')).not.toBeNull();
  });

  it('R1 success removes the last row, refetches, and announces from the panel-scope live region', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
    await loaded({ observations: [outcome('last')] });
    await fireEvent.press(screen.getByTestId('m5b-learned'));
    const readsBefore = harness!.server.matching('GET', /^\/api\/mobile\/intelligence$/).length;

    await fireEvent.press(screen.getByTestId('m5b-learned-wrong-last'));
    await waitFor(() => expect(screen.queryByTestId('m5b-learned-row-last')).toBeNull());

    expect(screen.queryByTestId('m5b-learned')).toBeNull();
    expect(screen.getByTestId('m5b-learned-status').props.accessibilityLiveRegion).toBe('polite');
    expect(textOf(screen.getByTestId('m5b-learned-status').props.children).length).toBeGreaterThan(0);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(harness!.server.matching('GET', /^\/api\/mobile\/intelligence$/).length).toBeGreaterThan(readsBefore);
  });

  it('M5B2A-008 unchanged 200 keeps the row, says no success, and rereads capability and inbox', async () => {
    await loaded({ observations: [outcome('unchanged')], dismissal: 'unchanged' });
    await fireEvent.press(screen.getByTestId('m5b-learned'));
    const caps = harness!.server.matching('GET', /^\/api\/mobile\/capabilities\/m5b$/).length;
    const reads = harness!.server.matching('GET', /^\/api\/mobile\/intelligence$/).length;

    await fireEvent.press(screen.getByTestId('m5b-learned-wrong-unchanged'));
    await waitFor(() => expect(harness!.server.matching('GET', /^\/api\/mobile\/intelligence$/).length).toBeGreaterThan(reads));

    expect(screen.queryByTestId('m5b-learned-row-unchanged')).not.toBeNull();
    expect(textOf(screen.getByTestId('m5b-learned-status').props.children)).toBe('');
    expect(harness!.server.matching('GET', /^\/api\/mobile\/capabilities\/m5b$/).length).toBeGreaterThan(caps);
  });

  it('M5B2A-009 failed POST uses the existing error path and changes nothing', async () => {
    const view = await loaded({ observations: [outcome('failed')], dismissal: 'failed' });
    await fireEvent.press(screen.getByTestId('m5b-learned'));
    const textNodesBefore = view.getAllByText(/[\s\S]*/).length;
    await fireEvent.press(screen.getByTestId('m5b-learned-wrong-failed'));
    await waitFor(() => expect(harness!.server.matching('POST', /\/intelligence\/observations\/failed$/)).toHaveLength(1));

    expect(screen.queryByTestId('m5b-learned-row-failed')).not.toBeNull();
    expect(screen.queryByTestId('intelligence-status')).not.toBeNull();
    expect(textOf(screen.getByTestId('m5b-learned-status').props.children)).toBe('');
    expect(view.getAllByText(/[\s\S]*/).length).toBeGreaterThan(textNodesBefore);
  });
});
