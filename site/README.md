# `site/` — the MaybeSitter public website

Plain HTML and CSS for the public site: one English landing page (`/`) and its Arabic
translation (`/ar`), plus the privacy, terms and account-deletion pages in both
languages (issues #137, #179). Hebrew drafts remain in source but are excluded from
Firebase Hosting by `firebase.json` until native review.

No framework and no build step. No cookies, no localStorage, no trackers, no analytics, no
third-party fonts and no CDN requests. The only script is the first-party `landing.js`, on
the two published landing pages. It picks the message-test headline and submits the name/email dialog
(see "Message test" below). The legal pages have no script at all. The Arabic and Hebrew
pages carry `lang` and `dir="rtl"` on `<html>`; the English pages carry `dir="ltr"`.

Every public sentence must pass `docs/marketing/CLAIMS_POLICY.md`, and `check-links.sh
--local` fails on the phrases it forbids. The approved positioning source is the
owner-approved Product Marketing Context (`.agents/product-marketing.md` at the project
root).

## What is here

```
site/
  index.html  ar/index.html      English and Arabic landing pages
  he/index.html                  unpublished Hebrew draft
  {en,ar,he}/privacy.html        privacy policy (Hebrew unpublished)
  {en,ar,he}/terms.html          terms of use (Hebrew unpublished)
  {en,ar,he}/delete-account.html account and data deletion (Hebrew unpublished)
  styles.css                     landing-page compatibility stylesheet
  legal.css                      published legal-page stylesheet
  landing.css  landing.js        landing pages only
  store-ios.svg  store-android.svg  custom "coming to" cards; not official store badges
  robots.txt  sitemap.xml        crawl hygiene (no programmatic SEO)
  check-links.sh                 verification script (HTTP and --local modes, claims scan)
  firebase-hosting.snippet.json  mirror of the hosting block in firebase.json
  SIGNUP_CONTRACT.md             public sign-up endpoint and compatibility contract
  PLACEHOLDERS.md                the 5 tokens you must fill in before publishing
  README.md                      this file
```

`/en` redirects to `/`, so there is one English landing page. `/privacy`, `/terms` and
`/delete-account` redirect to the English pages.

## What was live before the 2026-09-30 refresh

`https://maybesitter-app.web.app` did **not** serve this folder. It served an English-only
early-access page deployed around 2026-09-13 from a local commit that never reached
`main`. That commit survives only as the tag `archive/2026-09/stranded/local-main-launch-site`
(`ba7f74f0`). The live page:

- markets "your personal AI chief of staff", goals and "$5,000 in early funding", which the
  claims policy forbids;
- shows the owner's **personal Gmail address** in its privacy notice;
- counts page views and clicks through `/api/early-access/events`;
- posts sign-ups to an older Cloud Run request shape (see `SIGNUP_CONTRACT.md`).

This folder is the canonical source. The owner authorized publication of the
English and Arabic legal and account-deletion pages on 2026-09-25. The Hebrew
documents remain unpublished pending native linguistic review.

## Message test

Two positioning lines are being tested, and neither has won:

- `?v=a`: "No overdue pile."
- `?v=b`: "Say it once. It lands in your day."

With no `v`, the page shows the interim line, "Your commitments, without the pressure."
Assignment happens **through the link a person is sent**. Each post or
message carries one arm's link and a `?source=` code. The page never assigns, stores or
counts visitors. `landing.js` swaps the headline, carries `v` and `source` onto the
language links, and sends them with the sign-up. Sign-ups by arm are the numerator; the
link taps each platform reports are the denominator.

## Deploy checklist (owner)

Before a full-site replacement, complete every item below. A scoped legal-page
deployment may preserve the existing landing page and publish only approved files.

1. **Sign-up endpoint:** deploy the `landing_interest` shape from `main` to production,
   and verify it before replacing Hosting. Without it the new dialog gets 422.
2. **Domain** bought and connected (#137); `{{DOMAIN}}` replaced.
3. **Role aliases** `support@` and `privacy@` created; `{{SUPPORT_EMAIL}}` and
   `{{PRIVACY_EMAIL}}` replaced. No personal address, ever.
4. `{{LEGAL_NAME}}` and the effective date decided for every published locale.
5. **Hebrew native review:** `he/**` is excluded from Hosting. Do not remove that ignore
   or publish the Hebrew sitemap entries until #335 is complete.
6. `./check-links.sh --local` passes and no placeholder appears in a published file.

Deploying replaces the old live page, which also removes its unapproved claims.

## Before you publish: fill in the placeholders

The domain, operator name, contact addresses and English/Arabic effective date
are resolved. `{{EFFECTIVE_DATE}}` remains only in the unpublished Hebrew legal
documents. See [PLACEHOLDERS.md](PLACEHOLDERS.md).

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

## Custom domain and DNS

The owner purchased **maybesitter.com** (Cloudflare), and supplied the localized
operator names. Support/privacy role addresses are free aliases on the existing
Google Workspace mailbox; recipient-level delivery logs verified both on
2026-09-25. Preserve the existing Google Workspace MX and SPF records; do not
replace them with Cloudflare Email Routing. See [PLACEHOLDERS.md](PLACEHOLDERS.md).

The default Firebase site already serves an older early-access release. A scoped
deployment must preserve that landing page, its early-access form and both
early-access API routes. The owner approved publication of the English and Arabic
legal documents on 2026-09-25. Do not publish the Hebrew drafts before native
linguistic approval.

After the final site and legal text are approved:

1. Firebase Hosting → Add custom domain → `maybesitter.com`.
2. Copy the exact verification and serving records shown by Firebase to Cloudflare,
   preserving all mail records; follow Firebase's current certificate instructions.
3. Wait for domain verification and certificate issuance.
4. Run public verification against `https://maybesitter.com`; verify the six
   approved English/Arabic legal and deletion URLs, redirects, Arabic RTL, HTTP,
   and TLS. Verify all nine after Hebrew publication.

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
- The English and Arabic legal text is owner-approved v1.1, effective 2026-09-25.
  The Hebrew legal text remains a draft pending proficient native review.
  UC-4.3b (#179) owns `/{en,ar,he}/delete-account`, which the privacy pages already link to.
- Any new data flow added to the product must be reflected here. The policy is the public
  promise every later issue has to keep.

## Not done here

Native Hebrew linguistic review remains outstanding. The repository does not
claim that owner approval is legal advice.
