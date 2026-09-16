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
  WRITER_ID_KEY,
  WRITTEN_EVENT_IDS_KEY,
  forgetWrittenEventId,
  loadChosenCalendarId,
  loadWrittenEventIds,
  rememberWrittenEventId,
  resetWriterIdCache,
  resolveWriterId,
  saveChosenCalendarId,
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

describe('the calendar this device writes into', () => {
  it('is null until one is picked', async () => {
    expect(await loadChosenCalendarId()).toBeNull();
  });

  it('survives being set and cleared', async () => {
    await saveChosenCalendarId('cal-1');
    expect(await loadChosenCalendarId()).toBe('cal-1');
    await saveChosenCalendarId(null);
    expect(await loadChosenCalendarId()).toBeNull();
  });
});

describe('the events this installation wrote', () => {
  it('starts empty, and records each id once', async () => {
    expect(await loadWrittenEventIds()).toEqual([]);
    await rememberWrittenEventId('evt-1');
    await rememberWrittenEventId('evt-1');
    expect(await loadWrittenEventIds()).toEqual(['evt-1']);
  });

  it('forgets an id when its event is removed', async () => {
    await rememberWrittenEventId('evt-1');
    await rememberWrittenEventId('evt-2');
    await forgetWrittenEventId('evt-1');
    expect(await loadWrittenEventIds()).toEqual(['evt-2']);
  });

  it('reads garbage as "none recorded" rather than throwing', async () => {
    // The consequence of an empty answer is that UC-3.2 (#186) counts our own
    // events as busy: a redundant warning, never a missed one.
    await AsyncStorage.setItem(WRITTEN_EVENT_IDS_KEY, 'not json');
    expect(await loadWrittenEventIds()).toEqual([]);
  });

  it('keeps only strings out of a list that has been tampered with', async () => {
    await AsyncStorage.setItem(WRITTEN_EVENT_IDS_KEY, JSON.stringify(['evt-1', 7, null, 'evt-2']));
    expect(await loadWrittenEventIds()).toEqual(['evt-1', 'evt-2']);
  });
});
