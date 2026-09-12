import Constants from 'expo-constants';
import { APP_ENVS, releaseConfigProblems, type AppEnv } from './releaseGuard';

/**
 * The app's view of its own configuration.
 *
 * It runs the same `releaseConfigProblems` rule the build ran (app.config.ts),
 * so the two can never drift. A build that slipped through — an old binary, a
 * hand-patched bundle — renders the misconfigured screen instead of talking to
 * whatever host it was handed.
 */

type Extra = { appEnv?: string; apiBaseUrl?: string | null };

function extra(): Extra {
  return (Constants.expoConfig?.extra ?? {}) as Extra;
}

export function appEnv(): AppEnv {
  const value = process.env.EXPO_PUBLIC_APP_ENV ?? extra().appEnv ?? 'development';
  return (APP_ENVS as readonly string[]).includes(value) ? (value as AppEnv) : 'development';
}

export function apiBaseUrl(): string | null {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? extra().apiBaseUrl ?? null;
}

/** Empty when this build is safe to use. */
export function configProblems(): string[] {
  return releaseConfigProblems({
    appEnv: process.env.EXPO_PUBLIC_APP_ENV ?? extra().appEnv,
    apiBaseUrl: apiBaseUrl() ?? undefined,
    devBearerToken: process.env.EXPO_PUBLIC_DEV_BEARER_TOKEN,
  });
}

export function isDevelopment(): boolean {
  return appEnv() === 'development';
}

/**
 * The local sign-in override's token (UC-1.7 #151), or null.
 *
 * Reading it here is not the same as honouring it: `src/auth/devBypass.ts`
 * decides that, and `releaseConfigProblems` above already refuses to *build*
 * a staging or production app with the variable set.
 */
export function devBearerToken(): string | null {
  const raw = (process.env.EXPO_PUBLIC_DEV_BEARER_TOKEN ?? '').trim();
  return raw === '' ? null : raw;
}

/**
 * The privacy policy and terms URLs, from the build's environment.
 *
 * They are null until OWNER-A1 (#137) publishes the site: the sign-in screen
 * then renders the links, and until then it renders none rather than a link
 * that 404s on the one screen a new user judges the product on. Nothing here
 * invents a domain.
 */
export function legalUrls(): { privacy: string | null; terms: string | null } {
  return {
    privacy: httpsUrlOrNull(process.env.EXPO_PUBLIC_PRIVACY_URL),
    terms: httpsUrlOrNull(process.env.EXPO_PUBLIC_TERMS_URL),
  };
}

function httpsUrlOrNull(value: string | undefined): string | null {
  const raw = (value ?? '').trim();
  if (raw === '') return null;
  try {
    return new URL(raw).protocol === 'https:' ? raw : null;
  } catch {
    return null;
  }
}
