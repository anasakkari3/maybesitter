/**
 * What connecting Google needs from the owner, and how the server finds out
 * whether it has it (CL6a).
 *
 * ── One grant, three features, incremental scopes ────────────────
 *
 * Calendar, Gmail and Drive share one Web OAuth client and one connection per
 * account. Each feature asks for exactly one scope, and only when the person
 * turns that feature on: `calendar.freebusy`, `gmail.readonly`, `drive.file`.
 * `openid` and `userinfo.email` ride along on every request because they are
 * how the grant says *whose* Google account it is — a stable `sub`, whatever
 * the features — and neither is a sensitive scope.
 *
 * ── Where the credentials come from ──────────────────────────────
 *
 * Environment first (local development and tests), then Secret Manager when
 * the process runs on Cloud Run. Reading Secret Manager at runtime rather than
 * through `--set-secrets` is deliberate: a `--set-secrets` entry naming a
 * secret that does not exist yet fails the *deploy*, so wiring the names into
 * `infra/cloudrun/flags.sh` before the owner has created them would take
 * staging down. Read here, a missing secret is the ordinary
 * `provider_not_configured` answer, and creating it is the whole of the
 * owner's step — no deploy, no code change.
 *
 * Nothing in this file logs, and nothing it returns is written anywhere. The
 * client secret lives in memory for the length of a cache entry.
 */
import { fieldEncryptionKeyName } from '../../security/fieldEncryption';

/** The Secret Manager names the owner creates. Not secrets themselves. */
export const GOOGLE_SECRET_NAMES = Object.freeze({
  clientId: 'google-oauth-client-id',
  clientSecret: 'google-oauth-client-secret',
  pickerApiKey: 'google-picker-api-key',
} as const);

/** The environment variables that override Secret Manager (local runs, tests). */
export const GOOGLE_ENV_NAMES = Object.freeze({
  clientId: 'GOOGLE_OAUTH_CLIENT_ID',
  clientSecret: 'GOOGLE_OAUTH_CLIENT_SECRET',
  pickerApiKey: 'GOOGLE_PICKER_API_KEY',
  redirectUri: 'GOOGLE_OAUTH_REDIRECT_URI',
} as const);

/** The path Google redirects the browser to. Registered in the Cloud Console. */
export const GOOGLE_OAUTH_CALLBACK_PATH = '/api/oauth/google/callback';
/** The page that hosts Google Picker. */
export const GOOGLE_PICKER_PAGE_PATH = '/api/oauth/google/picker';
/** Where the callback sends the browser back to: the app's own scheme. */
export const GOOGLE_APP_RETURN_URL = 'maybesitter://oauth/google';
/** Where the Picker page sends the browser back to. */
export const GOOGLE_PICKER_RETURN_URL = 'maybesitter://oauth/google/drive';

/** The busy-time source a Google connection writes. One connection per account, so one source. */
export const GOOGLE_BUSY_SOURCE_ID = 'google:primary';

export const GOOGLE_FEATURES = ['calendar', 'gmail', 'drive'] as const;
export type GoogleFeature = (typeof GOOGLE_FEATURES)[number];

/** The one scope each feature asks for. Nothing broader, and nothing that writes. */
export const GOOGLE_FEATURE_SCOPES: Readonly<Record<GoogleFeature, string>> = Object.freeze({
  calendar: 'https://www.googleapis.com/auth/calendar.freebusy',
  gmail: 'https://www.googleapis.com/auth/gmail.readonly',
  drive: 'https://www.googleapis.com/auth/drive.file',
});

/**
 * Asked on every authorization. As Google *returns* them in `scope`, so the
 * lifecycle's "every requested scope was granted" check compares like with
 * like — Google expands a bare `email` to the `userinfo.email` URL.
 */
export const GOOGLE_IDENTITY_SCOPES: readonly string[] = Object.freeze([
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
]);

export function isGoogleFeature(value: unknown): value is GoogleFeature {
  return typeof value === 'string' && (GOOGLE_FEATURES as readonly string[]).includes(value);
}

/** Which features a set of granted scopes switches on. */
export function featuresGranted(grantedScopes: readonly string[]): Record<GoogleFeature, boolean> {
  return {
    calendar: grantedScopes.includes(GOOGLE_FEATURE_SCOPES.calendar),
    gmail: grantedScopes.includes(GOOGLE_FEATURE_SCOPES.gmail),
    drive: grantedScopes.includes(GOOGLE_FEATURE_SCOPES.drive),
  };
}

/** Reads one secret. Null means "not there" — never a thrown secret value. */
export type GoogleSecretReader = (name: string) => Promise<string | null>;

export interface GoogleConfigEnv {
  readonly GOOGLE_OAUTH_CLIENT_ID?: string;
  readonly GOOGLE_OAUTH_CLIENT_SECRET?: string;
  readonly GOOGLE_PICKER_API_KEY?: string;
  readonly GOOGLE_OAUTH_REDIRECT_URI?: string;
  /** The service's own URL, set on Cloud Run by `infra/scheduler.sh`. */
  readonly MAYBESITTER_INTERNAL_AUDIENCE?: string;
  readonly MAYBESITTER_KMS_KEY_NAME?: string;
  readonly K_SERVICE?: string;
  readonly MAYBESITTER_GCP_PROJECT?: string;
  readonly GOOGLE_CLOUD_PROJECT?: string;
}

/** Everything a connect needs. Present only when every piece is. */
export interface GoogleOAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  /** The origin the Picker page is served from: the redirect URI's own. */
  readonly publicOrigin: string;
  /** Null when the owner has not created the Picker key; Drive then says so. */
  readonly pickerApiKey: string | null;
  /**
   * The Cloud project number, which Picker calls the app id and which grants
   * `drive.file` access to what the person picks. It is the numeric prefix of
   * every OAuth client id, so it is derived rather than configured.
   */
  readonly appId: string | null;
}

/** Why the chain cannot run yet. A closed set; the status route reports it. */
export type GoogleNotConfiguredPart = 'client' | 'redirect_uri' | 'encryption';

export type GoogleConfigResult =
  | { readonly configured: true; readonly config: GoogleOAuthConfig }
  | { readonly configured: false; readonly missing: readonly GoogleNotConfiguredPart[] };

const trimmed = (value: string | null | undefined): string => (typeof value === 'string' ? value.trim() : '');

function redirectFrom(env: GoogleConfigEnv): string {
  const explicit = trimmed(env.GOOGLE_OAUTH_REDIRECT_URI);
  if (explicit) return explicit;
  const audience = trimmed(env.MAYBESITTER_INTERNAL_AUDIENCE);
  if (!audience) return '';
  try {
    return new URL(GOOGLE_OAUTH_CALLBACK_PATH, audience).toString();
  } catch {
    return '';
  }
}

/** A redirect URI Google will accept for a Web client: https, or http on localhost. */
function acceptableRedirect(value: string): URL | null {
  try {
    const url = new URL(value);
    const local = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
    if ((url.protocol !== 'https:' && !local) || url.username || url.password || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

export function appIdFromClientId(clientId: string): string | null {
  const match = /^(\d{6,})-/.exec(clientId);
  return match ? match[1]! : null;
}

export interface ResolveGoogleConfigDeps {
  readonly env: GoogleConfigEnv;
  /** Null when there is nowhere to look beyond the environment. */
  readonly secrets: GoogleSecretReader | null;
}

/**
 * The configuration, or which parts of it are missing.
 *
 * Every part is checked, so the answer to "what is left" is complete rather
 * than the first thing that happened to be absent.
 */
export async function resolveGoogleConfig(deps: ResolveGoogleConfigDeps): Promise<GoogleConfigResult> {
  const { env } = deps;
  const read = async (envValue: string | undefined, secretName: string): Promise<string> => {
    const fromEnv = trimmed(envValue);
    if (fromEnv) return fromEnv;
    if (!deps.secrets) return '';
    try {
      return trimmed(await deps.secrets(secretName));
    } catch {
      // Unreachable Secret Manager is "not configured right now", never a
      // reason to answer with anything the caller could mistake for a secret.
      return '';
    }
  };

  const [clientId, clientSecret, pickerApiKey] = await Promise.all([
    read(env.GOOGLE_OAUTH_CLIENT_ID, GOOGLE_SECRET_NAMES.clientId),
    read(env.GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_SECRET_NAMES.clientSecret),
    read(env.GOOGLE_PICKER_API_KEY, GOOGLE_SECRET_NAMES.pickerApiKey),
  ]);
  const redirect = acceptableRedirect(redirectFrom(env));

  const missing: GoogleNotConfiguredPart[] = [];
  if (!clientId || !clientSecret) missing.push('client');
  if (!redirect) missing.push('redirect_uri');
  // Tokens are only ever stored KMS-encrypted. Without a key there is nowhere
  // honest to put them, so the chain is not configured rather than failing
  // after the person has already been through Google's consent screen.
  if (!fieldEncryptionKeyName(env as NodeJS.ProcessEnv)) missing.push('encryption');
  if (missing.length > 0 || !redirect) return { configured: false, missing };

  return {
    configured: true,
    config: Object.freeze({
      clientId,
      clientSecret,
      redirectUri: redirect.toString(),
      publicOrigin: redirect.origin,
      pickerApiKey: pickerApiKey || null,
      appId: appIdFromClientId(clientId),
    }),
  };
}

/* ── Secret Manager, on Cloud Run only ────────────────────────────── */

const POSITIVE_TTL_MS = 5 * 60_000;
const NEGATIVE_TTL_MS = 60_000;

interface CachedSecret {
  readonly value: string | null;
  readonly until: number;
}

/**
 * A reader over Secret Manager's REST API, or null off Cloud Run.
 *
 * `google-auth-library` is imported lazily, as `lib/auth/schedulerOidc` does,
 * so a test or a local run never loads it or goes looking for credentials. A
 * 404 (not created yet) and a 403 (created, accessor role not granted) both
 * read as absent. Answers are cached briefly — five minutes when present, one
 * when absent — so the status route does not cost a Secret Manager call per
 * screen open, and a secret the owner has just created is noticed within a
 * minute.
 */
export function secretManagerReader(env: GoogleConfigEnv): GoogleSecretReader | null {
  if (!trimmed(env.K_SERVICE)) return null;
  const project = trimmed(env.MAYBESITTER_GCP_PROJECT) || trimmed(env.GOOGLE_CLOUD_PROJECT);
  if (!project) return null;
  return async (name) => {
    const key = `${project}/${name}`;
    const cached = secretCache.get(key);
    const now = Date.now();
    if (cached && cached.until > now) return cached.value;
    const value = await accessSecret(project, name);
    secretCache.set(key, { value, until: now + (value === null ? NEGATIVE_TTL_MS : POSITIVE_TTL_MS) });
    return value;
  };
}

const secretCache = new Map<string, CachedSecret>();

export function resetGoogleSecretCacheForTests(): void {
  secretCache.clear();
}

async function accessSecret(project: string, name: string): Promise<string | null> {
  const { GoogleAuth } = await import('google-auth-library');
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();
  const url = `https://secretmanager.googleapis.com/v1/projects/${encodeURIComponent(project)}`
    + `/secrets/${encodeURIComponent(name)}/versions/latest:access`;
  const response = await client.request<{ payload?: { data?: string } }>({
    url,
    method: 'GET',
    validateStatus: () => true,
    timeout: 5_000,
  });
  if (response.status !== 200) return null;
  const data = response.data?.payload?.data;
  if (typeof data !== 'string' || data === '') return null;
  return Buffer.from(data, 'base64').toString('utf8');
}
