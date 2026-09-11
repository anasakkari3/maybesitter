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
