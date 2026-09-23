# Placeholders the owner must fill in

Every token below is written **literally** in the site files so it is greppable and
obviously unfinished. Nothing here was invented by Claude — no domain, no legal name
and no email address appears anywhere in `site/`.

Find them all at any time:

```bash
git grep -nE '\{\{(DOMAIN|LEGAL_NAME|SUPPORT_EMAIL|PRIVACY_EMAIL|EFFECTIVE_DATE)\}\}' -- site/
```

Replace them all at once (macOS `sed`), after you have decided the real values:

```bash
cd site
grep -rl '{{' . --include='*.html' --include='*.md' --include='*.txt' --include='*.xml' | xargs sed -i '' \
  -e 's/{{DOMAIN}}/maybesitter.app/g' \
  -e 's/{{LEGAL_NAME}}/Your Full Legal Name/g' \
  -e 's/{{SUPPORT_EMAIL}}/support@maybesitter.app/g' \
  -e 's/{{PRIVACY_EMAIL}}/privacy@maybesitter.app/g' \
  -e 's/{{EFFECTIVE_DATE}}/2026-09-24/g'
```

Then re-run `./check-links.sh --local` and grep again to confirm no `{{` remains.

## The tokens

### `{{DOMAIN}}`

- **What to put there:** the bare domain you bought, with no scheme and no trailing
  slash — for example `maybesitter.app`. Issue #137 decides `maybesitter.app` first,
  then `maybesitter.co`, then `getmaybesitter.com`.
- **Where it appears:**
  - `en/privacy.html` — "Who we are", "Account deletion"
  - `ar/privacy.html` — «مين احنا»، «حذف الحساب»
  - `he/privacy.html` — "מי אנחנו", "מחיקת חשבון"
  - `en/terms.html` — intro, "Termination"
  - `ar/terms.html` — المقدّمة، «إنهاء الحساب»
  - `he/terms.html` — הפתיחה, "סיום ההתקשרות"
  - every page's `<head>` — the `canonical` and `hreflang` links, and on the three landing
    pages the `og:url` and the JSON-LD (`Organization`, `MobileApplication`, `FAQPage`)
  - `robots.txt` — the `Sitemap:` line
  - `sitemap.xml` — every `<loc>` and `hreflang` alternate
  - The canonical and hreflang URLs assume the domain serves the site at its root, with
    `trailingSlash: false` (so `/ar`, not `/ar/`).
- **Note:** the deletion URLs (`{{DOMAIN}}/en/delete-account` and the ar/he variants)
  point at the page owned by UC-4.3b (#179). That page does not exist yet. Ship it
  before, or at the same time as, the store listings that link to it.

### `{{LEGAL_NAME}}`

- **What to put there:** your full legal name as the individual developer and data
  controller. This is the name a user or a regulator would use to identify who is
  responsible. Issue #137 deliberately does not record it, so choose it at publish time.
- **Where it appears:**
  - the footer of all 12 pages (`© MaybeSitter — {{LEGAL_NAME}}`)
  - `{en,ar,he}/privacy.html` — the "Who we are" section
  - `{en,ar,he}/terms.html` — the intro, "Who we are" and "Contact" sections

### `{{SUPPORT_EMAIL}}`

- **What to put there:** the `support@<domain>` role alias you create in Cloudflare
  Email Routing (step 2 of the issue). Never your personal address.
- **Where it appears:**
  - `index.html`, `ar/index.html`, `he/index.html` — the footer ("Questions and feedback")
  - `{en,ar,he}/privacy.html` — "Who we are"
  - `{en,ar,he}/terms.html` — "Who we are", "Your account", "Acceptable use", "Contact"

### `{{PRIVACY_EMAIL}}`

- **What to put there:** the `privacy@<domain>` role alias. This is the address a data
  subject writes to, so it must actually be read.
- **Where it appears:**
  - `{en,ar,he}/privacy.html` — "Who we are", "Your rights", "Age", "Early-access sign-up"
  - `{en,ar,he}/terms.html` — "Contact"

### `{{EFFECTIVE_DATE}}`

- **What to put there:** the date the policy actually goes live, as `YYYY-MM-DD`. Use
  the publish date, not the drafting date, and do not backdate it.
- **Where it appears:**
  - `{en,ar,he}/privacy.html` — the header line and the closing "Changes" paragraph
  - `{en,ar,he}/terms.html` — the header line and the closing "Contact" paragraph

## Not a placeholder — leave exactly as written

The Google Limited Use sentence in the Calendars section of all three privacy pages is
quoted **verbatim in English** because Google's review requires that exact wording. The
Arabic and Hebrew pages keep the English sentence and add a clearly-marked unofficial
translation next to it. Do not translate, reword or reflow the English sentence:

> MaybeSitter's use and transfer of information received from Google APIs to any other
> app will adhere to the Google API Services User Data Policy, including the Limited Use
> requirements.
