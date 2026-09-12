/**
 * The one rule that decides whether a build's backend configuration is safe.
 *
 * The retired Flutter client shipped a release build that quietly fell back to
 * `http://localhost:3000`, so a TestFlight tester's app talked to nothing (or
 * worse, to whatever listened on their network). The lesson kept here: fail at
 * build time, and test the real resolution rather than a copy of it.
 *
 * `app.config.ts` calls this while Expo reads the project — before any native
 * compile — and `env.ts` calls the same function at runtime, so the build rule
 * and the runtime rule cannot drift apart.
 *
 * No React Native imports: `app.config.ts` runs in plain Node.
 */

export type AppEnv = 'development' | 'staging' | 'production';

export interface ReleaseConfigInput {
  appEnv?: string | undefined;
  apiBaseUrl?: string | undefined;
  devBearerToken?: string | undefined;
  /**
   * `EXPO_PUBLIC_API_MODE`. `mock` serves the committed contract fixtures
   * instead of the server, which is useful for UI work and catastrophic in a
   * build a tester installs: they would confirm commitments into nothing and
   * believe they were saved (UC-1.4 #148 step 4).
   */
  apiMode?: string | undefined;
}

export const APP_ENVS: readonly AppEnv[] = ['development', 'staging', 'production'];

/** Hosts that only ever mean "a machine on the developer's desk". */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', '10.0.2.2', '10.0.3.2']);

function isPrivateIPv4(hostname: string): boolean {
  const parts = hostname.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local
  return false;
}

/**
 * Problems that must stop a staging or production build. An empty array means
 * the configuration is safe to ship.
 */
export function releaseConfigProblems(input: ReleaseConfigInput): string[] {
  const problems: string[] = [];
  const appEnv = (input.appEnv ?? '').trim();

  if (!APP_ENVS.includes(appEnv as AppEnv)) {
    return [`APP_ENV must be one of ${APP_ENVS.join(', ')} (got ${appEnv === '' ? '<empty>' : appEnv})`];
  }
  const apiMode = (input.apiMode ?? '').trim();
  if (apiMode !== '' && apiMode !== 'api' && apiMode !== 'mock') {
    problems.push(`EXPO_PUBLIC_API_MODE must be api or mock (got ${apiMode})`);
  }

  // A developer build is allowed to point at a laptop, and to run on fixtures.
  if (appEnv === 'development') return problems;

  if (apiMode === 'mock') {
    problems.push('EXPO_PUBLIC_API_MODE=mock must not be set in a staging or production build');
  }

  const raw = (input.apiBaseUrl ?? '').trim();
  if (raw === '') {
    problems.push('EXPO_PUBLIC_API_BASE_URL is empty');
  } else {
    let url: URL | null = null;
    try {
      url = new URL(raw);
    } catch {
      problems.push(`EXPO_PUBLIC_API_BASE_URL is not a valid URL (${raw})`);
    }
    if (url) {
      if (url.protocol !== 'https:') {
        problems.push(`EXPO_PUBLIC_API_BASE_URL must use https (got ${url.protocol.replace(':', '')})`);
      }
      const hostname = url.hostname.toLowerCase();
      if (
        LOCAL_HOSTNAMES.has(hostname) ||
        hostname.endsWith('.local') ||
        hostname.endsWith('.localhost') ||
        hostname.endsWith('.invalid') ||
        hostname.endsWith('.test') ||
        hostname.endsWith('.example') ||
        isPrivateIPv4(hostname)
      ) {
        problems.push(`EXPO_PUBLIC_API_BASE_URL points at a local or private host (${hostname})`);
      }
    }
  }

  if ((input.devBearerToken ?? '').trim() !== '') {
    problems.push('EXPO_PUBLIC_DEV_BEARER_TOKEN must not be set in a staging or production build');
  }

  return problems;
}

/** The message shown in a build log and on the misconfigured screen. */
export function releaseConfigErrorMessage(problems: readonly string[]): string {
  return `CFG-1 release config: ${problems.join('; ')}`;
}
