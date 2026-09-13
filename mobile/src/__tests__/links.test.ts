/**
 * Deep links (UC-2.R3 #173).
 *
 * A link is the one string a stranger chooses and this app then acts on: any
 * installed app or web page can fire `maybesitter://…`, and the id inside is
 * about to be interpolated into an API path. Most of what follows is about
 * what the parser refuses.
 */
import { describe, expect, it } from '@jest/globals';
import { parseLink } from '../links';

describe('what a link opens', () => {
  it('opens a screen by name', () => {
    expect(parseLink('maybesitter://today')?.target).toEqual({ kind: 'screen', name: 'today' });
    expect(parseLink('maybesitter://settings')?.target).toEqual({ kind: 'screen', name: 'settings' });
  });

  it('opens a commitment', () => {
    expect(parseLink('maybesitter://commitments/c-42')?.target)
      .toEqual({ kind: 'commitment', id: 'c-42' });
    expect(parseLink('maybesitter://commitments/00000000-0000-4000-8000-000000000001')?.target)
      .toEqual({ kind: 'commitment', id: '00000000-0000-4000-8000-000000000001' });
  });

  it('still understands the widget’s older spellings', () => {
    // `item/<id>` and `next` are what the Flutter widget emitted. A widget on
    // someone's home screen outlives the app version that installed it.
    expect(parseLink('maybesitter://item/c-42')?.target).toEqual({ kind: 'commitment', id: 'c-42' });
    expect(parseLink('maybesitter://next')?.target).toEqual({ kind: 'nextStep' });
  });

  it('treats a bare link as Today', () => {
    expect(parseLink('maybesitter://')?.target).toEqual({ kind: 'screen', name: 'today' });
    expect(parseLink('maybesitter:///')?.target).toEqual({ kind: 'screen', name: 'today' });
  });

  it('understands the Expo Go form of the same path', () => {
    expect(parseLink('exp://192.168.1.5:8081/--/commitments/c-42')?.target)
      .toEqual({ kind: 'commitment', id: 'c-42' });
    expect(parseLink('exp://192.168.1.5:8081/--/today')?.target)
      .toEqual({ kind: 'screen', name: 'today' });
  });
});

describe('preferences carried on a link', () => {
  it('applies the ones it recognises', () => {
    const link = parseLink('maybesitter://today?lang=ar&theme=dark');
    expect(link?.lang).toBe('ar');
    expect(link?.theme).toBe('dark');
  });

  it('leaves the keys absent rather than undefined, so a link never clears a stored choice', () => {
    const link = parseLink('maybesitter://today')!;
    expect('lang' in link).toBe(false);
    expect('theme' in link).toBe(false);
  });

  it('ignores values it does not recognise', () => {
    const link = parseLink('maybesitter://today?lang=fr&theme=neon')!;
    expect('lang' in link).toBe(false);
    expect('theme' in link).toBe(false);
  });

  it('carries them on a commitment link too', () => {
    expect(parseLink('maybesitter://commitments/c-42?lang=ar')).toEqual({
      target: { kind: 'commitment', id: 'c-42' }, lang: 'ar',
    });
  });
});

describe('what it refuses', () => {
  it('refuses an id that could climb out of the path', () => {
    for (const id of ['..', '../../users', 'a/../b', '%2e%2e%2f', 'a%2Fb']) {
      expect(parseLink(`maybesitter://commitments/${id}`)).toBeNull();
    }
  });

  it('refuses an id with a query or fragment smuggled into it', () => {
    expect(parseLink('maybesitter://commitments/c-42%3Fadmin=1')).toBeNull();
    expect(parseLink('maybesitter://commitments/c 42')).toBeNull();
  });

  it('refuses an unbounded id', () => {
    // 128 is `USER_ID_PATTERN` in lib/storage/paths.ts, the shape the storage
    // layer already accepts as a document id.
    expect(parseLink(`maybesitter://commitments/${'a'.repeat(128)}`)).not.toBeNull();
    expect(parseLink(`maybesitter://commitments/${'a'.repeat(129)}`)).toBeNull();
  });

  it('refuses a commitment link with no id, or with too many segments', () => {
    expect(parseLink('maybesitter://commitments')).toBeNull();
    expect(parseLink('maybesitter://commitments/')).toBeNull();
    expect(parseLink('maybesitter://commitments/a/b')).toBeNull();
    expect(parseLink('maybesitter://item/a/b')).toBeNull();
  });

  it('refuses a screen name that is not one', () => {
    expect(parseLink('maybesitter://Today')).toBeNull();
    expect(parseLink('maybesitter://../etc/passwd')).toBeNull();
    expect(parseLink('maybesitter://today/extra')).toBeNull();
    expect(parseLink(`maybesitter://${'a'.repeat(40)}`)).toBeNull();
  });

  it('drops a bad link rather than repairing it', () => {
    // Repairing would mean guessing which commitment a stranger meant.
    expect(parseLink('maybesitter://commitments/a b c')).toBeNull();
    expect(parseLink('maybesitter://commitments/<script>')).toBeNull();
  });
});
