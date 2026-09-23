# `site/` — the MaybeSitter public website

Plain HTML and CSS for the public site: three landing pages (`/` in English, `/ar`, `/he`)
and a privacy policy, terms of use and account-deletion page in each language (issues
#137, #179).

No framework and no build step. No cookies, no localStorage, no trackers, no analytics, no
third-party fonts and no CDN requests. The only script is the first-party `landing.js`, on
the three landing pages. It picks the message-test headline and submits the sign-up form
(see "Message test" below). The legal pages have no script at all. The Arabic and Hebrew
pages carry `lang` and `dir="rtl"` on `<html>`; the English pages carry `dir="ltr"`.

Every public sentence must pass `docs/marketing/CLAIMS_POLICY.md`, and `check-links.sh
--local` fails on the phrases it forbids. The approved positioning source is the
owner-approved Product Marketing Context (`.agents/product-marketing.md` at the project
root).

## What is here

```
site/
  index.html                     English landing page (also x-default)
  ar/index.html  he/index.html   Arabic and Hebrew landing pages
  {en,ar,he}/privacy.html        privacy policy
  {en,ar,he}/terms.html          terms of use
  {en,ar,he}/delete-account.html account and data deletion (#179)
  styles.css                     shared stylesheet
  landing.css  landing.js        landing pages only
  robots.txt  sitemap.xml        crawl hygiene (no programmatic SEO)
  check-links.sh                 verification script (HTTP and --local modes, claims scan)
  firebase-hosting.snippet.json  mirror of the hosting block in firebase.json
  SIGNUP_CONTRACT.md             the endpoint the sign-up form needs (not on main yet)
  PLACEHOLDERS.md                the 5 tokens you must fill in before publishing
  README.md                      this file
```

`/en` redirects to `/`, so there is one English landing page. `/privacy`, `/terms` and
`/delete-account` redirect to the English pages.

## What is live today (2026-09-23), and why this is not it yet

`https://maybesitter-app.web.app` does **not** serve this folder. It serves an English-only
early-access page deployed around 2026-09-13 from a local commit that never reached
`main`. That commit survives only as the tag `archive/2026-09/stranded/local-main-launch-site`
(`ba7f74f0`). The live page:

- markets "your personal AI chief of staff", goals and "$5,000 in early funding", which the
  claims policy forbids;
- shows the owner's **personal Gmail address** in its privacy notice;
- counts page views and clicks through `/api/early-access/events`;
- posts sign-ups to a Cloud Run endpoint that is not on `main` (see `SIGNUP_CONTRACT.md`).

This folder is the canonical replacement. Deploying it is an owner action, blocked on the
checklist below.

## Message test

Two positioning lines are being tested, and neither has won:

- `?v=a`: "No overdue pile."
- `?v=b`: "Say it once. It lands in your day."

With no `v`, the page shows the interim line, "A calm planner and reminders app, in Arabic,
Hebrew and English." Assignment happens **through the link a person is sent**. Each post or
message carries one arm's link and a `?source=` code. The page never assigns, stores or
counts visitors. `landing.js` swaps the headline, carries `v` and `source` onto the
language links, and sends them with the sign-up. Sign-ups by arm are the numerator; the
link taps each platform reports are the denominator.

## Deploy checklist (owner)

Do not deploy while any item is open:

1. **Sign-up endpoint** on `main` per `SIGNUP_CONTRACT.md` (backend). Without it the form
   cannot save anything.
2. **Domain** bought and connected (#137); `{{DOMAIN}}` replaced.
3. **Role aliases** `support@` and `privacy@` created; `{{SUPPORT_EMAIL}}` and
   `{{PRIVACY_EMAIL}}` replaced. No personal address, ever.
4. `{{LEGAL_NAME}}` and `{{EFFECTIVE_DATE}}` decided.
5. **Hebrew native review** of `he/index.html` and the new Hebrew privacy paragraphs (#335).
   The landing page carries a `NATIVE-REVIEW-REQUIRED` comment until then.
6. `./check-links.sh --local` passes and `git grep '{{' -- site/` is empty.

Deploying replaces the live page, which also removes the personal address from it.

## Before you publish: fill in the placeholders

The pages contain five literal tokens — `{{DOMAIN}}`, `{{LEGAL_NAME}}`,
`{{SUPPORT_EMAIL}}`, `{{PRIVACY_EMAIL}}` and `{{EFFECTIVE_DATE}}`. **The site is not
publishable until they are replaced.** See [PLACEHOLDERS.md](PLACEHOLDERS.md) for what each
one means, where it appears, and a one-liner that replaces them all.

Check none are left:

```bash
git grep -n '{{' -- site/
```

## Preview locally

```bash
cd site
python3 -m http.server 8788
# then open http://localhost:8788/
```

Then verify it:

```bash
./check-links.sh http://localhost:8788     # HTTP mode
./check-links.sh --local                   # filesystem mode, no server (CI)
```

### Local preview is not identical to production

`cleanUrls`, `trailingSlash` and the `redirects` are **Firebase Hosting features**. A plain
static file server does not implement any of them. Locally this means:

- pages are at `/en/privacy.html`, not `/en/privacy`;
- `/privacy` and `/terms` do not redirect — they simply 404.

`check-links.sh` handles this honestly rather than pretending: it probes the server once,
appends `.html` when extensionless URLs do not resolve, and reports the two redirect checks
as **SKIPPED** (never as passed), verifying instead that the 301 rules are present in
`firebase-hosting.snippet.json`. Run the script against the real HTTPS domain after deploy
to exercise the redirects for real.

To preview with real hosting behaviour, use the Firebase emulator once `firebase.json`
exists: `firebase emulators:start --only hosting`.

## Deploy (owner)

The `hosting` block in the root `firebase.json` is the source of truth.
`firebase-hosting.snippet.json` mirrors it minus `ignore`, and `check-links.sh` reads the
redirect rules from it. Change both together. The other top-level keys in `firebase.json`
(`firestore`, `emulators`) belong to infra (#140) and are not touched here.

```bash
# from the repo root, with firebase.json in place
firebase use maybesitter-app
firebase deploy --only hosting
```

That publishes to the default `*.web.app` / `*.firebaseapp.com` URL. Verify there first:

```bash
site/check-links.sh https://maybesitter-app.web.app
```

## Custom domain and DNS (owner)

1. Buy the domain at **Cloudflare Registrar**. Turn on 2FA, auto-renew and WHOIS privacy.
   The `.app` TLD is HSTS-preloaded, so it is HTTPS-only by design.
2. Cloudflare → **Email Routing**: create `support@<domain>` and `privacy@<domain>`,
   both forwarding to your inbox. Send a test message to each and confirm delivery.
3. Firebase console → **Hosting** → **Add custom domain** → enter `<domain>`.
4. Create the A and TXT records Firebase shows you in Cloudflare DNS, with the orange
   proxy **turned off** (grey cloud). Firebase cannot issue the TLS certificate through
   Cloudflare's proxy.
5. Wait for propagation and for the certificate to be issued. This is usually minutes but
   can take up to 24 hours.
6. Re-run the check against the real domain, which also exercises the redirects:

```bash
site/check-links.sh https://<domain>
```

## Search Console (owner)

Google's OAuth brand verification (UC-1.8, #152) requires the domain to be verified by an
**Owner or Editor of the `maybesitter-app` project** — so sign in with that Google account,
not a personal one.

1. <https://search.google.com/search-console> → **Add property** → choose **Domain**
   (not "URL prefix").
2. Copy the `google-site-verification=…` TXT value.
3. Add it as a TXT record at the apex in Cloudflare DNS.
4. Click **Verify**. If it fails, wait for DNS propagation and retry.

Then comment on issue #137 with the final domain and `Search Console: verified, <date>`.
Include no email addresses, IDs or screenshots containing personal data.

## Editing the content later

- The three languages are **parallel documents**: every `<h2>` in `en/privacy.html` has a
  counterpart in `ar/privacy.html` and `he/privacy.html`. If you add, remove or rename a
  section, do it in all three, or the store and OAuth reviews will flag the mismatch.
- The Google Limited Use sentence in the Calendars section is quoted verbatim in English on
  all three pages because Google's review requires that exact wording. Do not translate or
  reword it; the ar/he pages carry a clearly-marked unofficial translation beside it.
- This is **v1.0**. UC-4.2 (#177) revises the text to v1.1 and adds the in-app links.
  UC-4.3b (#179) owns `/{en,ar,he}/delete-account`, which the privacy pages already link to.
- Any new data flow added to the product must be reflected here. The policy is the public
  promise every later issue has to keep.

## Not done here

Legal review. The owner may choose to have a lawyer review the text before publishing;
this draft is not legal advice.
