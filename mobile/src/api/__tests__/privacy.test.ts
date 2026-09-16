import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { strings, type Lang } from '../../i18n/strings';
import ar from '../../i18n/locales/ar.json';
import en from '../../i18n/locales/en.json';
import he from '../../i18n/locales/he.json';
import {
  ConflictError,
  ContractError,
  ForbiddenError,
  IcsFeedRefusedError,
  NetworkError,
  NotFoundError,
  ServerError,
  ServiceUnavailableError,
  TimeoutError,
  UnauthorizedError,
  ValidationError,
} from '../errors';
import { forbiddenReason, userFacingMessage } from '../ui/userFacingMessage';

/**
 * Two rules the client cannot be trusted to keep by review alone.
 *
 * A `console.log` in a networking layer puts the user's commitment titles and
 * their ID token in the device log, where any other app's crash reporter can
 * pick them up. And an error message rendered straight from the server puts
 * "[auth/wrong-password] ... for someone@example.com" on screen.
 */

const API = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === '__tests__' || entry === '__fixtures__' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry) ? [path] : [];
  });
}

describe('the API layer logs nothing', () => {
  it('makes no console call anywhere under src/api', () => {
    const offenders = sourceFiles(API)
      .filter(path => /\bconsole\.\w+\(/.test(readFileSync(path, 'utf8')))
      .map(path => path.slice(API.length + 1));
    expect(offenders).toEqual([]);
  });

  it('imports nothing that could put a commitment on disk', () => {
    // No persister, no offline mutation queue. A commitment title in
    // unencrypted storage is what #157 refuses, and an import is the only way
    // it could get there — so the rule is about imports, not about whether a
    // comment happens to name the module.
    const forbidden = /from '[^']*(async-storage|query-(a)?sync-storage-persister|expo-file-system|expo-secure-store)[^']*'|persistQueryClient/;
    const offenders = sourceFiles(API)
      .filter(path => forbidden.test(readFileSync(path, 'utf8')))
      .map(path => path.slice(API.length + 1));
    expect(offenders).toEqual([]);
  });

  it('reports a contract failure with paths and codes, never the payload', () => {
    const error = new ContractError('/api/mobile/commitments/today', ['items.0.title: invalid_type']);
    expect(error.message).not.toContain('dentist');
    expect(error.issues.join(' ')).not.toMatch(/[؀-ۿ]/);
  });
});

describe('userFacingMessage is the only way an error becomes words', () => {
  const cases: Array<[string, unknown, keyof typeof en]> = [
    ['network', new NetworkError('fetch failed at https://x'), 'errorsNetwork'],
    ['timeout', new TimeoutError('aborted after 15000ms'), 'errorsNetwork'],
    ['server', new ServerError('Internal Server Error', 500), 'errorsServer'],
    ['unavailable', new ServiceUnavailableError('upstream down'), 'errorsServer'],
    ['contract', new ContractError('/x', ['a: b']), 'errorsServer'],
    ['validation', new ValidationError('text is required'), 'errorsValidation'],
    ['not found', new NotFoundError('Commitment not found'), 'errorsNotFound'],
    ['unauthorized', new UnauthorizedError('expired', 'token_expired'), 'authSessionExpired'],
    ['revoked', new ForbiddenError('no', 'revoked'), 'authSignedOutRevoked'],
    ['deleted', new ForbiddenError('no', 'deleted'), 'authSignedOutDeleted'],
    ['consent', new ForbiddenError('no', 'consent_required'), 'errorsConsentRequired'],
    ['quiet mode', new ForbiddenError('no', 'quiet_mode'), 'errorsQuietMode'],
    ['feature disabled', new ForbiddenError('no', 'feature_disabled'), 'errorsFeatureDisabled'],
    ['conflict', new ConflictError('stale'), 'errorsGeneric'],
    ['something else', new Error('boom'), 'errorsGeneric'],
    // The calendar feed refusals (UC-3.4, #188): one sentence per reason, and a
    // detail code that never reaches the screen.
    ['feed url refused', new IcsFeedRefusedError('invalid_url', 'blocked_address'), 'icsFeedsErrInvalidUrl'],
    ['feed not a calendar', new IcsFeedRefusedError('not_a_calendar', null), 'icsFeedsErrNotCalendar'],
    ['feed fetch failed', new IcsFeedRefusedError('fetch_failed', 'timeout'), 'icsFeedsErrFetch'],
    ['feed too complex', new IcsFeedRefusedError('calendar_too_complex', null), 'icsFeedsErrTooComplex'],
    ['feed cap', new IcsFeedRefusedError('too_many_feeds', null), 'icsFeedsErrTooMany'],
    ['feed refresh cooldown', new IcsFeedRefusedError('refresh_too_soon', null), 'icsFeedsErrTooSoon'],
    ['deadline passed', new IcsFeedRefusedError('past_due', null), 'icsFeedsErrPast'],
    ['deadline changed', new IcsFeedRefusedError('invalid_action', null), 'icsFeedsErrChanged'],
    ['feed storage unavailable', new IcsFeedRefusedError('encryption_unavailable', 'kms_unavailable'), 'icsFeedsErrUnavailable'],
  ];

  it.each(cases)('maps a %s failure to its own copy', (_name, error, key) => {
    for (const lang of ['ar', 'en'] as Lang[]) {
      expect(userFacingMessage(error, strings[lang])).toBe(strings[lang][key]);
    }
  });

  it('never lets a developer word reach the screen, in any locale', () => {
    // Every message this function can produce, in all three locales.
    const banned = /(Error:|Exception|backend|https?:|\bat \w+\.\w+|stack|undefined|null)/i;
    const bundles: Array<[string, Record<string, string>]> = [
      ['en', en as unknown as Record<string, string>],
      ['ar', ar as unknown as Record<string, string>],
      ['he', he as unknown as Record<string, string>],
    ];
    for (const [locale, bundle] of bundles) {
      for (const [, , key] of cases) {
        const rendered = String(bundle[key]);
        expect({ locale, key, offends: banned.test(rendered) }).toEqual({ locale, key, offends: false });
      }
    }
  });

  it('never interpolates the error message', () => {
    const leaky = new ValidationError('text is required for someone@example.com');
    for (const lang of ['ar', 'en'] as Lang[]) {
      expect(userFacingMessage(leaky, strings[lang])).not.toContain('someone@example.com');
    }
  });

  it('has Hebrew copy for every message, even though Hebrew is not selectable yet', () => {
    // Read from the bundle rather than through `t`: one locale key is a list
    // of day names, so the union `t` accepts is not simply "every key".
    const bundle = he as unknown as Record<string, unknown>;
    for (const [, , key] of cases) expect(typeof bundle[key]).toBe('string');
  });

  it('names only the 403 reasons the product has a screen for', () => {
    expect(forbiddenReason(new ForbiddenError('no', 'revoked'))).toBe('revoked');
    expect(forbiddenReason(new ForbiddenError('no', 'something_new'))).toBeNull();
    expect(forbiddenReason(new NetworkError('x'))).toBeNull();
  });
});
