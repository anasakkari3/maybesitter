import { describe, expect, it } from '@jest/globals';
import { clashLine } from '../clashLine';
import { strings } from '../../../i18n/strings';

/** M6b BB-02 with Codex M6B-R11-004: a range in a clash sentence never breaks at its dash. */
describe('clashLine ranges', () => {
  it('holds a weekly or busy range together with word joiners', () => {
    for (const kind of ['weekly', 'calendar_busy'] as const) {
      const line = clashLine(
        { kind, title: null, startsAt: '2030-03-29T08:00:00.000Z', endsAt: '2030-03-29T10:00:00.000Z' } as never,
        { t: strings.ar, lang: 'ar', timezone: 'Asia/Jerusalem', subjectDay: '2030-03-29' },
      );
      expect(line).toContain('⁠–⁠');
    }
  });
});
