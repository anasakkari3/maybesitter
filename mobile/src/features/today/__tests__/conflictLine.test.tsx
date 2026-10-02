/**
 * Today's conflict line (Stitch, 2026-10-02): which item it names, that it
 * says both lines whole, and that a tap explains rather than postpones.
 */
import React, { useState } from 'react';
import { Text } from 'react-native';
import { describe, expect, it } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { AppProvider, useApp } from '../../../state/AppContext';
import { ConflictLine, ConflictSheet } from '../ConflictLine';
import { firstConflict, type TodayConflict } from '../todayConflict';
import type { CommitmentView } from '../../commitments/model';
import type { DeviceBusyBlock } from '../../calendar/busyBlocks';
import en from '../../../i18n/locales/en.json';

const METRICS: Metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };

function view(id: string, shownAt: string | null, over: Partial<CommitmentView> = {}): CommitmentView {
  return { id, title: id, importance: 'must', status: 'active', shownAt, isPast: false, importanceIsStated: true, rank: undefined, reasonCodes: [], ...over } as CommitmentView;
}

function block(startAt: string, endAt: string, allDay = false): DeviceBusyBlock {
  return { startAt, endAt, allDay } as DeviceBusyBlock;
}

describe('firstConflict', () => {
  const busy = [block('2026-10-02T17:00:00.000Z', '2026-10-02T18:00:00.000Z')];

  it('names the earliest open item whose hour is inside busy time', () => {
    const found = firstConflict([
      view('late', '2026-10-02T17:45:00.000Z'),
      view('early', '2026-10-02T17:30:00.000Z'),
      view('free', '2026-10-02T12:00:00.000Z'),
    ], busy);
    expect(found?.item.id).toBe('early');
    expect(found?.block.startAt).toBe('2026-10-02T17:00:00.000Z');
  });

  it('is half-open like every interval in the product: an item at the block\'s end does not clash', () => {
    expect(firstConflict([view('edge', '2026-10-02T18:00:00.000Z')], busy)).toBeNull();
  });

  it('skips what is finished, what has no hour, and all-day items', () => {
    expect(firstConflict([
      view('done', '2026-10-02T17:30:00.000Z', { status: 'done' }),
      view('untimed', null),
      view('allday', '2026-10-02T17:30:00.000Z', { allDay: true }),
    ], busy)).toBeNull();
  });
});

const CONFLICT: TodayConflict = {
  item: view('dentist', '2026-10-02T17:30:00.000Z', { title: 'Dentist' }),
  at: '2026-10-02T17:30:00.000Z',
  block: block('2026-10-02T17:00:00.000Z', '2026-10-02T18:00:00.000Z'),
};

function Harness() {
  const [open, setOpen] = useState(false);
  const { s } = useApp();
  return (
    <>
      <ConflictLine conflict={CONFLICT} onOpen={() => setOpen(true)} />
      <ConflictSheet conflict={open ? CONFLICT : null} onClose={() => setOpen(false)} />
      <Probe detail={s.detailId} />
    </>
  );
}

function Probe({ detail }: { detail: string | null }) {
  return <Text testID="probe-detail">{detail ?? 'none'}</Text>;
}

async function show() {
  await render(<SafeAreaProvider initialMetrics={METRICS}><AppProvider><Harness /></AppProvider></SafeAreaProvider>);
}

describe('the line', () => {
  it('says the item and its hour, then what it runs into, whole', async () => {
    await show();
    expect(String(screen.getByTestId('today-conflict-title').props.children)).toContain('Dentist');
    const busyLine = screen.getByTestId('today-conflict-busy');
    expect(String(busyLine.props.children)).toContain(en.calendarBusyConflict.replace(' {range}', ''));
    // Two whole lines: neither is cut to a line count.
    expect(busyLine.props.numberOfLines).toBeUndefined();
    expect(screen.getByTestId('today-conflict-title').props.numberOfLines).toBeUndefined();
  });

  it('opens an explanation, not the postpone sheet', async () => {
    await show();
    expect(screen.queryByTestId('today-conflict-sheet')).toBeNull();
    await fireEvent.press(screen.getByTestId('today-conflict'));
    await waitFor(() => expect(screen.queryByTestId('today-conflict-sheet')).not.toBeNull());
    expect(screen.getByText(en.todayConflictTitle)).toBeTruthy();
    expect(String(screen.getByTestId('today-conflict-explain').props.children)).toContain('Dentist');
    expect(screen.queryByTestId('postpone-sheet')).toBeNull();
    expect(screen.queryByTestId('postpone-oneHour')).toBeNull();
  });

  it('leaves everything as it was on «Leave it as is», and opens the item on «Open it»', async () => {
    await show();
    await fireEvent.press(screen.getByTestId('today-conflict'));
    await fireEvent.press(screen.getByTestId('today-conflict-keep'));
    await waitFor(() => expect(screen.queryByTestId('today-conflict-sheet')).toBeNull());
    expect(screen.getByTestId('probe-detail').props.children).toBe('none');

    await fireEvent.press(screen.getByTestId('today-conflict'));
    await fireEvent.press(screen.getByTestId('today-conflict-open-item'));
    await waitFor(() => expect(screen.getByTestId('probe-detail').props.children).toBe('dentist'));
  });
});
