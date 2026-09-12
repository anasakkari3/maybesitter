/**
 * The developer's way past the sign-in gate — and the three conditions that
 * make it impossible anywhere else.
 *
 * The retired Flutter client shipped a bearer token read from configuration,
 * and a release build would happily use whatever it was handed. This override
 * is deliberately the opposite: it is a pure decision over explicit inputs, it
 * is tested against the shipping combinations, and `releaseGuard.ts` fails the
 * *build* if the variable is set for staging or production, so a binary that
 * could honour it never gets made.
 *
 * No React Native imports: the guard is called from `app.config.ts`'s sibling
 * rule and from Jest with `__DEV__` forced false.
 */
import type { AppEnv } from '../config/releaseGuard';
import type { AuthUser } from './types';

/** Hosts that only ever mean "a backend on the developer's own machine". */
const LOCAL_API_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '10.0.2.2', '10.0.3.2']);

export interface DevBypassInput {
  /** React Native's `__DEV__`: false in every release bundle. */
  isDevBundle: boolean;
  appEnv: AppEnv | string | undefined;
  apiBaseUrl: string | null | undefined;
  token: string | null | undefined;
}

/** True only when all four conditions hold at once. */
export function devBypassAllowed(input: DevBypassInput): boolean {
  if (input.isDevBundle !== true) return false;
  if (input.appEnv !== 'development') return false;
  if ((input.token ?? '').trim() === '') return false;
  return apiHostIsLocal(input.apiBaseUrl);
}

/** The token to send, or null when the override is not allowed here. */
export function devBypassToken(input: DevBypassInput): string | null {
  return devBypassAllowed(input) ? (input.token ?? '').trim() : null;
}

/**
 * The synthetic user the gate reports while the override is active. It is
 * marked with the `dev` provider id so any screen that cares can tell it from
 * a real Firebase session.
 */
export const DEV_BYPASS_USER: AuthUser = Object.freeze({
  uid: 'dev-local-user',
  email: null,
  emailVerified: true,
  displayName: 'Developer',
  providerIds: ['dev'],
});

function apiHostIsLocal(apiBaseUrl: string | null | undefined): boolean {
  const raw = (apiBaseUrl ?? '').trim();
  // An unset base URL in development means the app is talking to a local
  // Metro-hosted backend; a missing value must not widen the rule, so it is
  // refused rather than assumed.
  if (raw === '') return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return LOCAL_API_HOSTS.has(url.hostname.toLowerCase());
}
