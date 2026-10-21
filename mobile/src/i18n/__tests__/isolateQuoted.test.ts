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
});
