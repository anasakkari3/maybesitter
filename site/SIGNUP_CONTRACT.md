# Tester sign-up: the endpoint the landing pages need

The published landing pages (`/`, `/ar`) post the "Coming soon" name/email dialog to
`POST /api/early-access`. Firebase Hosting rewrites that path to the Cloud Run
service `maybesitter-api` in `europe-west1` (`firebase.json`, `hosting.rewrites`).

The endpoint is implemented in `lib/earlyAccess/service.ts`. Deploy its `landing_interest`
shape before deploying the new Hosting page; otherwise the modal gets a 422 and saves nothing.
The Hebrew landing and legal pages remain drafts excluded from Hosting until native review.

## Current name/email dialog (2026-09-30)

The only visible fields are name (1–80 characters) and email (≤254 characters). Clicking
the iPhone or Android card supplies `device`; no store pre-order is claimed or created.
The first-party page sends this JSON (≤4 KiB, same origin):

```json
{"kind":"landing_interest","name":"Lina Haddad","email":"lina@example.com","device":"iphone","pageLanguage":"ar","source":"direct","v":"none","website":""}
```

`name` is trimmed, whitespace-collapsed, rejected if empty, over 80 characters or
containing controls, and stored only for this shape. `email` is normalized and keyed by
its hash as before. `language` in the stored row is the page language, **not** an
expressed preference; `knowsFounder` and `phone` are null, `whatsappOptIn` is false.
The response is identical for a new or already-listed email; first registration wins.
No email body, visit, cookie, IP address or device identifier is collected.

The previous form shape below remains accepted for cached pages, and the stranded
English-only launch page's legacy shape remains accepted until its cache ages out.

## What exists today, and why it is not enough

A version of this endpoint was deployed around 2026-09-13 from a local commit that never
reached `main`. It survives only in the tag
`archive/2026-09/stranded/local-main-launch-site` (`ba7f74f0`):
`lib/earlyAccess/service.ts`, `src/app/api/early-access/route.ts`,
`src/app/api/early-access/events/route.ts` and a middleware allow-list line. As of
2026-09-23 it is still answering on production (`GET /api/early-access` returns 405), so
the live Cloud Run service is running code that `main` does not contain. **The next
production deploy from `main` will remove it.**

It does not fit these pages:

| Field | Stranded endpoint | These pages send |
|---|---|---|
| `name` | **required** (422 without it) | not collected. We don't ask for a name |
| `email`, `device`, `source` | stored | sent |
| `phone` | optional, stored whenever given | sent **only** when `whatsappOptIn` is true, otherwise `null` |
| `language`, `knowsFounder`, `whatsappOptIn`, `v`, `pageLanguage` | silently dropped | sent. `v` and `knowsFounder` are what the message test is read from |
| page-view metrics (`/events`) | counted | **not sent**. The site has no analytics |

## Previous form request (cached pages)

`Content-Type: application/json`, body at most 4 KiB, same-origin (the rewrite makes the
site and the endpoint one origin).

```json
{
  "email": "string, required, trimmed, lower-cased, ≤254",
  "device": "iphone | android",
  "language": "ar | he | en",
  "knowsFounder": "yes | no",
  "whatsappOptIn": true,
  "phone": "string | null — must be null unless whatsappOptIn is true",
  "pageLanguage": "ar | he | en",
  "source": "[a-z0-9_-]{1,64}, or \"direct\"",
  "v": "a | b | none",
  "website": "honeypot — non-empty means a bot: answer 200 and store nothing"
}
```

## Required behaviour

1. **Store** one record per email in Firestore in `europe-west1`. Keep the date, `source`,
   `v`, `language`, `pageLanguage`, `device`, `knowsFounder`, optional `name` on the new
   shape, and `phone` only with `whatsappOptIn: true`. The privacy policy's "Early-access sign-up" section
   (`{en,ar,he}/privacy.html#early-access`) promises exactly this list and this region.
   If you change either, change the policy in all three languages in the same PR.
2. **Never treat a phone number as marketing consent.** `whatsappOptIn` is consent to
   be messaged about the test, and nothing else.
3. **Answer identically** for a new and an existing email (no enumeration). 200 on
   success, 422 with field names on invalid input, 429 when rate-limited, 503 if the
   store is down. Every error body is `{error: <sentence>, code: <machine code>}`
   (see the legacy section for why `error` is a sentence). The page maps 422 to "check the fields" and anything else to "try
   again later".
4. **No IP addresses, cookies or visitor identifiers** are stored. Rate-limit globally,
   like the stranded version did.
5. **Reading the message test** needs only aggregate counts: sign-ups by `v`, by `source`,
   and by `knowsFounder = "no"`. The denominators are the link taps each platform reports.
   The site never counts visitors.

## Legacy shape: the stranded launch page (until main's `site/` is on Hosting)

Production Hosting still serves the stranded launch page (`ba7f74f0`), which posts
`{name, email, device, phone, website, source}` (all strings, no `v`) and pings
`POST /api/early-access/events` with `{event, source}`. So a production deploy of main
does not break it, `lib/earlyAccess/service.ts` accepts that body as a **versioned legacy
shape**:

- **Detection.** A body with none of `v`, `language`, `pageLanguage`, `knowsFounder`,
  `whatsappOptIn` is legacy. Any one of them present means the current contract above,
  so a current-site bug that drops `v` is a 422, and an opt-in cannot be smuggled in
  through the legacy path.
- **Stored.** `email`, `device`, `source`, the date, `language: "en"` and
  `pageLanguage: "en"` (that page is English-only), `knowsFounder: null` (never asked),
  `whatsappOptIn: false`, `phone: null`, `v: "legacy"`. A strict subset of the list the
  privacy policy promises.
- **Dropped.** The stranded page's `name` is not migrated into the new named shape;
  only the new `landing_interest` modal stores a name. Its `phone` is dropped because
  the policy keeps a number only with the WhatsApp opt-in, the legacy page never asked
  for it, and treating a typed number as that consent would invent it.
- **Honeypot.** `website` is the same hidden field on both pages and is handled
  identically: non-empty → 200 `{ok:true}`, nothing written, not even the rate window.
- **Answers.** 200 `{ok:true}` as before. Every error answer, for both shapes and both
  routes, is `{error: <an English sentence>, code: <machine code>}` (plus `fields` on
  422). The legacy page prints `error` verbatim, including for the 403/405/413/415/400
  answers given before any body is read, so `error` is always the stranded endpoint's
  own sentence; the current site reads only the status. On 422 the current site gets
  `fields` as a list of names, the legacy page as `{field: message}`.
- **`/events`.** `POST` only, same origin check, **204 with no body read and nothing
  stored**. The current site sends no page views and main keeps no page-view store.

### Known consequences for the owner

- **Old stranded rows.** `earlyAccessRegistrations` already holds rows the stranded
  service wrote, with `name` and `phone` (same document id, so first-wins keeps them).
  The current privacy text distinguishes the new name/email modal from the legacy form
  and keeps a number only with the opt-in.
  Either strip `name`/`phone` where `whatsappOptIn !== true` once, or keep them under the
  stranded notice that disclosed both; they are deletable on request like every other
  row. `earlyAccessMetrics` (day/source/event counts, no personal data) stops growing.
- **`language` on a legacy row is the page's language**, not a preference the visitor
  gave. Exclude `v: "legacy"` from any count by `language` or `knowsFounder`, and count
  the message test on `v` in `a | b | none`.
- **The legacy page promises more than is kept.** Its form and dialog mention first name,
  phone and page-visit counts; none is stored. Collecting less is safe, but anyone who
  typed a phone number expecting to be called about access will not be.

Remove the legacy shape and the `/events` route once main's `site/` has been on Hosting
long enough that no cached copy of the old page is still posting.

## Owner

`OWNER_UNRESOLVED` → backend. Porting the stranded service is the smallest path, with
`name` made optional or removed and the new fields added. It also has to join the route
guards that enumerate every API route.
