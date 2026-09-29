/**
 * The weekly blocks' device-event links, on this phone, per account.
 *
 * The uid in the key is the safety: a block's event is removed when the
 * account no longer has the block, so a second account reading the first
 * one's links would delete the first person's events.
 */
import { beforeEach, expect, it } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { WEEKLY_EVENT_LINKS_KEY, loadWeeklyEventLinks, saveWeeklyEventLinks } from '../calendarDevice';

const LINK = { blockId: 'b1', calendarId: 'cal-1', eventIds: ['evt-1'], contentHash: 'abc' };

beforeEach(async () => { await AsyncStorage.clear(); });

it('keeps one account\'s links away from another\'s', async () => {
  expect(await saveWeeklyEventLinks('alice', [LINK])).toBe(true);
  expect(await loadWeeklyEventLinks('alice')).toEqual([LINK]);
  expect(await loadWeeklyEventLinks('bob')).toEqual([]);
});

it('reads a corrupt record as unknown (null), never as "none"', async () => {
  await AsyncStorage.setItem(`${WEEKLY_EVENT_LINKS_KEY}:alice`, '{not json');
  expect(await loadWeeklyEventLinks('alice')).toBeNull();
  await AsyncStorage.setItem(`${WEEKLY_EVENT_LINKS_KEY}:alice`, '{"a":1}');
  expect(await loadWeeklyEventLinks('alice')).toBeNull();
});

it('drops a malformed entry and keeps only the fields it wrote', async () => {
  await AsyncStorage.setItem(`${WEEKLY_EVENT_LINKS_KEY}:alice`, JSON.stringify([
    { ...LINK, title: 'leaked?', detached: true },
    { blockId: '', calendarId: 'x', eventIds: [], contentHash: 'y' },
    { blockId: 'b2', calendarId: 'x', eventIds: [3], contentHash: 'y' },
  ]));
  expect(await loadWeeklyEventLinks('alice')).toEqual([{ ...LINK, detached: true }]);
});
