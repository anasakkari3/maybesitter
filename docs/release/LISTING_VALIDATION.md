# Listing length preflight (#205)

This is reusable preparation, not an approved listing. Brand, domain, legal,
privacy, translation, screenshots, store access and release approval remain
separate gates. No actual listing files are created by this tooling.

Run from any directory:

```sh
node docs/release/check_listing_lengths.mjs
# Or supply both input paths explicitly (relative to the current directory):
node docs/release/check_listing_lengths.mjs /path/apple.json /path/play.md
```

The default files are repository-relative `mobile/store.config.json` and
`docs/release/store-listing-v1.md`. Missing files deliberately fail with exit 1;
a green synthetic test does not mean real listings exist. Successful validation
checks only the required project's three locales and listed text fields. It
is not full EAS schema validation, factual/legal review, URL availability,
linguistic review, screenshot verification, approval or submission. The script
makes no network requests or store changes and never prints listing contents.

## Apple input shape

Use EAS Metadata's `configVersion: 0` and `apple.info`. All three locale keys
`en-US`, `ar-SA`, and `he` are required; each requires these fields:

```json
{
  "title": "{{APP_TITLE}}",
  "subtitle": "{{SUBTITLE}}",
  "description": "{{DESCRIPTION}}",
  "keywords": ["{{KEYWORD}}"]
}
```

This is a shape example, **not a complete or passing file**. Resolve placeholders
with approved copy. Other EAS fields may be present but are outside this
checker's scope, including support/privacy URLs, category, availability and
release/review settings. Never commit review credentials.

The key is `title`, not `name`, and keywords are an array. EAS uses `ar-SA`
for Arabic (the old #205 text says `ar`). [Expo schema](https://docs.expo.dev/eas/metadata/schema/)

## Play markdown shape

Include exactly one fenced block whose opening line is ` ```json play-listing`
(without the leading space). It contains JSON with a `locales` array. Include
exactly one entry for each of `en-US`, `ar`, and `iw-IL`:

```json
{
  "locale": "en-US",
  "title": "{{APP_TITLE}}",
  "shortDescription": "{{SHORT_DESCRIPTION}}",
  "fullDescription": "{{FULL_DESCRIPTION}}"
}
```

The example shows one array entry, not a passing file. Prose outside the block
is not checked. Newlines inside JSON text values must be escaped as `\n`.
Duplicate locale entries fail; avoid duplicate JSON object keys (standard JSON
parsing retains the last value). This block format is a local copy/preflight
convention, not a Google API payload or an EAS Android configuration.

## Limits and counting

- Apple title: 2–30; subtitle: 1–30; description: 10–4000 characters, matching
  the EAS field requirements used by this preflight.
- Play title: 1–30; short description: 1–80; full description: 1–4000.
  [Google listing limits](https://support.google.com/googleplay/android-developer/answer/9859152?hl=en-GB)
- Apple keywords: join the array with commas, then require both at most 100
  characters and at most 100 UTF-8 bytes. Apple's platform reference specifies
  **100 bytes**, which is stricter for Arabic/Hebrew than the issue's character
  wording. [Apple platform reference](https://developer.apple.com/help/app-store-connect/reference/app-information/platform-version-information)

Character counts use Unicode code points, including spaces, punctuation,
combining marks and line breaks, without normalization or trimming. Emoji can
have multiple code points; this is not a rendered-glyph counter. The store's
own validation remains authoritative. Keyword byte counts include commas.

Empty or whitespace-only values, malformed types, missing/extra locales,
duplicate keywords, and recognized draft markers (`{{…}}`, TODO, TBD, FIXME,
PLACEHOLDER, `<domain>`, and example.com/org/net URLs) fail. Marker checks are
not a general approval or secret detector. Errors print fixed field paths and
reasons; output includes counts but never submitted text.
