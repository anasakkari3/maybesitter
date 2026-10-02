import { describe, expect, it } from '@jest/globals';
import { busyBlockPrepTarget, commitmentPrepTarget, isAppointmentNotMeeting, isMeetingLike, planItemPrepTarget } from '../prepTargets';
import { APPOINTMENT_NOUNS } from '../../../../../src/extraction/lexicon/appointmentNouns';

const NOW = new Date('2026-09-28T06:00:00.000Z');
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();

describe('which busy blocks offer «حضّرني»', () => {
  it('a timed block that starts later than ten minutes from now', () => {
    expect(busyBlockPrepTarget({ nativeId: 'e', startAt: at(120), endAt: at(165), allDay: false }, NOW))
      .toEqual({ startAt: at(120), endAt: at(165) });
  });

  it('not an all-day block, one about to start, or one already going', () => {
    expect(busyBlockPrepTarget({ nativeId: 'e', startAt: at(120), endAt: at(1560), allDay: true }, NOW)).toBeNull();
    expect(busyBlockPrepTarget({ nativeId: 'e', startAt: at(5), endAt: at(50), allDay: false }, NOW)).toBeNull();
    expect(busyBlockPrepTarget({ nativeId: 'e', startAt: at(-30), endAt: at(30), allDay: false }, NOW)).toBeNull();
  });
});

describe('which commitments are meetings', () => {
  it.each([
    'اجتماع مع المدير', 'الاجتماع الأسبوعي', 'ميتنغ الفريق', 'موعد دكتور', 'مقابلة شغل',
    'دكتور الأسنان الساعة 4', 'بالموعد مع سامي', 'امتحان رياضيات',
    'Meeting with Sami', 'Dentist appointment', 'Job interview', 'dentist 4pm', 'Flight to Rome',
    'פגישה עם המנהל', 'ראיון עבודה', 'תור לרופא', 'בפגישה עם דנה',
  ])('%s is', (title) => {
    expect(isMeetingLike(title)).toBe(true);
  });

  it.each([
    'اشتري حليب', 'Buy milk', 'Submit the report', 'לקנות חלב', 'Pick up the kids',
    // A noun inside another word is not the noun (M-4): «لزوم» is not «زوم»,
    // «اجتماعي» (social) is not «اجتماع», «בתור» ("as") is not «תור».
    'مش لزوم', 'نشاط اجتماعي', 'בתור מנהל',
  ])('%s is not', (title) => {
    expect(isMeetingLike(title)).toBe(false);
  });

  it('reads the extractor\'s appointment nouns, not a list of its own', () => {
    for (const noun of [...APPOINTMENT_NOUNS.ar, ...APPOINTMENT_NOUNS.he, ...APPOINTMENT_NOUNS.en]) {
      expect([noun, isMeetingLike(noun)]).toEqual([noun, true]);
    }
  });

  const commitment = (title: string, timeSpec: Partial<{ kind: string; dueAt: string | null; endAt: string | null; allDay: boolean }>) => ({
    title,
    status: 'active',
    timeSpec: { kind: 'due_by', dueAt: at(120), endAt: null, allDay: false, ...timeSpec },
  });

  it('a timed, open, meeting-like commitment offers its own time', () => {
    expect(commitmentPrepTarget(commitment('اجتماع مع المدير', {}) as never, NOW)).toEqual({ startAt: at(120), endAt: null });
    // A plain appointment, as capture stores it (`due_by`, no end): offered too.
    expect(commitmentPrepTarget(commitment('dentist 4pm', {}) as never, NOW)).toEqual({ startAt: at(120), endAt: null, appointment: true });
    expect(commitmentPrepTarget(commitment('مش لزوم نطول', {}) as never, NOW)).toBeNull();
    expect(commitmentPrepTarget(commitment('Anything', { kind: 'scheduled_event', endAt: at(240) }) as never, NOW))
      .toEqual({ startAt: at(120), endAt: at(240) });
  });

  it('not an errand, not an untimed or all-day meeting, not one that is closed', () => {
    expect(commitmentPrepTarget(commitment('Buy milk', {}) as never, NOW)).toBeNull();
    expect(commitmentPrepTarget(commitment('Meeting', { dueAt: null }) as never, NOW)).toBeNull();
    expect(commitmentPrepTarget(commitment('Meeting', { allDay: true }) as never, NOW)).toBeNull();
    expect(commitmentPrepTarget({ ...commitment('Meeting', {}), status: 'completed' } as never, NOW)).toBeNull();
  });
});

describe('a meeting, or an appointment that is not one', () => {
  it.each(['dentist 4pm', 'موعد دكتور', 'امتحان رياضيات', 'תור לרופא', 'Flight to Rome'])('%s is an appointment', (title) => {
    expect(isAppointmentNotMeeting(title)).toBe(true);
  });
  it.each(['Meeting with Sami', 'اجتماع مع المدير', 'ميتنغ الفريق', 'פגישה עם המנהל', 'Anything', 'اجتماع بالعيادة'])('%s is not', (title) => {
    expect(isAppointmentNotMeeting(title)).toBe(false);
  });
});

describe('which fixed rows on the Plan offer «حضّرني»', () => {
  const row = (title: string | null, minutes = 120) => ({ itemId: 'c-row', title, startsAt: at(minutes), endsAt: at(minutes + 30) });
  it('a meeting or an appointment that has not started', () => {
    expect(planItemPrepTarget(row('Meeting with Sami'), NOW)).toEqual({ startAt: at(120), endAt: at(150), commitmentId: 'c-row' });
    expect(planItemPrepTarget(row('Dentist'), NOW)).toEqual({ startAt: at(120), endAt: at(150), appointment: true, commitmentId: 'c-row' });
  });
  // Review of audit 2026-10-03 #3: «حضّرني» from the Plan tab sent no
  // commitment, so tomorrow's exam got the hour-before plan there.
  it('names the commitment, so an exam planned from the Plan tab gets the day before; a guessed end is not sent', () => {
    expect(planItemPrepTarget({ ...row('امتحان رياضيات'), endEstimated: true }, NOW))
      .toEqual({ startAt: at(120), endAt: null, appointment: true, commitmentId: 'c-row' });
  });
  it('not an errand, a removed item, or one about to start', () => {
    expect(planItemPrepTarget(row('Call mum'), NOW)).toBeNull();
    expect(planItemPrepTarget(row(null), NOW)).toBeNull();
    expect(planItemPrepTarget(row('Dentist', 5), NOW)).toBeNull();
  });
});

/*
 * Every word the meeting detection is asked to know, in both directions
 * (CL5a M-4, round 2): the meeting words round 1 lost, the appointment it
 * gained, and the look-alikes that must stay out. `meeting` says whether the
 * sheet calls it «الاجتماع» (true) or «الموعد» (false).
 */
describe('the meeting and appointment words, both directions', () => {
  it.each([
    // Arabic meetings, including the ones round 1 lost.
    ['لقاء مع سامي', true], ['اللقاء الأسبوعي', true], ['بلقاء العميل', true],
    ['ميتنج الفريق', true], ['ميتنغ الفريق', true], ['ميتينج مع المدير', true],
    ['زوم مع العميل', true], ['بالزوم مع دانا', true], ['اجتماع مع المدير', true],
    // English meetings.
    ['Standup', true], ['Daily stand-up', true], ['Team sync', true], ['1:1 with Dana', true],
    ['One-on-one with Dana', true], ['Call with the bank', true], ['Zoom call with Sara', true], ['Meeting with Sami', true],
    // Hebrew meetings.
    ['שיחת זום עם דנה', true], ['זום עם הלקוח', true], ['ישיבת צוות', true], ['שיחה עם רון', true], ['פגישה עם המנהל', true],
    // Appointments, not meetings.
    ['dentist 4pm', false], ['Dentist appointment', false], ['دكتور الأسنان الساعة 4', false],
    ['Court hearing', false], ['Court date at 9', false], ['جلسة محكمة', false], ['תור לרופא', false],
  ])('%s is offered (meeting: %s)', (title, meeting) => {
    expect(isMeetingLike(title)).toBe(true);
    expect(isAppointmentNotMeeting(title)).toBe(!meeting);
  });

  it.each([
    // A noun inside another word, or a word that only looks like one.
    'مش لزوم', 'مش لزوم نطول', 'نشاط اجتماعي', 'בתור מנהל',
    // A court you play on is not a court you appear in.
    'Basketball court', 'Book the tennis court', 'Food court lunch', 'Courtyard cleanup',
    // "call" alone is an errand; "sync" and "zoom" inside other words are not.
    'Call mum', 'Recall with the insurer', 'Async review of the doc', 'Zoomed photos', 'שיחת טלפון לאמא',
  ])('%s is not', (title) => {
    expect(isMeetingLike(title)).toBe(false);
  });
});
