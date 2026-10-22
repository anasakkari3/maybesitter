import { describe, expect, it } from '@jest/globals';
import { isolateAuto, isolateQuoted } from '../bidi';

/** M6b BB-07 and Codex M6B-R04: a quoted title keeps its own direction inside an Arabic sentence. */
describe('isolateQuoted', () => {
  it('isolates a quoted title', () => {
    expect(isolateQuoted('اكتب «إنهاء مشروع التخرج M6D» اليوم')).toBe(`اكتب «${isolateAuto('إنهاء مشروع التخرج M6D')}» اليوم`);
  });
  it('isolates the outermost span and keeps nested quotes inside it', () => {
    expect(isolateQuoted('راجع «M6D «المرحلة الأولى» plan»')).toBe(`راجع «${isolateAuto('M6D «المرحلة الأولى» plan')}»`);
  });
  it('handles adjacent spans', () => {
    expect(isolateQuoted('«a» و«ب»')).toBe(`«${isolateAuto('a')}» و«${isolateAuto('ب')}»`);
  });
  it('leaves an empty pair and an unbalanced quote exactly as written', () => {
    expect(isolateQuoted('قبل «» بعد')).toBe('قبل «» بعد');
    expect(isolateQuoted('بلا إغلاق «M6D')).toBe('بلا إغلاق «M6D');
    expect(isolateQuoted('إغلاق وحده » هون')).toBe('إغلاق وحده » هون');
  });

  // Codex M6B-R3-003: the Hebrew and English plan templates quote the goal with "…" and “…”.
  it('isolates a Hebrew template\'s straight quotes and an English template\'s curly ones', () => {
    expect(isolateQuoted('לכתוב מה זה אומר לסיים את "לסיים פרויקט M6D"')).toBe(`לכתוב מה זה אומר לסיים את "${isolateAuto('לסיים פרויקט M6D')}"`);
    expect(isolateQuoted('לפנות זמן ל"M6D סיום" כמה פעמים')).toBe(`לפנות זמן ל"${isolateAuto('M6D סיום')}" כמה פעמים`);
    expect(isolateQuoted('Work on “إنهاء المشروع M6D” a few times a week')).toBe(`Work on “${isolateAuto('إنهاء المشروع M6D')}” a few times a week`);
  });
  it('nests curly quotes, pairs straight quotes in turn, and keeps other pairs inside a span', () => {
    expect(isolateQuoted('Split “the “M6D” thesis” now')).toBe(`Split “${isolateAuto('the “M6D” thesis')}” now`);
    expect(isolateQuoted('"א" ו"B"')).toBe(`"${isolateAuto('א')}" ו"${isolateAuto('B')}"`);
    expect(isolateQuoted('Pick “«ب» M6D”')).toBe(`Pick “${isolateAuto('«ب» M6D')}”`);
  });
  it('leaves empty and unbalanced straight and curly quotes exactly as written', () => {
    expect(isolateQuoted('לפני "" אחרי')).toBe('לפני "" אחרי');
    expect(isolateQuoted('בלי סגירה "M6D')).toBe('בלי סגירה "M6D');
    expect(isolateQuoted('No close “M6D')).toBe('No close “M6D');
    expect(isolateQuoted('Close alone ” here')).toBe('Close alone ” here');
  });
});
