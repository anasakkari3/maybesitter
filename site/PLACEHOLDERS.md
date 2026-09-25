# Placeholders the owner must fill in

The owner purchased **maybesitter.com** and approved it as the project domain on
2026-09-25 (#333). Its domain token is resolved in the public site files.
The owner also confirmed the localized public operator names on 2026-09-25:
English `anas akkari`, Hebrew `אנס עקארי`, Arabic `انس عكاري`.
The support and privacy addresses were configured as free aliases on the existing
owner Workspace mailbox on 2026-09-25. Admin Console confirmed both saved;
internal test delivery was verified in recipient-level Workspace logs.
On 2026-09-25, the owner explicitly accepted human operational responsibility
for monitoring both addresses and handling support, privacy and account/data
deletion requests. The owner separately approved a human operational commitment
to respond to and follow up on privacy requests received at privacy@maybesitter.com
within 30 days of receipt. This does not guarantee completion of every deletion
or technical action during that period. It is not an automated service guarantee.
Only the effective-date token stays unfinished until publication is approved; domain approval is not
approval to publish the legal documents.
The owner also approved the material-change process on 2026-09-25: update the
document version and effective date on the website and, before a material change
takes effect, email affected users at the address linked to their account when a
valid contact address is available. No in-app notice is promised while no such
workflow exists.

Find them all at any time:

```bash
git grep -nE '\{\{(DOMAIN|LEGAL_NAME|SUPPORT_EMAIL|PRIVACY_EMAIL|EFFECTIVE_DATE)\}\}' -- site/
```

Replace them all at once (macOS `sed`), after you have decided the real values.
The following is a template: replace `APPROVED_PUBLICATION_DATE` before running it, after owner approval of publication. Delivery verification and the owner monitoring commitment are recorded above.

```bash
cd site
grep -rl '{{' . --include='*.html' --include='*.md' --include='*.txt' --include='*.xml' | xargs sed -i '' \
  -e 's/{{EFFECTIVE_DATE}}/APPROVED_PUBLICATION_DATE/g'
```

Then re-run `./check-links.sh --local` and grep again to confirm no `{{` remains.

## The tokens

### `{{DOMAIN}}`

- **Resolved:** `maybesitter.com`, approved by the owner on 2026-09-25 and
  confirmed in the authenticated Cloudflare account. This supersedes the earlier
  `.app`/`.co` suggestions. The public files already use this value.
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
  point at the pages owned by UC-4.3b (#179), which already exist in all three
  languages. Publish them with the approved privacy and terms pages.

### `{{LEGAL_NAME}}`

- **Resolved:** exact owner-supplied public names: English `anas akkari`, Hebrew
  `אנס עקארי`, Arabic `انس عكاري` (2026-09-25). Each language uses its matching
  name. This identity confirmation does not approve legal publication.
- **Where it appears:**
  - the footer of all 12 pages (`© MaybeSitter — {{LEGAL_NAME}}`)
  - `{en,ar,he}/privacy.html` — the "Who we are" section
  - `{en,ar,he}/terms.html` — the intro, "Who we are" and "Contact" sections

### `{{SUPPORT_EMAIL}}`

- **Configured:** `support@maybesitter.com`, an alias on the existing owner
  Workspace mailbox. Admin Console confirmed the saved configuration on
  2026-09-25. Internal delivery test passed on 2026-09-25 (Workspace: Delivered to Gmail
  mailbox). The owner accepted monitoring and request-handling responsibility on 2026-09-25.
  Existing Google Workspace MX records were preserved.
- **Where it appears:**
  - `index.html`, `ar/index.html`, `he/index.html` — the footer ("Questions and feedback")
  - `{en,ar,he}/privacy.html` — "Who we are"
  - `{en,ar,he}/terms.html` — "Who we are", "Your account", "Acceptable use", "Contact"

### `{{PRIVACY_EMAIL}}`

- **Configured:** `privacy@maybesitter.com`, an alias on the same existing owner
  Workspace mailbox. Admin Console confirmed the saved configuration on
  2026-09-25. Internal delivery test passed on 2026-09-25 (Workspace: Delivered to Gmail
  mailbox). The owner accepted monitoring and request-handling responsibility on 2026-09-25;
  this is the address a data subject writes to, so it must actually be read.
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
