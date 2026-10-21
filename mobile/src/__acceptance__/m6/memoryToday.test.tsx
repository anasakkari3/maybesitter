import React from 'react';
import { Pressable, Text } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { useDescribeProfile } from '../../api/queries';
import { toViewModel } from '../../features/commitments/model';
import { MemoryScreen } from '../../features/memory/MemoryScreen';
import { KnowsScreen } from '../../features/settings/KnowsScreen';
import { ConflictLine } from '../../features/today/ConflictLine';
import { isolateAuto } from '../../i18n/bidi';
import { TodayScreen } from '../../screens/TodayScreen';
import {
  NOW,
  Providers,
  ZONE,
  commitment,
  fact,
  flatStyle,
  prepareM6,
  teardown,
  type Language,
  type M6Harness,
} from './harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

let harness: M6Harness | undefined;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(async () => {
  await teardown(harness);
  harness = undefined;
  jest.useRealTimers();
});

const DIRECTION_CASES = [
  // Arabic: "meeting tomorrow".
  ['ar', '\u0627\u062c\u062a\u0645\u0627\u0639 \u0628\u0643\u0631\u0629', 'rtl', 'right'],
  ['en', 'Dentist tomorrow', 'ltr', 'left'],
  // Hebrew: "meeting tomorrow".
  ['he', '\u05e4\u05d2\u05d9\u05e9\u05d4 \u05de\u05d7\u05e8', 'rtl', 'right'],
] as const;

describe('M6 memory direction, provenance and actions', () => {
  it.each(['ar', 'en', 'he'] as const)(
    'R53.2 %s UI follows each fact first strong character on both memory surfaces',
    async (language) => {
      const items = DIRECTION_CASES.map(([id, content]) => fact(id, content));
      harness = await prepareM6(language, { memoryItems: items });
      await render(
        <Providers harness={harness}>
          <KnowsScreen onBack={() => undefined} onMemory={() => undefined} />
          <MemoryScreen onBack={() => undefined} />
        </Providers>,
      );
      await waitFor(() => expect(screen.queryByTestId('memory-screen-item-en')).not.toBeNull());

      for (const [id, , writingDirection, textAlign] of DIRECTION_CASES) {
        for (const testID of [`memory-item-${id}`, `memory-screen-item-${id}`]) {
          expect(flatStyle(screen.getByTestId(testID))).toMatchObject({ writingDirection, textAlign });
        }
      }
      // The `en` fixture above is the explicit English-in-Arabic-UI regression.
    },
  );

  it('R53.2 SmallAction exposes a 44-point minimum target', async () => {
    harness = await prepareM6('en', {
      handler: request => request.path === '/api/mobile/capabilities/m5b'
        ? { status: 200, body: { success: true, memoryLearning: false } }
        : undefined,
    });
    await render(<Providers harness={harness}><KnowsScreen onBack={() => undefined} onMemory={() => undefined} /></Providers>);
    await waitFor(() => expect(screen.queryByTestId('memory-edit-memory-1')).not.toBeNull());

    expect(Number(flatStyle(screen.getByTestId('memory-edit-memory-1')).minHeight)).toBeGreaterThanOrEqual(44);
  });

  it('M6A-009 puts an exact homogeneous raw source on the group header and otherwise keeps row chips', async () => {
    harness = await prepareM6('en', {
      memoryItems: [
        fact('same-a', 'First fact', 'you_told_us'),
        fact('same-b', 'Second fact', 'you_told_us'),
      ],
    });
    const view = await render(<Providers harness={harness}><MemoryScreen onBack={() => undefined} /></Providers>);
    await waitFor(() => expect(screen.queryByTestId('memory-screen-item-same-b')).not.toBeNull());

    expect(screen.queryByTestId('m6-memory-group-source-told')).not.toBeNull();
    expect(screen.queryByTestId('memory-screen-source-same-a')).toBeNull();
    expect(screen.queryByTestId('memory-screen-source-same-b')).toBeNull();

    await view.unmount();
    await teardown(harness);
    harness = await prepareM6('en', {
      memoryItems: [
        fact('mixed-a', 'First mixed fact', 'you_told_us'),
        fact('mixed-b', 'Second mixed fact', 'you_answered_onboarding'),
      ],
    });
    await render(<Providers harness={harness}><MemoryScreen onBack={() => undefined} /></Providers>);
    await waitFor(() => expect(screen.queryByTestId('memory-screen-item-mixed-b')).not.toBeNull());
    expect(screen.queryByTestId('m6-memory-group-source-told')).toBeNull();
    expect(screen.queryByTestId('memory-screen-source-mixed-a')).not.toBeNull();
    expect(screen.queryByTestId('memory-screen-source-mixed-b')).not.toBeNull();
  });
});

function DescribeProbe() {
  const describe = useDescribeProfile();
  return (
    <Pressable testID="m6-test-describe" onPress={() => describe.mutate('A short self description')}>
      <Text>describe</Text>
    </Pressable>
  );
}

describe('M6 describe locale', () => {
  it.each(['ar', 'en', 'he'] as const)('M6A-008 %s sends the app language in the describe body', async (language) => {
    harness = await prepareM6(language, {
      handler: request => request.path === '/api/mobile/profile/describe'
        ? { status: 200, body: { proposalId: 'proposal-m6', suggestions: [], expiresAt: '2030-03-29T10:00:00.000Z' } }
        : undefined,
    });
    await render(<Providers harness={harness}><DescribeProbe /></Providers>);
    await fireEvent.press(screen.getByTestId('m6-test-describe'));
    await waitFor(() => expect(harness!.server.matching('POST', /^\/api\/mobile\/profile\/describe$/)).toHaveLength(1));

    expect(harness.server.matching('POST', /^\/api\/mobile\/profile\/describe$/)[0]?.body)
      .toEqual({ text: 'A short self description', locale: language });
  });
});

describe('M6 Today title isolation', () => {
  it.each(['ar', 'en', 'he'] as const)('R53.2 %s isolates the folded preview and weekly summary titles', async (language: Language) => {
    const previewTitle = 'English project title';
    // Hebrew: "evening class".
    const weeklyTitle = '\u05e9\u05d9\u05e2\u05d5\u05e8 \u05e2\u05e8\u05d1';
    const items = [
      commitment('primary', { title: 'Primary', priority: { level: 'high', source: 'user_explicit', pressureAllowed: false, pressureLevel: 'none' }, rank: 0 }),
      commitment('preview-a', { title: previewTitle, rank: 1 }),
      commitment('preview-b', { title: 'Another item', rank: 2 }),
    ];
    harness = await prepareM6(language, {
      commitments: items,
      handler: request => request.path === '/api/mobile/weekly-blocks/occurrences'
        ? {
          status: 200,
          body: {
            success: true,
            from: request.query.get('from'),
            to: request.query.get('to'),
            items: [{
              occurrenceId: 'weekly-occurrence', weeklyBlockId: 'weekly-m6', title: weeklyTitle,
              startAt: '2030-03-29T15:00:00.000Z', endAt: '2030-03-29T16:00:00.000Z',
            }],
          },
        }
        : undefined,
    });
    await render(<Providers harness={harness}><TodayScreen /></Providers>);
    await waitFor(() => expect(screen.queryByTestId('today-group-should-preview')).not.toBeNull());
    await waitFor(() => expect(screen.queryByTestId('today-weekly-toggle')).not.toBeNull());

    expect(String(screen.getByTestId('today-group-should-preview').props.children)).toContain(isolateAuto(previewTitle));
    expect(String(screen.getByTestId('today-weekly-toggle').props.accessibilityLabel)).toContain(isolateAuto(weeklyTitle));
  });

  it('R53.2 isolates the ConflictLine title in both visible text and its accessibility label', async () => {
    harness = await prepareM6('ar');
    const title = 'Dentist with Ahmad';
    const item = toViewModel(commitment('conflict', {
      title,
      timeSpec: { kind: 'scheduled_event', dueAt: '2030-03-29T12:00:00.000Z', endAt: '2030-03-29T13:00:00.000Z', remindAt: null, allDay: false, timezone: ZONE },
    }), NOW.toISOString());
    await render(
      <Providers harness={harness}>
        <ConflictLine
          conflict={{
            item,
            at: '2030-03-29T12:00:00.000Z',
            block: { nativeId: 'busy', startAt: '2030-03-29T11:30:00.000Z', endAt: '2030-03-29T13:30:00.000Z', allDay: false },
          }}
          onOpen={() => undefined}
        />
      </Providers>,
    );

    expect(String(screen.getByTestId('today-conflict-title').props.children)).toContain(isolateAuto(title));
    expect(String(screen.getByTestId('today-conflict').props.accessibilityLabel)).toContain(isolateAuto(title));
  });
});

