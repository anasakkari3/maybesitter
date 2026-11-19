import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { strings } from '../../../i18n/strings';

/**
 * C13.9 (owner decision 2026-11-19): the gentle reminder that a Later moved
 * past the start says the time has started, in all three languages, and the
 * sync hands that sentence to the engine.
 */
describe('the started gentle-reminder copy (C13.9)', () => {
  it('is the owner-approved Arabic sentence, with English and Hebrew', () => {
    expect(strings.ar.notifSoftStartedBody).toBe('في إشي طلبت نذكّرك فيه، وقته بلّش.');
    expect(strings.en.notifSoftStartedBody).toMatch(/started/i);
    expect(strings.he.notifSoftStartedBody.length).toBeGreaterThan(0);
  });

  it('is what the sync passes as the started copy', () => {
    const source = readFileSync(join(__dirname, '..', 'useReminderSync.ts'), 'utf8');
    expect(source).toMatch(/startedCopy:\s*\{\s*title: t\.notifSoftTitle,\s*body: t\.notifSoftStartedBody\s*\}/);
  });
});
