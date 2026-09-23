# MaybeSitter mobile app (React Native · Expo SDK 57)

## Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before
writing any code. This app targets Expo SDK 57, React Native 0.86, React 19.2.

## Design source of truth

The approved coral/charcoal continuation is the current visual reference.
`src/design/coral.source.json` records its fifteen reference images and palette;
`docs/design/coral-continuation.md` records the implementation decisions.
`design/R2App.dc.html` remains the Round-2 structural reference: three tabs with their own
stacks, tasks, sheets and dialogs (`src/state/navigation.ts`), one screen
grammar (`src/ui/chrome.tsx`), and the reconciled Today
(`src/features/today/composeToday.ts`). Where Round 2 drew no screen — the
settings leaves, onboarding, auth, deletion — the app's own screens were
brought onto Round 2's chrome and names. Where the app deliberately differs
from the export, the screen header says so; the delta and the feature matrix
are in `docs/design/`.

Rules the design fixes, which code must keep:

- Arabic first (RTL), English mirrored. Direction is set once on the root view
  (`direction: 'rtl'`); use `start`/`end` offsets and `borderStart*`, never
  `left`/`right`, so layouts mirror without per-screen code.
- Times and dates inside Arabic text go through `ltr()` from `src/i18n/strings.ts`.
- Inside a `Btn` (a `Pressable`), full-width text in a column aligns to the
  physical left even under `direction: 'rtl'`. Give start-aligned column
  content `alignItems: 'flex-start'` instead of relying on `textAlign`.
- Digits and Latin-only labels that sit in tight boxes (calendar day numbers)
  use `<Txt latin>`: Noto Naskh's tall line box clips them otherwise.
- Coral (`ac`) marks actions and selected navigation; green marks confirmed
  completion; warm sand (`wm`) marks attention and proposals. Every state has
  a text label and uses the contrast-tested pair from `src/theme/tokens.ts`.
- There is no "overdue". Only active, done, rearranged, dropped on purpose.
  «أسقطه بوعي» has the same weight as «تمّت».
- Suggestions always say «هذا اقتراح. لم يتغيّر أي شيء بعد.» and nothing is
  saved without an explicit confirm.
- Spoken Arabic for actions: تمّت · لسّا · احكيها · أسقطه بوعي.
- Colours come from `src/theme/tokens.ts`; never hard-code hex in screens.
- Respect reduce-motion (`useReducedMotion` in `src/ui/motion.tsx`).

## Layout

```
App.tsx              fonts + providers + the sign-in gate
src/Root.tsx         screen switch, tab bar, toast host, sheet host (signed-in only)
src/auth/            AuthProvider/useAuth, AuthGate, the repositories, dev override
src/state/           AppContext (state + actions), navigation (history), types
src/screens/         the spine: Today, Calendar, Settings, Details, Plan, Capture/Review/Saved, Share, Sheets, TabBar
src/features/        one directory per product area: today (composeToday), nextStep, plan, commitments, capture, share, calendar, settings, memory, activity, onboarding, account…
src/ui/              primitives, chrome (the screen grammar), taskHeader, dialog, toast, icons, motion
src/i18n/            all copy, ar + en + he, and the format/bidi helpers
src/theme/           tokens (light/dark roles + palettes), textScale, fonts
src/config/          env + the release config guard shared with app.config.ts
firebase/            the committed Firebase app config for both platforms
```

## Auth

`AuthGate` (`src/auth/AuthGate.tsx`) decides what renders: a blank hold while
Firebase answers, the sign-in screen when nobody is, and `Root` once someone
is. UC-1.7 (#151) specified this as expo-router `Stack.Protected` guards; this
app has no `app/` directory, so the same invariant is enforced in the
navigation the app actually has. Onboarding (UC-2.R1 #171) composes in as the
gate's `onboarding` slot when it lands.

Rules that hold here:

- **One module imports the Firebase auth SDK** — `firebaseAuthRepository.ts`.
  A test asserts it, so the "never log an ID token" rule is one file to read.
- **Nothing in `src/auth/` calls `console.*`.** Also asserted.
- **The dev bypass needs four conditions at once** (`devBypass.ts`): a
  development bundle, `APP_ENV=development`, a non-empty
  `EXPO_PUBLIC_DEV_BEARER_TOKEN`, and an API host on the developer's machine.
  `releaseGuard.ts` additionally fails the *build* if the variable is set for
  staging or production, so a binary that could honour it is never made.
- **Sign-in failures never say which half was wrong**, and a password reset
  reports the same thing whether or not the account exists.
- **`firebase/google-services.json` and `firebase/GoogleService-Info.plist`
  are committed on purpose** (#151). `.gitignore` negates them explicitly
  because many global gitignores exclude both by name.

## Backend

The app talks to `/api/mobile/**` in the repository root through `src/api/`
(UC-1.R4 #157). Every screen reads the account through these hooks; the
Round-1 seed week and the mock capture service are gone.

Fields the design needs that the backend does not return yet: duration / end
time, items with no time and yesterday's items, sentence-span → card mapping,
ambiguity and "big task" flags.

### `src/api/`

```
client.ts        apiRequest: fetch + 15 s AbortController, status → typed error
errors.ts        the error hierarchy every screen switches on
auth.ts          the bearer, the shared refresh, the two-401 sign-out
schemas/         Zod schemas, one per response
endpoints/       one typed function per route
queries.ts       TanStack Query hooks and the invalidation rules
queryClient.ts   defaults, NetInfo → onlineManager, AppState → focusManager
ui/              ApiProvider, QueryBoundary, OfflineBanner, userFacingMessage
__fixtures__/    real route responses; see below
```

**The schemas are checked, not believed.** `tests/mobile/exportMobileApiFixtures.test.ts`
at the repository root invokes every route handler in-process and writes the
JSON to `__fixtures__/`. The mobile suite parses each fixture with the schema
the app ships, so a backend change that alters a response fails CI instead of a
user's screen. Values that differ per run — uuids, `new Date()` — are
normalised, so a fixture diff always means the *shape* changed. After changing
a `/api/mobile` route, re-run that test and commit what it rewrote.

**Do not write a schema from an issue's table.** Two of #157's were already
stale: the next-step decision takes the whole `proposal` object (not a bare
`proposalId`), and analytics takes `{ eventName, properties }` (not the Flutter
`PilotLoopAnalyticsEvent`). Read the route, or read the fixture.

Rules that hold in `src/api/`, each asserted by a test:

- **Nothing is logged.** No `console.*` anywhere under `src/api`. A networking
  layer's log line is the user's commitment titles in the device log.
- **Nothing is persisted.** No query persister, no offline mutation queue, no
  import of AsyncStorage or SecureStore. A cold start with no data is the
  price; an unencrypted copy of the user's life is not.
- **`userFacingMessage` is the only way an error becomes words**, and it never
  interpolates `error.message`.
- **One forced refresh per 401, shared between concurrent callers**; a second
  401 signs out with `session_expired`.
- **Query keys are scoped by uid**, and the cache is cleared on a uid change,
  so account B never sees a row of account A's (#148).
- **Confirm is never retried.** A confirmation replayed without the user
  present is what #157 forbids, and a 200 alone is not read as success.

## Commands

```
npm start          # Expo dev server
npm run ios        # iOS simulator
npx tsc --noEmit   # type-check
```
