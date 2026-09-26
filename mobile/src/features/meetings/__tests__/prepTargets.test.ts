import { describe, expect, it } from '@jest/globals';
import { busyBlockPrepTarget, commitmentPrepTarget, isMeetingLike } from '../prepTargets';

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
    'Meeting with Sami', 'Dentist appointment', 'Job interview', 'call with the bank',
    'פגישה עם המנהל', 'ראיון עבודה',
  ])('%s is', (title) => {
    expect(isMeetingLike(title)).toBe(true);
  });

  it.each(['اشتري حليب', 'Buy milk', 'Submit the report', 'לקנות חלב', 'Pick up the kids'])('%s is not', (title) => {
    expect(isMeetingLike(title)).toBe(false);
  });

  const commitment = (title: string, timeSpec: Partial<{ kind: string; dueAt: string | null; endAt: string | null; allDay: boolean }>) => ({
    title,
    status: 'active',
    timeSpec: { kind: 'due_by', dueAt: at(120), endAt: null, allDay: false, ...timeSpec },
  });

  it('a timed, open, meeting-like commitment offers its own time', () => {
    expect(commitmentPrepTarget(commitment('اجتماع مع المدير', {}) as never, NOW)).toEqual({ startAt: at(120), endAt: null });
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
