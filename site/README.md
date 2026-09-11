# `site/` — the MaybeSitter public website

Plain HTML and CSS for the public site required by issue #137 (OWNER-A1): a homepage, a
privacy policy and terms of use, in English, Arabic and Hebrew.

No framework, no build step, no JavaScript, no cookies, no trackers, no third-party fonts
and no CDN requests. One shared stylesheet, `styles.css`, with a system font stack chosen
to cover Latin, Arabic and Hebrew. The Arabic and Hebrew pages carry `lang` and `dir="rtl"`
on `<html>`; the English pages carry `dir="ltr"`.

## What is here

```
site/
  styles.css                     shared stylesheet
  index.html                     English root, links to /ar/ and /he/
  en/index.html  en/privacy.html  en/terms.html
  ar/index.html  ar/privacy.html  ar/terms.html
  he/index.html  he/privacy.html  he/terms.html
  check-links.sh                 verification script (HTTP and --local modes)
  firebase-hosting.snippet.json  the hosting block to merge into firebase.json
  PLACEHOLDERS.md                the 5 tokens you must fill in before publishing
  README.md                      this file
```

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

`firebase.json` is owned by UC-1.0a (#140) and is deliberately **not** created here. Merge
the `hosting` block from `firebase-hosting.snippet.json` into it — if the file already has
other top-level keys (`firestore`, `functions`, …), add `hosting` alongside them rather
than overwriting the file.

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
