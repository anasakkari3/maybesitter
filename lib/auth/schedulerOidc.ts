/**
 * Who may call the internal job routes (UC-1.0d, #143).
 *
 * ── Why these routes need their own verifier ─────────────────────
 *
 * Cloud Run services are reachable from the internet. `/api/internal/jobs/*`
 * runs due work for every user, so "only Cloud Scheduler calls it" has to be
 * something the service *checks*, not something the topology implies.
 *
 * The caller is Cloud Scheduler with an OIDC token, which is a Google-signed
 * JWT identifying a **service account** — not a Firebase ID token identifying
 * a person. `lib/auth/tokenVerifier` (UC-1.0e) cannot verify it: that path
 * goes through `getAuth().verifyIdToken`, which only accepts ID tokens minted
 * for this Firebase project. Hence a separate, small verifier here.
 *
 * ── What is checked, and why each one ────────────────────────────
 *
 * 1. Google's signature and the `aud` claim, via `verifyIdToken`. The audience
 *    is the service's own URL, so a token minted for staging cannot be
 *    replayed against production.
 * 2. `iss` is Google. Cheap, and it keeps a token from some other issuer that
 *    happened to verify from being read further.
 * 3. `email` equals the scheduler service account, and `email_verified`. This
 *    is the authorisation step: a valid Google token proves *someone*, and any
 *    GCP customer can mint one. Without this check the endpoint is open to the
 *    whole of Google Cloud.
 *
 * ── Fails closed, with no bypass ─────────────────────────────────
 *
 * Missing configuration answers 503, never "allow". There is deliberately no
 * development escape hatch: the same reasoning UC-1.0e applied to the
 * `Bearer dev-<uid>` bypass applies here, and a bypass on the endpoint that
 * runs everyone's jobs would be worse. #143 sketched a dev header the route
 * would accept whenever `K_SERVICE` is unset; that is still a credential path
 * anyone reading this repository can enable, so there is none. Local work
 * calls the runner in-process instead of going through the route.
 *
 * Nothing here logs or returns the token.
 */

/** Set on the service so it knows which caller to accept. */
export const SCHEDULER_SA_ENV_VAR = 'MAYBESITTER_SCHEDULER_SA_EMAIL';
/** The service's own URL, which is what the OIDC token is minted for. */
export const AUDIENCE_ENV_VAR = 'MAYBESITTER_INTERNAL_AUDIENCE';

const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

export type SchedulerAuthCode =
  | 'not_configured'
  | 'missing_token'
  | 'invalid_token'
  | 'wrong_audience'
  | 'wrong_caller';

export interface SchedulerAuthConfig {
  serviceAccountEmail: string;
  audience: string;
}

/** The claims this module reads. Google sends more; none of it is needed. */
export interface OidcPayload {
  email?: string | undefined;
  email_verified?: boolean | undefined;
  aud?: string | undefined;
  iss?: string | undefined;
}

/** Verifying a token against an audience, injectable so tests stay offline. */
export type OidcVerify = (idToken: string, audience: string) => Promise<OidcPayload>;

export type SchedulerAuthResult =
  | { ok: true; caller: string }
  | { ok: false; code: SchedulerAuthCode; status: number };

/** Just enough of `Request` to authorise it, so tests need no polyfill. */
export interface HeaderBearing {
  headers: { get(name: string): string | null };
}

/**
 * Both settings, or null when either is missing.
 *
 * Null is a deployment mistake rather than a caller mistake, which is why it
 * becomes 503 below: answering 401 would suggest the caller should fix its
 * token, and the caller can do nothing about this.
 */
export function schedulerAuthConfig(env: NodeJS.ProcessEnv = process.env): SchedulerAuthConfig | null {
  const serviceAccountEmail = env[SCHEDULER_SA_ENV_VAR]?.trim();
  const audience = env[AUDIENCE_ENV_VAR]?.trim();
  if (!serviceAccountEmail || !audience) return null;
  return { serviceAccountEmail, audience };
}

/** The token out of `Authorization: Bearer <jwt>`, or null. */
export function bearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer[ \t]+(\S+)$/.exec(header.trim());
  return match?.[1] ?? null;
}

let cachedVerify: OidcVerify | null = null;

/**
 * The real verifier.
 *
 * `google-auth-library` is imported lazily so that unit tests — which inject
 * their own verifier — never load it, and so a process that has no internal
 * routes never pays for it. The client caches Google's signing keys itself.
 */
async function googleVerify(idToken: string, audience: string): Promise<OidcPayload> {
  if (!cachedVerify) {
    const { OAuth2Client } = await import('google-auth-library');
    const client = new OAuth2Client();
    cachedVerify = async (token: string, aud: string) => {
      const ticket = await client.verifyIdToken({ idToken: token, audience: aud });
      return (ticket.getPayload() ?? {}) as OidcPayload;
    };
  }
  return cachedVerify(idToken, audience);
}

/** Drops the memoised client. For tests that swap the environment. */
export function resetSchedulerOidcForTests(): void {
  cachedVerify = null;
}

/**
 * Whether this request may run internal jobs.
 *
 * Every refusal is explicit; there is no path that returns ok on an error.
 */
export async function authorizeSchedulerRequest(
  request: HeaderBearing,
  options: { env?: NodeJS.ProcessEnv; verify?: OidcVerify } = {},
): Promise<SchedulerAuthResult> {
  const config = schedulerAuthConfig(options.env ?? process.env);
  if (!config) return { ok: false, code: 'not_configured', status: 503 };

  const token = bearerToken(request.headers.get('authorization'));
  if (!token) return { ok: false, code: 'missing_token', status: 401 };

  let payload: OidcPayload;
  try {
    payload = await (options.verify ?? googleVerify)(token, config.audience);
  } catch {
    // Includes expiry, a bad signature, and an audience `verifyIdToken`
    // rejected. The reason is not passed on: it would tell an unauthenticated
    // caller which part of its forgery to fix.
    return { ok: false, code: 'invalid_token', status: 401 };
  }

  if (!payload.iss || !GOOGLE_ISSUERS.has(payload.iss)) {
    return { ok: false, code: 'invalid_token', status: 401 };
  }
  // `verifyIdToken` already enforced this. Checked again because it is the
  // claim that keeps staging tokens out of production, and a future change to
  // how the client is constructed should not be able to quietly drop it.
  if (payload.aud !== config.audience) {
    return { ok: false, code: 'wrong_audience', status: 401 };
  }
  if (payload.email_verified !== true || payload.email !== config.serviceAccountEmail) {
    // Authenticated by Google, but not the caller these routes are for: any
    // GCP customer can mint a valid Google-signed token. Still 401, not 403 —
    // see `schedulerAuthErrorResponse` for why the status must not differ.
    return { ok: false, code: 'wrong_caller', status: 401 };
  }

  return { ok: true, caller: payload.email };
}

/**
 * The refusal, as the route answers it.
 *
 * Every authentication failure gets the same `401 {"error":"unauthorized"}`,
 * whatever the reason. Distinct answers would be an oracle: a separate
 * `wrong_caller` (or a 403) tells a prober that its token *verified* and only
 * the caller was wrong — exactly the step it needs to know it has passed. The
 * specific reason goes to the log, where the operator reads it; the token
 * never goes anywhere.
 *
 * Missing configuration stays a distinct 503. It is the deployment's fault
 * rather than the caller's, and the caller can do nothing about it.
 */
export function schedulerAuthErrorResponse(result: { code: SchedulerAuthCode; status: number }): Response {
  console.warn(`[internal/jobs] refused: ${result.code}`);
  if (result.code === 'not_configured') {
    return Response.json({ error: 'not_configured' }, { status: 503 });
  }
  return Response.json({ error: 'unauthorized' }, { status: 401 });
}
