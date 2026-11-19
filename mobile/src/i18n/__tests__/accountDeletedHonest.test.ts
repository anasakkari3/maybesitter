/**
 * QA v3 V3-F35-04: the last screen of account deletion said nothing of the
 * person was left on the servers, right after the screen that listed what
 * stays (encrypted backups for up to 30 days). The last words must not
 * contradict that list: they name the same backup window, in every language.
 */
import { describe, expect, it } from '@jest/globals';
import ar from '../locales/ar.json';
import en from '../locales/en.json';
import he from '../locales/he.json';

const daysIn = (text: string) => text.match(/\d+/g) ?? [];

describe('the account-deleted message agrees with what stays', () => {
  const locales: Array<[string, { accountDeleteWhatStaysBackups: string; accountDeletedBody: string }]> = [['ar', ar], ['en', en], ['he', he]];
  it.each(locales)('%s names the backup window the list gave', (_lang, strings) => {
    const backupDays = daysIn(strings.accountDeleteWhatStaysBackups);
    expect(backupDays.length).toBe(1);
    expect(daysIn(strings.accountDeletedBody)).toContain(backupDays[0]);
  });

  // QA v3: the list before this screen names crash reports for 90 days as
  // well as the backups, so «بس» / "Only" / «רק» in front of the backups
  // contradicted it. The backup window itself is unchanged.
  const exclusive: Array<[string, string, RegExp]> = [
    ['ar', ar.accountDeletedBody, /(^|[\s،.])بس([\s،.]|$)/],
    ['en', en.accountDeletedBody, /\bonly\b/i],
    ['he', he.accountDeletedBody, /(^|[\s,.])רק([\s,.]|$)/],
  ];
  it.each(exclusive)('%s does not call the backups the only thing left', (_lang, body, word) => {
    expect(body).not.toMatch(word);
    expect(body).toContain('30');
  });

  it('no longer claims nothing is left', () => {
    expect(en.accountDeletedBody).not.toMatch(/nothing of yours is left/i);
  });
});
