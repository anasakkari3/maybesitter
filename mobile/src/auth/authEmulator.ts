/**
 * Pointing the app's sign-in at a local Firebase Auth emulator — and the four
 * conditions that make it impossible anywhere else.
 *
 * ── Why this exists ──────────────────────────────────────────────
 *
 * The app could not be driven against a local backend at all. `devBypass.ts`
 * lets the *gate* open with a bearer token of the developer's choosing, but
 * nothing on the server has ever read one: `runtimeConfig.ts` lists
 * `MAYBESITTER_DEV_AUTH` as forbidden and no module reads it. So the backend
 * accepts exactly one thing — a Firebase ID token its Admin SDK can verify —
 * and with `FIREBASE_AUTH_EMULATOR_HOST` set that means a token minted by the
 * emulator. The app's SDK talks to the production project, so every local
 * request came back 401 and the only way to exercise `/api/mobile/**` was
 * curl. Proven, not assumed: dev bearer → 401, emulator token → 200
 * (2026-09-22).
 *
 * This closes that. It is deliberately shaped like `devBypass`: a pure
 * decision over explicit inputs, tested against the shipping combinations,
 * with `releaseGuard.ts` failing the *build* if the variable is set for
 * staging or production — so a binary that could honour it is never made.
 *
 * It is a narrower hole than the bearer override, not a wider one. The bearer
 * skips authentication; this only moves *where* authentication happens, and
 * the account still signs in, still gets a real ID token, and the server
 * still verifies it. What it cannot do is let an unauthenticated request
 * through.
 *
 * No React Native imports: the rule is callable from Jest and from
 * `app.config.ts`'s sibling guard.
 */
import type { AppEnv } from '../config/releaseGuard';

/** Hosts that only ever mean "an emulator on the developer's own machine". */
const LOCAL_EMULATOR_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '10.0.2.2', '10.0.3.2']);

export interface AuthEmulatorInput {
  /** React Native's `__DEV__`: false in every release bundle. */
  isDevBundle: boolean;
  appEnv: AppEnv | string | undefined;
  /** The backend this build talks to. An emulator with a remote API is a mix. */
  apiBaseUrl: string | null | undefined;
  /** `EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST`, e.g. `127.0.0.1:9099`. */
  host: string | null | undefined;
}

/** True only when all four conditions hold at once. */
export function authEmulatorAllowed(input: AuthEmulatorInput): boolean {
  if (input.isDevBundle !== true) return false;
  if (input.appEnv !== 'development') return false;
  if (authEmulatorHost(input.host) === null) return false;
  return apiHostIsLocal(input.apiBaseUrl);
}

/**
 * The URL to hand `connectAuthEmulator`, or null when it is not allowed here.
 *
 * Both halves are checked. A host on someone else's machine is not an
 * emulator, and a port is required: `connectAuthEmulator` would otherwise
 * default to 80 and fail in a way that reads as a network problem.
 */
export function authEmulatorUrl(input: AuthEmulatorInput): string | null {
  if (!authEmulatorAllowed(input)) return null;
  return `http://${authEmulatorHost(input.host)}`;
}

/** `host:port`, lower-cased, or null if it is not a local emulator address. */
function authEmulatorHost(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim();
  if (value === '') return null;
  let url: URL;
  try {
    // A bare `host:port` is not a URL, so it is parsed as one.
    url = new URL(`http://${value.replace(/^https?:\/\//, '')}`);
  } catch {
    return null;
  }
  if (url.port === '') return null;
  const hostname = url.hostname.toLowerCase();
  if (!LOCAL_EMULATOR_HOSTS.has(hostname)) return null;
  // Anything past the authority is not an emulator address.
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null;
  return `${hostname}:${url.port}`;
}

function apiHostIsLocal(apiBaseUrl: string | null | undefined): boolean {
  const raw = (apiBaseUrl ?? '').trim();
  if (raw === '') return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return LOCAL_EMULATOR_HOSTS.has(url.hostname.toLowerCase());
}
