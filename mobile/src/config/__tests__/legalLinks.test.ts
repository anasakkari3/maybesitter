/**
 * The legal URLs (UC-4.2, #177).
 *
 * Two properties carry the weight: nothing is ever invented when no domain is
 * configured, and nothing identifying is ever appended to a URL. A privacy
 * policy that could tell us who read it would be its own violation.
 */
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import {
  accountDeletionPageUrl,
  legalLinksFor,
  legalLocaleSegment,
  privacyPolicyUrl,
  termsUrl,
} from '../legalLinks';

const KEYS = [
  'EXPO_PUBLIC_LEGAL_BASE_URL',
  'EXPO_PUBLIC_PRIVACY_URL',
  'EXPO_PUBLIC_TERMS_URL',
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('with no domain configured', () => {
  it('invents nothing', () => {
    // OWNER-A1 (#137) has not bought the domain. Every caller has to render
    // nothing rather than a link that 404s.
    expect(privacyPolicyUrl('en')).toBeNull();
    expect(termsUrl('ar')).toBeNull();
    expect(accountDeletionPageUrl('he')).toBeNull();
    expect(legalLinksFor('en')).toEqual({ privacy: null, terms: null, 'delete-account': null });
  });
});

describe('with a base URL', () => {
  beforeEach(() => {
    process.env.EXPO_PUBLIC_LEGAL_BASE_URL = 'https://maybesitter.example';
  });

  it('routes each language to its own page', () => {
    expect(privacyPolicyUrl('en')).toBe('https://maybesitter.example/en/privacy');
    expect(privacyPolicyUrl('ar')).toBe('https://maybesitter.example/ar/privacy');
    expect(privacyPolicyUrl('he')).toBe('https://maybesitter.example/he/privacy');
    expect(termsUrl('ar')).toBe('https://maybesitter.example/ar/terms');
    expect(accountDeletionPageUrl('he')).toBe('https://maybesitter.example/he/delete-account');
  });

  it('falls back to English for a language the site does not publish', () => {
    expect(privacyPolicyUrl('fr')).toBe('https://maybesitter.example/en/privacy');
    expect(privacyPolicyUrl(null)).toBe('https://maybesitter.example/en/privacy');
    expect(privacyPolicyUrl(undefined)).toBe('https://maybesitter.example/en/privacy');
  });

  it('accepts a regional tag and the legacy Hebrew code', () => {
    expect(legalLocaleSegment('ar-IL')).toBe('ar');
    expect(legalLocaleSegment('he_IL')).toBe('he');
    expect(legalLocaleSegment('EN-GB')).toBe('en');
  });

  it('appends nothing that could identify the reader', () => {
    // No uid, no install id, no locale query parameter, no campaign tag.
    for (const url of Object.values(legalLinksFor('ar'))) {
      expect(url).not.toBeNull();
      expect(url).not.toMatch(/[?#]/);
    }
  });

  it('does not double the slash when the base has a trailing one', () => {
    process.env.EXPO_PUBLIC_LEGAL_BASE_URL = 'https://maybesitter.example///';
    expect(privacyPolicyUrl('en')).toBe('https://maybesitter.example/en/privacy');
  });
});

describe('an unusable base URL', () => {
  it('is refused rather than used over http', () => {
    // A policy fetched over http can be rewritten in transit by anyone on the
    // network, which is exactly the document that must not be.
    process.env.EXPO_PUBLIC_LEGAL_BASE_URL = 'http://maybesitter.example';
    expect(privacyPolicyUrl('en')).toBeNull();
  });

  it('is refused when it is not a URL at all', () => {
    process.env.EXPO_PUBLIC_LEGAL_BASE_URL = 'maybesitter.example';
    expect(privacyPolicyUrl('en')).toBeNull();
    process.env.EXPO_PUBLIC_LEGAL_BASE_URL = '   ';
    expect(privacyPolicyUrl('en')).toBeNull();
  });
});

describe('the two variables that predate this issue', () => {
  it('still work, in English, when no base URL is set', () => {
    process.env.EXPO_PUBLIC_PRIVACY_URL = 'https://old.example/privacy';
    process.env.EXPO_PUBLIC_TERMS_URL = 'https://old.example/terms';
    expect(privacyPolicyUrl('ar')).toBe('https://old.example/privacy');
    expect(termsUrl('ar')).toBe('https://old.example/terms');
    // The deletion page has no legacy variable, so it stays null.
    expect(accountDeletionPageUrl('ar')).toBeNull();
  });

  it('are superseded by the base URL when both are set', () => {
    process.env.EXPO_PUBLIC_LEGAL_BASE_URL = 'https://maybesitter.example';
    process.env.EXPO_PUBLIC_PRIVACY_URL = 'https://old.example/privacy';
    expect(privacyPolicyUrl('ar')).toBe('https://maybesitter.example/ar/privacy');
  });
});
