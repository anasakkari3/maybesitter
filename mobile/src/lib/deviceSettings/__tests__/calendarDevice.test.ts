/**
 * The device half of duplicate suppression (UC-3.1, #185).
 *
 * The server refuses a second installation's link; that refusal only means
 * anything if the two installations actually call themselves different things,
 * and if one installation calls itself the *same* thing every time it is asked.
 * An id that were re-minted on every read would make a phone a stranger to its
 * own events, and it would stop being able to move or remove them.
 *
 * This is also where #184's absence is written down. `resolveWriterId` mints
 * and keeps its own value rather than importing `src/lib/installationId.ts`,
 * which is being built in another lane; see the module header for what that
 * costs and for the one function that changes when it lands.
 */
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  CALENDAR_ID_KEY,
  WRITER_ID_KEY,
  WRITTEN_EVENT_IDS_KEY,
  chosenCalendarKey,
  writtenEventIdsKey,
  forgetWrittenEventId,
  loadChosenCalendarId,
  loadExcludedCalendarIds,
  loadWrittenEventIds,
  rememberWrittenEventId,
  resetWriterIdCache,
  resolveWriterId,
  saveChosenCalendarId,
  saveExcludedCalendarIds,
} from '../calendarDevice';

beforeEach(async () => {
  await AsyncStorage.clear();
  resetWriterIdCache();
});

afterEach(async () => {
  await AsyncStorage.clear();
  resetWriterIdCache();
});

describe('who this installation says it is', () => {
  it('answers the same thing every time, across a restart', async () => {
    const first = await resolveWriterId();
    // A cold start: the in-memory cache is gone, the stored value is not.
    resetWriterIdCache();
    expect(await resolveWriterId()).toBe(first);
  });

  it('is not the same as another installation’s', async () => {
    const mine = await resolveWriterId();
    // A different install has an empty store of its own.
    await AsyncStorage.clear();
    resetWriterIdCache();
    expect(await resolveWriterId()).not.toBe(mine);
  });

  it('is kept, so the account can tell this phone from the next one', async () => {
    const id = await resolveWriterId();
    expect(await AsyncStorage.getItem(WRITER_ID_KEY)).toBe(id);
  });

  it('mints a fresh one rather than throwing when the stored value is unusable', async () => {
    await AsyncStorage.setItem(WRITER_ID_KEY, '   ');
    resetWriterIdCache();
    const id = await resolveWriterId();
    expect(id.trim()).not.toBe('');
    // A new id owns nothing, so it overwrites nothing. That is the safe
    // direction, and it is why this does not fail the whole sync.
    expect(id).not.toBe('   ');
  });
});

const UID = 'uid-a';

describe('the calendar this device writes into', () => {
  it('is null until one is picked', async () => {
    expect(await loadChosenCalendarId(UID)).toBeNull();
  });

  it('survives being set and cleared', async () => {
    await saveChosenCalendarId(UID, 'cal-1');
    expect(await loadChosenCalendarId(UID)).toBe('cal-1');
    await saveChosenCalendarId(UID, null);
    expect(await loadChosenCalendarId(UID)).toBeNull();
  });

  it('is kept per account and never read from the installation-wide value (M5A-R21-001)', async () => {
    await AsyncStorage.setItem(CALENDAR_ID_KEY, 'legacy');
    await saveChosenCalendarId(UID, 'cal-a');
    expect(await loadChosenCalendarId('uid-b')).toBeNull();
    expect(await loadChosenCalendarId(UID)).toBe('cal-a');
    expect(await AsyncStorage.getItem(chosenCalendarKey(UID))).toBe('cal-a');
  });
});

describe('the events this installation wrote', () => {
  it('starts empty, and records each id once', async () => {
    expect(await loadWrittenEventIds(UID)).toEqual([]);
    await rememberWrittenEventId(UID, 'evt-1');
    await rememberWrittenEventId(UID, 'evt-1');
    expect(await loadWrittenEventIds(UID)).toEqual(['evt-1']);
  });

  it('forgets an id when its event is removed', async () => {
    await rememberWrittenEventId(UID, 'evt-1');
    await rememberWrittenEventId(UID, 'evt-2');
    await forgetWrittenEventId(UID, 'evt-1');
    expect(await loadWrittenEventIds(UID)).toEqual(['evt-2']);
  });

  it('reads garbage as "none recorded" rather than throwing', async () => {
    // The consequence of an empty answer is that UC-3.2 (#186) counts our own
    // events as busy: a redundant warning, never a missed one.
    await AsyncStorage.setItem(writtenEventIdsKey(UID), 'not json');
    expect(await loadWrittenEventIds(UID)).toEqual([]);
  });

  it('keeps only strings out of a list that has been tampered with', async () => {
    await AsyncStorage.setItem(writtenEventIdsKey(UID), JSON.stringify(['evt-1', 7, null, 'evt-2']));
    expect(await loadWrittenEventIds(UID)).toEqual(['evt-1', 'evt-2']);
  });

  it('is kept per account: another account never skips these as its own (M5A-R20-004)', async () => {
    await AsyncStorage.setItem(WRITTEN_EVENT_IDS_KEY, JSON.stringify(['legacy-evt']));
    await rememberWrittenEventId(UID, 'evt-a');
    expect(await loadWrittenEventIds('uid-b')).toEqual([]);
    expect(await loadWrittenEventIds(UID)).toEqual(['evt-a']);
  });
});

describe('calendars switched off for busy time (first iPhone run, L7)', () => {
  it('is none until the user switches one off', async () => {
    expect(await loadExcludedCalendarIds()).toEqual([]);
  });

  it('round-trips, without duplicates', async () => {
    await saveExcludedCalendarIds(['a', 'b', 'a']);
    expect(await loadExcludedCalendarIds()).toEqual(['a', 'b']);
  });

  it('keeps ids only, whatever else was written there', async () => {
    await AsyncStorage.setItem('calendar.excludedCalendarIds.v1', JSON.stringify(['a', 7, { title: 'Oncology' }, '']));
    expect(await loadExcludedCalendarIds()).toEqual(['a']);
  });

  it('reads an unreadable value as none switched off', async () => {
    await AsyncStorage.setItem('calendar.excludedCalendarIds.v1', '{not json');
    expect(await loadExcludedCalendarIds()).toEqual([]);
  });
});
