# Early access launch

## Preview and verification

From the repository root, run `npm run preview:site`, then visit http://127.0.0.1:8788/.
Unlike a static file server, this runs the real registration handler with a durable,
local-only SQLite store at `.maybesitter/early-access-preview/registrations.sqlite`.
This folder is ignored by Git. It is not the production signup database.

Run `npm run test:early-access`, `npm run typecheck`, and `npm run build`.
The API tests cover validation, concurrent duplicates, original attribution,
storage failure, metric failure, origin checks, honeypot, request size, rate limits,
and the narrow production middleware allowlist.

## Production architecture

Firebase Hosting serves `site/`. Its two precise `/api/early-access` rewrites route to
the existing `maybesitter-api` Cloud Run service in `europe-west1`.
Deploy the backend before the hosting update. The Next.js root remains the frozen
legacy interface; the marketing page is intentionally separate.

Set `MAYBESITTER_SITE_ORIGINS` on the backend to the exact HTTPS origins allowed to
register, comma-separated and without trailing slashes. Set the existing storage
backend configuration to Firestore. The API fails closed if durable Firestore is
unavailable; it never reports a signup saved into an ephemeral memory store.

Server-only collections:

- `earlyAccessRegistrations`: normalized email hash as document ID; name, email,
  device, optional phone, source, and registeredAt. Duplicate submission never
  overwrites the original registration or reveals whether an address existed.
- `earlyAccessMetrics`: aggregate daily campaign counts, no visitor identifier.
- `earlyAccessRateLimits`: atomic global hourly counters, with an `expiresAt` TTL
  field (enable Firestore TTL for automatic cleanup if desired).

No client Firestore permissions need expanding. Keep these collections inaccessible
to client SDKs. Restrict staff access to the people managing invitations. Registration
does not automatically send email; the owner must operate the invitation process.
The global abuse cap is a baseline, not a substitute for edge abuse protection on a
high-traffic public campaign. Monitor rejection counts and costs before scaling.

`?source=instagram` (or another 1–64 character alphanumeric, dash, underscore slug)
is stored with the signup. No UTM fields or arbitrary URLs are collected. Browser
events honor Do Not Track and Global Privacy Control; server successful-registration
counts are operational aggregates. No cookies or advertising trackers are added.

## Motion and assets

GSAP 3.15.0 and ScrollTrigger come from the supplied gsap-public package. Lenis
1.3.26 comes from its official distribution. They are served locally, with GSAP
and Lenis sharing one animation clock. Touch scrolling stays native. Reduced-motion
preferences disable motion and smooth scrolling; core controls do not depend on them.

Product images are actual English-language iOS simulator captures of the app, with example content.
Outfit and the existing brand mark are reused. The product gallery swaps among
Today, Calendar, and First Move. No invented screens or integration claims were added.

Spline was inspected but is not embedded: the connected 3D tools expose authoring,
not a deployable scene export. Supply an approved public `.splinecode` scene URL to
complete that integration. Do not use an editor session URL as a production asset.

## Public launch configuration

1. The confirmed launch origin is `https://maybesitter-app.web.app` and the owner-provided
   contact/privacy email is `anasakkari04@gmail.com`.
2. Existing multilingual application legal drafts are excluded from Hosting. The
   release uses the separate `early-access-privacy.html` notice scoped to registrations.
3. Canonical, og:url and absolute social-image metadata use the confirmed origin.
4. Production uses Firestore `(default)`, the existing `maybesitter-run` identity,
   and exact allowed origins `https://maybesitter-app.web.app` and
   `https://maybesitter-app.firebaseapp.com`. Staff use Firebase Console.
5. The backend was deployed before Hosting and the controlled public smoke test passed.
   Invitations and automatic email notifications are not configured; operators manage
   invitations separately. The published contact address does not enable notifications.

## Deployment verification (12 September 2026)

- Public URL: https://maybesitter-app.web.app
- Cloud Run revision: `maybesitter-api-00001-gqr`; readiness returned `ready: true`.
- Image digest: `sha256:bedb6c459f97eb89ef09fd925aa6daed8ce01a7fee088f7c25fe34367dff2c6f`.
- Cloud Build: `d1613a14-45e1-4c33-bf9e-2051382c8432`.
- Manual owner-requested deployment from the current checkout; no Git commit or push
  was performed. Use `.gcloudignore.launch` for uploads: unanchored Docker exclusions
  interpreted as Git exclusions accidentally omit `lib/services/mobile`.
- `node scripts/check-launch-live.mjs` passed: page, English screenshots, privacy,
  actual Firestore persistence, duplicate preservation, validation, origin rejection,
  and denial of anonymous reads. The unique smoke-test registration was removed;
  customer records were not touched. Test aggregate metrics retain source `qa-deploy`.
- Existing staging service was not redeployed. No DNS change, domain purchase,
  or invitation email was performed. This release does not activate scheduled mobile jobs.

View signups in Firebase Console → MaybeSitter → Firestore Database → `(default)` →
`earlyAccessRegistrations`. Document IDs are email hashes; the fields contain the
submitted name, email, device, optional phone, source and registration timestamp.

## Local QA (2026-09-12)

- 10/10 focused API and middleware tests pass; TypeScript and production build pass.
- Browser required-field validation and product gallery tested.
- Offline submission preserved entries; reconnect/retry showed persisted success.
- Privacy dialog opens and closes with Escape.
- Desktop and narrow phone layouts inspected; decorative horizontal overflow fixed.
- Preview test registrations use reserved `example.com` addresses only.
