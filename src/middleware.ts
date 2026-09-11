/**
 * What is reachable in production, decided before a route runs (UC-1.0e, #144).
 *
 * ── Why a middleware and not fifteen edits ───────────────────────
 *
 * This repository still carries a web-era surface: `/api/state`,
 * `/api/pilot/trust`, `/api/next-step`, `/api/calendar.ics` and friends. Those
 * routes take a participant id straight out of a query string or a JSON body
 * and several of them read file-backed stores that no longer have a durable
 * home. Auditing each one into an authenticated route is UC-1.0c (#142) and
 * later work; making them unreachable in production is one rule, here.
 *
 * ── `K_SERVICE`, not a feature flag ──────────────────────────────
 *
 * Cloud Run sets `K_SERVICE` on every revision, so "are we in production" is
 * detected rather than configured. A deployment cannot forget to turn this on,
 * and local development — where these routes are still useful — is unaffected
 * because nothing sets it. This is the same signal `lib/storage` already uses
 * to refuse in-memory storage in production.
 *
 * ── 404 rather than 403 ──────────────────────────────────────────
 *
 * A 403 would confirm the route exists. There is nothing at these paths in
 * production, and that is exactly what the answer says.
 *
 * ── Web types, not `next/server` ─────────────────────────────────
 *
 * A returned `Response` blocks the request and returning nothing continues
 * it, which is all this file needs — so it imports nothing. That keeps the
 * rule testable as a plain function in `node --test`, where a bare
 * `next/server` specifier does not resolve, rather than only inside a running
 * Next server. It also keeps the file inside what the Edge runtime provides:
 * `process.env`, `URL` and `Response`, and nothing else.
 *
 * ── Why there is no `runtime: 'nodejs'` here ─────────────────────
 *
 * UC-1.0e (#144) specified Node-runtime middleware on the understanding that
 * it is stable in Next 15.5. It is not, in 15.5.21: `experimental.nodeMiddleware`
 * is an unrecognised config key, and declaring `runtime: 'nodejs'` makes the
 * build **silently skip the middleware altogether** — an empty
 * `middleware-manifest.json` and no `ƒ Middleware` row, with no error. That
 * would have shipped this guard inert, which is worse than not having it,
 * because the legacy surface would be open while the code says it is closed.
 * `tests/auth/middleware.test.ts` covers the rule and the build output is
 * what confirms it is registered.
 */
export const config = {
  matcher: '/:path*',
};

/**
 * The only paths production serves.
 *
 * `/api/mobile/*` is the authenticated product surface, every route of which
 * calls `requireMobileUser`. `/api/health*` is unauthenticated on purpose:
 * Cloud Run's own probe reads it and it discloses nothing but a revision and a
 * commit. `/api/internal/*` is reserved for platform callers and has no route
 * yet; it is listed so that adding one does not also require editing this file
 * under time pressure.
 */
const PRODUCTION_PATHS: readonly RegExp[] = [
  /^\/api\/mobile(?:\/|$)/,
  /^\/api\/health/,
  /^\/api\/internal(?:\/|$)/,
];

/** True when production serves this path. Exported so a test can enumerate it. */
export function isProductionPath(pathname: string): boolean {
  return PRODUCTION_PATHS.some((pattern) => pattern.test(pathname));
}

/** True on Cloud Run, which sets `K_SERVICE` itself on every revision. */
export function isCloudRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.K_SERVICE);
}

/** `undefined` continues the request; a `Response` ends it. */
export function middleware(request: Request): Response | undefined {
  if (!isCloudRun()) return undefined;
  if (isProductionPath(new URL(request.url).pathname)) return undefined;
  return new Response(null, { status: 404 });
}
