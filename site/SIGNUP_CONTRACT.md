# Tester sign-up: the endpoint the landing pages need

The landing pages (`/`, `/ar`, `/he`) post the "Join the test" form to
`POST /api/early-access`. Firebase Hosting rewrites that path to the Cloud Run
service `maybesitter-api` in `europe-west1` (`firebase.json`, `hosting.rewrites`).

**There is no implementation of this endpoint on `main`.** Until one lands, the form
shows its error message ("We couldn't save your details just now…") and saves nothing.
Do not deploy the site while that is true. This file is the contract for the backend
change; the marketing lane does not own backend code and did not write it.

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

## Request

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
   `v`, `language`, `pageLanguage`, `device`, `knowsFounder`, and `phone` only with
   `whatsappOptIn: true`. The privacy policy's "Early-access sign-up" section
   (`{en,ar,he}/privacy.html#early-access`) promises exactly this list and this region.
   If you change either, change the policy in all three languages in the same PR.
2. **Never treat a phone number as marketing consent.** `whatsappOptIn` is consent to
   be messaged about the test, and nothing else.
3. **Answer identically** for a new and an existing email (no enumeration). 200 on
   success, 422 with field names on invalid input, 429 when rate-limited, 503 if the
   store is down. The page maps 422 to "check the fields" and anything else to "try
   again later".
4. **No IP addresses, cookies or visitor identifiers** are stored. Rate-limit globally,
   like the stranded version did.
5. **Reading the message test** needs only aggregate counts: sign-ups by `v`, by `source`,
   and by `knowsFounder = "no"`. The denominators are the link taps each platform reports.
   The site never counts visitors.

## Owner

`OWNER_UNRESOLVED` → backend. Porting the stranded service is the smallest path, with
`name` made optional or removed and the new fields added. It also has to join the route
guards that enumerate every API route.
