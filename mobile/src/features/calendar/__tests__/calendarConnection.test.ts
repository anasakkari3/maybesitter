/**
 * The Trust Center's calendar line, as a rule (UAT round 6, D-d, shot 845).
 *
 * The literal repro: reading on, «حطّ التزاماتي بتقويمي» on with a calendar
 * chosen, events landing three seconds after a confirm — and the row under the
 * switch still said «مش موصول من هون». Every case below walks one field away
 * from that state, the others left as the repro had them.
 */
import { describe, expect, it } from '@jest/globals';
import { calendarConnectionLine, type CalendarConnectionInput } from '../calendarConnection';

/** Shot 845, as it was on the phone. */
const REPRO: CalendarConnectionInput = {
  readEnabled: true,
  writeEnabled: true,
  readConsent: true,
  writeTarget: 'device',
  access: 'granted',
  chosenCalendarId: 'work',
  writableCalendarIds: ['work', 'home'],
};

const line = (change: Partial<CalendarConnectionInput>) => calendarConnectionLine({ ...REPRO, ...change });

describe('the calendar line in the Trust Center', () => {
  it('says connected when it reads and writes (the repro)', () => {
    expect(calendarConnectionLine(REPRO)).toBe('trustCalendarReadingWriting');
  });

  it('says it writes when only writing is on', () => {
    expect(line({ readConsent: false })).toBe('trustCalendarWriting');
  });

  it('says it reads when only reading is on', () => {
    expect(line({ writeTarget: 'off' })).toBe('calendarReadBody');
  });

  it('says not connected when neither is on', () => {
    expect(line({ readConsent: false, writeTarget: 'off' })).toBe('trustCalendarNotConnected');
  });

  it('asks for a pick when writing is on, nothing is chosen, and there are two calendars', () => {
    expect(line({ chosenCalendarId: null })).toBe('calendarPickNeeded');
    expect(line({ chosenCalendarId: null, readConsent: false })).toBe('calendarPickNeeded');
  });

  it('counts the only calendar as chosen, as the Calendar screen and the sync pass do', () => {
    expect(line({ chosenCalendarId: null, writableCalendarIds: ['work'] })).toBe('trustCalendarReadingWriting');
  });

  it('says there is nothing to write into when the phone has no writable calendar', () => {
    expect(line({ chosenCalendarId: null, writableCalendarIds: [] })).toBe('calendarNoneWritable');
  });

  it('hands the line to the phone-settings card when the phone refuses', () => {
    expect(line({ access: 'denied' })).toBe('denied');
    expect(line({ access: 'denied', writeTarget: 'off' })).toBe('denied');
    expect(line({ access: 'denied', readConsent: false })).toBe('denied');
  });

  it('does not call a refusal of nothing a blocked connection', () => {
    expect(line({ access: 'denied', readConsent: false, writeTarget: 'off' })).toBe('trustCalendarNotConnected');
  });

  it('is not connected from this phone until the phone has been asked', () => {
    expect(line({ access: 'undetermined' })).toBe('trustCalendarNotConnected');
    expect(line({ access: 'undetermined', writeTarget: 'off' })).toBe('trustCalendarNotConnected');
  });

  it('says nothing until the phone has answered', () => {
    expect(line({ access: null })).toBeNull();
    expect(line({ writableCalendarIds: null })).toBeNull();
  });

  it('does not wait for a list it does not need', () => {
    expect(line({ writeTarget: 'off', writableCalendarIds: null })).toBe('calendarReadBody');
  });

  it('does not claim what the build switched off', () => {
    expect(line({ writeEnabled: false })).toBe('calendarReadBody');
    expect(line({ readEnabled: false })).toBe('trustCalendarWriting');
    expect(line({ readEnabled: false, writeEnabled: false })).toBe('trustCalendarNotConnected');
  });

  it('reads nothing into another write target', () => {
    expect(line({ writeTarget: 'google' })).toBe('calendarReadBody');
  });
});
