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
  const row = (title: string | null, minutes = 120) => ({ title, startsAt: at(minutes), endsAt: at(minutes + 30) });
  it('a meeting or an appointment that has not started', () => {
    expect(planItemPrepTarget(row('Meeting with Sami'), NOW)).toEqual({ startAt: at(120), endAt: at(150) });
    expect(planItemPrepTarget(row('Dentist'), NOW)).toEqual({ startAt: at(120), endAt: at(150), appointment: true });
  });
  it('not an errand, a removed item, or one about to start', () => {
    expect(planItemPrepTarget(row('Call mum'), NOW)).toBeNull();
    expect(planItemPrepTarget(row(null), NOW)).toBeNull();
    expect(planItemPrepTarget(row('Dentist', 5), NOW)).toBeNull();
  });
});
