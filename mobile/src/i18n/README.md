# i18n

Three locales, one source of copy, formatting that always names its timezone.

```
locales/en.json   template — 159 keys, the approved round-1 design copy
locales/ar.json   Arabic, the default language
locales/he.json   Hebrew, selectable and machine translated (see below)
locale.ts         locale list, the Latin-digit decision, apiLocale()
index.ts          i18next + i18next-icu init, tFor(), setLocale()
i18next.d.ts      typed keys: t('notAKey') is a compile error
strings.ts        the screens' view of the copy (strings, fill, ltr, Strings)
format.ts         formatDate/Time/RelativeDay/Number/TimeRange, all via Intl
timezone.ts       deviceTimeZone(), useTimeZone(), UTC fallback
bidi.ts           isolate / isolateAuto / stripIsolates (U+2066–U+2069)
language.ts       the System/English/العربية/עברית preference, persisted
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

Hebrew is `he`, with no extension, and that is a decision rather than the
absence of one. Hebrew has numerals of its own — `he-u-nu-hebr` writes 2026 as
«בתשפ״ו» — but they are gematria: dates in the Hebrew calendar, verse numbers,
the occasional formal document. Nobody reads a clock or a count of tasks in
them, and CLDR already defaults `he` to `latn`. So all three languages print
`18:00` and `3`, Arabic because it was pushed there and Hebrew because that is
where it already was. `__tests__/locale.test.ts` asserts the digits that come
out, not the tag that goes in, so replacing this with `he-u-nu-hebr` fails.

## Scripts and faces

Direction and alphabet are two questions with different answers, and conflating
them is how the app arrived at a Hebrew locale it could route, translate and
format — and not draw. Arabic and Hebrew agree on direction and share not one
glyph.

- `isRtl(locale)` → `ar`, `he`. Read once, in `src/Root.tsx`.
- `scriptFor(locale)` → `'latin' | 'arabic' | 'hebrew'`, which picks the face in
  `src/theme/fonts.ts`: Outfit, Noto Naskh Arabic, Noto Sans Hebrew.

`useApp()` exposes both as `rtl` and `script`. It still exposes `ar`, which is
now *the RTL script or `false`* rather than a boolean, so the handful of call
sites that predate the third language stay correct without a cast; new code
should not use it.

`src/theme/__tests__/fontCoverage.test.ts` reads the shipped `.ttf` binaries and
asserts the coverage each face actually has. Rendering is not testable here —
see the end of that file for what is left to a device.

## RTL — deliberate deviation from issue #156

Issue #156 step 5 asks for `I18nManager.allowRTL/forceRTL` plus an app reload.
**We do not do that.** The root view sets `direction: 'rtl'` once
(`src/Root.tsx`), which flips every row, `start`/`end` offset and border side,
and it switches language **live** with no restart and no "the app will
restart" dialog. This is the mechanism the round-1 design was built and
verified on, and the `no-restricted-syntax` rule in `eslint.config.js` keeps
every new style writing-direction relative so it keeps working. Hebrew takes
exactly the same path; it needed no new mechanism, only `isRtl`.

`supportsRTL` is therefore not set in `app.config.ts`. `expo-localization` is
registered as a config plugin in `app.json` only so `getLocales()` and
`getCalendars()` work in a dev client / release build.

## Timezone

`deviceTimeZone()` reads `getCalendars()[0]?.timeZone`, validates it with
`Intl.DateTimeFormat`, and falls back to **`'UTC'`** — never to a region. The
Flutter client hardcoded `Asia/Jerusalem` and silently showed the wrong wall
time to anyone outside Israel. `useTimeZone()` re-reads it on `AppState`
`'active'`. Every formatter in `format.ts` takes an explicit `timeZone`.

## Hebrew is offered, and it is machine translated

`locales/he.json` has full key parity, is registered with i18next, is in
`SELECTABLE_LOCALES`, and the picker offers **עברית**. A Hebrew phone on
`system` now lands on Hebrew instead of English, and `?lang=he` links work.

**No native speaker has read the copy.** It was produced from the terminology
table in `archive/flutter-final:mobile/docs/localization.md` (התחייבות,
חובה/מומלץ/רשות) with wording mined from `app_he.arb`. Grammatical gender in
particular is unreviewed: the archived Flutter copy addressed the user in the
feminine, this file uses masculine/infinitive forms, and the two have never
been reconciled.

That status is stated in three places that are checked against each other:

1. `he.json` carries `"_meta": { "machine_translated": true }`.
2. `locale.ts` exports `UNREVIEWED_LOCALES = ['he']`.
3. `__tests__/provenance.test.ts` fails if those two disagree in either
   direction — including if somebody deletes the `_meta` marker without a
   review actually having happened, and if this README stops saying so.

Shipping it this way is a deliberate trade: imperfect Hebrew serves a Hebrew
reader better than correct English does, and hiding the language served nobody.
It is **not** a claim that the copy is right. The review is a person's job and
is tracked on its own issue; nothing in this repository can stand in for it.

The other old blocker is gone. `src/theme/fonts.ts` now loads Noto Sans Hebrew
alongside Outfit and Noto Naskh Arabic, so Hebrew draws glyphs rather than tofu
(□□□). See "Scripts and faces" above.
