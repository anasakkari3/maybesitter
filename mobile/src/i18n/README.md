# i18n

Three locales, one source of copy, formatting that always names its timezone.

```
locales/en.json   template — 159 keys, the approved round-1 design copy
locales/ar.json   Arabic, the default language
locales/he.json   Hebrew, wired but NOT selectable (see below)
locale.ts         locale list, the Latin-digit decision, apiLocale()
index.ts          i18next + i18next-icu init, tFor(), setLocale()
i18next.d.ts      typed keys: t('notAKey') is a compile error
strings.ts        the screens' view of the copy (strings, fill, ltr, Strings)
format.ts         formatDate/Time/RelativeDay/Number/TimeRange, all via Intl
timezone.ts       deviceTimeZone(), useTimeZone(), UTC fallback
bidi.ts           isolate / isolateAuto / stripIsolates (U+2066–U+2069)
language.ts       the System/English/العربية preference, persisted
```

## Reading a string

Plain copy goes through `t` from `useApp()` — a plain object, no lookup:

```tsx
const { t } = useApp();
<Txt>{t.reviewTitle}</Txt>
<Txt>{fill(t.savedDay, { d: dayLabel(day, t) })}</Txt>
```

Anything that counts goes through `tr`, the ICU-aware `t`:

```tsx
const { tr } = useApp();
<Txt>{tr('confirmN', { n })}</Txt>
```

`tr` is key-checked against `locales/en.json`. `tr('nope')` fails `tsc`.

## Why three keys are ICU plurals

`fill()` substitutes; it cannot inflect. «أكّد {n} التزامات» is simply wrong
Arabic for n=2 (dual: التزامين) and for n≥11 (accusative singular: 11 التزامًا).
`confirmN`, `lockedTitle` and `progressWords` are therefore ICU plurals with all
six Arabic CLDR categories (`zero one two few many other`) and three Hebrew ones
(`one two other`), modelled on `commitmentsCountToday` in the archived
`app_ar.arb`. Everything else stays a plain string handled by `fill`.

## Digits

Arabic uses **Latin** digits. That is one constant, `INTL_LOCALE` in
`locale.ts`, which maps `ar` → `ar-u-nu-latn`. It reaches ICU plurals
(via `parseLngForICU`), `Intl.DateTimeFormat` and `Intl.NumberFormat` alike.
Delete the `-u-nu-latn` extension there to switch the whole app to ٠١٢…

## RTL — deliberate deviation from issue #156

Issue #156 step 5 asks for `I18nManager.allowRTL/forceRTL` plus an app reload.
**We do not do that.** The root view sets `direction: 'rtl'` once
(`src/Root.tsx`), which flips every row, `start`/`end` offset and border side,
and it switches language **live** with no restart and no "the app will
restart" dialog. This is the mechanism the round-1 design was built and
verified on, and the `no-restricted-syntax` rule in `eslint.config.js` keeps
every new style writing-direction relative so it keeps working.

`supportsRTL` is therefore not set in `app.config.ts`. `expo-localization` is
registered as a config plugin in `app.json` only so `getLocales()` and
`getCalendars()` work in a dev client / release build.

## Timezone

`deviceTimeZone()` reads `getCalendars()[0]?.timeZone`, validates it with
`Intl.DateTimeFormat`, and falls back to **`'UTC'`** — never to a region. The
Flutter client hardcoded `Asia/Jerusalem` and silently showed the wrong wall
time to anyone outside Israel. `useTimeZone()` re-reads it on `AppState`
`'active'`. Every formatter in `format.ts` takes an explicit `timeZone`.

## TODO(he) — Hebrew is wired, not shipped

`locales/he.json` has full key parity and is registered with i18next, and
`apiLocale()` will return `'he'`. It is **not** in `SELECTABLE_LOCALES`, so the
language picker offers System / English / العربية only. It carries
`"_meta": { "machine_translated": true }` so nobody mistakes it for reviewed
copy.

Two gates before Hebrew can be offered:

1. **A native speaker has to review it.** It was produced from the terminology
   table in `archive/flutter-final:mobile/docs/localization.md` (התחייבות,
   חובה/מומלץ/רשות) with wording mined from `app_he.arb`, not translated by a
   human. Grammatical gender in particular is unreviewed: the archived Flutter
   copy addressed the user in the feminine, this file uses masculine/infinitive
   forms, and the two have never been reconciled.
2. **The app needs a Hebrew font face.** `src/theme/fonts.ts` loads only Noto
   Naskh Arabic and Outfit. Neither has Hebrew glyphs, so every Hebrew string
   would render as tofu (□□□) today. Adding a face is a design decision, not a
   localisation one — the round-1 design fixes the two faces it uses.

Until both are done, `he.json` exists so the copy does not have to be
re-derived later and so parity tests keep it honest.
