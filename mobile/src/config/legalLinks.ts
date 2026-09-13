/**
 * The legal pages, per language (UC-4.2, #177).
 *
 * ── Everything here can be null, and that is the design ──────────
 *
 * The domain is not bought yet (OWNER-A1, #137). Every function returns `null`
 * until `EXPO_PUBLIC_LEGAL_BASE_URL` names an https origin, and every caller
 * renders nothing rather than a row that 404s. A dead privacy link is worse
 * than no privacy link: it is the one place where looking careless *is* the
 * substance of the complaint.
 *
 * ── No identifiers, ever ─────────────────────────────────────────
 *
 * The URL is a bare path. Nothing appends a uid, a locale query parameter, an
 * install id or a campaign tag. Somebody reading our privacy policy must not
 * be identifiable to us for having read it, and a page that took `?uid=` would
 * make the policy itself the tracking.
 *
 * ── Hebrew was routed before it was selectable ───────────────────
 *
 * This mapping was written while `he` was still out of the picker, so that the
 * day the font gate cleared the policy links would already be right. The gate
 * cleared in UC-2.R5: the app bundles a Hebrew face and the picker offers
 * עברית, and `/he/` has been the correct page all along.
 */
import * as WebBrowser from 'expo-web-browser';
import { legalBaseUrl, legalUrls } from './env';
import { DEFAULT_LOCALE, LOCALES, type Locale } from '../i18n/locale';

export type LegalPage = 'privacy' | 'terms' | 'delete-account';

/**
 * The path segment for a language.
 *
 * Anything the site does not publish falls back to English rather than 404ing
 * — the same rule `apiLocale` uses, for the same reason.
 */
export function legalLocaleSegment(locale: string | null | undefined): Locale {
  const base = (locale ?? '').toLowerCase().split(/[-_]/)[0] ?? '';
  return (LOCALES as readonly string[]).includes(base) ? base as Locale : DEFAULT_LOCALE;
}

function pageUrl(page: LegalPage, locale: string | null | undefined): string | null {
  const base = legalBaseUrl();
  if (base === null) return null;
  return `${base}/${legalLocaleSegment(locale)}/${page}`;
}

/**
 * The privacy policy for a language.
 *
 * Falls back to the single `EXPO_PUBLIC_PRIVACY_URL` when no base URL is set,
 * so a build configured before this issue keeps its link — in English, which
 * is what that variable always was.
 */
export function privacyPolicyUrl(locale?: string | null): string | null {
  return pageUrl('privacy', locale) ?? legalUrls().privacy;
}

export function termsUrl(locale?: string | null): string | null {
  return pageUrl('terms', locale) ?? legalUrls().terms;
}

/**
 * The public account-deletion page the stores require (UC-4.3b, #179).
 *
 * Separate from the in-app deletion flow (UC-1.5, #149), which is the real
 * thing. This page exists because Apple and Google require a URL a person can
 * reach *without* installing the app.
 */
export function accountDeletionPageUrl(locale?: string | null): string | null {
  return pageUrl('delete-account', locale);
}

/** Every legal page this app can link to, for a language. */
export function legalLinksFor(locale?: string | null): Record<LegalPage, string | null> {
  return {
    privacy: privacyPolicyUrl(locale),
    terms: termsUrl(locale),
    'delete-account': accountDeletionPageUrl(locale),
  };
}

/**
 * Opens a legal page in the in-app browser.
 *
 * Resolves to `false` when the page could not be opened — no configured URL,
 * or the browser refused. The caller shows the URL so somebody offline can
 * still write it down; it never throws, because a failed policy link must not
 * be able to take a screen with it.
 */
export async function openLegal(url: string | null): Promise<boolean> {
  if (url === null) return false;
  try {
    await WebBrowser.openBrowserAsync(url);
    return true;
  } catch {
    return false;
  }
}
