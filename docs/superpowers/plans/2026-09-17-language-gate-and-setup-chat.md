# Language gate and guided setup chat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fresh install chooses its language before sign-in, and onboarding's "About you" box becomes five chip-assisted questions whose answers feed the existing describe/review flow.

**Architecture:** A `LanguageGate` above `AuthProvider` shows `LanguageStep` until a language preference has been stored. In onboarding, the `about` step renders a new `SetupChatStep` (one question per screen, answers cached per account on device) and composes the answers into the text the existing `POST /api/mobile/profile/describe` already reads. One new content-free analytics event records how many questions were answered.

**Tech Stack:** React Native 0.81 / Expo (no expo-router; `Root.tsx` switches on a screen name), TypeScript strict with `exactOptionalPropertyTypes`, Jest + `@testing-library/react-native` v14 (render and fireEvent are async — always `await`), AsyncStorage, i18next with three locale JSON files whose key parity is enforced by `tsc` and `parity.test.ts`. Root repo: Next.js route handlers, `node --test` suites listed in `package.json`.

**Spec:** `docs/superpowers/specs/2026-09-17-language-gate-and-setup-chat-design.md`

## Global Constraints

- Strings are already added (commit "i18n: strings for the language gate and the guided setup chat"). Do not add or rename keys; read them through `t.<key>` from `useApp()` or `fill(t.key, {...})`. Removed keys: `obAboutTitle`, `obAboutPlaceholder`.
- Nothing persists to the account without confirmation. The review step (`AboutYouReviewStep`) is the only writer of memory facts; do not add another.
- With AI consent declined, zero calls to `describeProfile`.
- No `left`/`right` offsets in layout; use `gap`, `flexWrap`, `alignItems`. The root flips `direction` for ar/he.
- Every AsyncStorage call is wrapped in try/catch and failure degrades, never blocks.
- `MAX_DESCRIPTION_LENGTH` (1,000) in `mobile/src/features/onboarding/aboutYou.ts` is the server cap; the composed text must never exceed it.
- Commit after each task with a message ending in `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Run mobile tests from `mobile/` with `npx jest <path>`; lint with `npx expo lint --no-cache`; types with `npx tsc --noEmit`.

---

### Task 1: Analytics event `onboarding_setup_answered` (root + mobile schema)

**Files:**
- Modify: `src/contracts/v1/analyticsEventContracts.ts` (append to `ANALYTICS_EVENT_NAMES`)
- Modify: `lib/analytics/privacySafeEvents.ts` (`EVENT_PROPERTIES`)
- Modify: `lib/analytics/loopAnalytics.ts` (client-reportable list)
- Modify: `mobile/src/api/schemas/analytics.ts` (`CLIENT_REPORTABLE_EVENTS`)
- Test: find the existing root tests that enumerate event names (`grep -rln "plan_dismissed" tests lib src`) and extend the one that asserts the reportable list and the one that validates properties.

**Interfaces:**
- Produces: event name `'onboarding_setup_answered'` with the single allowed property `answeredCount` (number 0–5). Task 5 sends it.

- [ ] Step 1: Add a failing root test asserting `validatePrivacySafeEvent({ eventName: 'onboarding_setup_answered', properties: { answeredCount: 3 } })` (use whatever the existing validator export is named) is accepted and that `answeredCount: 'three'` or an extra key is rejected.
- [ ] Step 2: Run it: `node --test <that file>` (check `package.json` `test` script for how root tests run). Expect failure.
- [ ] Step 3: Add the name to the three root lists with a comment in the style of `plan_opened` ("UC-3.17 (#469). How many of the five setup questions were answered — a count, never the answers"). Add `onboarding_setup_answered: ['answeredCount']` to `EVENT_PROPERTIES`. Add to the mobile `CLIENT_REPORTABLE_EVENTS`.
- [ ] Step 4: Rerun the root test file and `npm test` at root if it is fast enough; otherwise the analytics suites only. If a mobile API fixture test exists that snapshots event names (`grep -rn "onboarding_completed" tests`), regenerate as its header says.
- [ ] Step 5: `npx tsc --noEmit` in `mobile/`. Commit.

### Task 2: Language preference "chosen" bit and `LanguageStep` + `LanguageGate`

**Files:**
- Modify: `mobile/src/i18n/language.ts` (`loadLanguagePref` → also report whether a value was stored)
- Modify: `mobile/src/state/AppContext.tsx` (expose `langChosen: boolean | null` and action `chooseLanguage(locale: SelectableLocale)`)
- Create: `mobile/src/features/language/LanguageStep.tsx`
- Create: `mobile/src/features/language/LanguageGate.tsx`
- Modify: `mobile/App.tsx` (wrap `AuthProvider` in `LanguageGate`, directly under `AppProvider`)
- Test: `mobile/src/i18n/__tests__/language.test.ts` (create if absent), `mobile/src/features/language/__tests__/languageGate.test.tsx`

**Interfaces:**
- Produces: `loadLanguagePrefState(): Promise<{ pref: LanguagePref; chosen: boolean }>` (keep `loadLanguagePref()` for existing callers). `useApp().langChosen` (null while loading), `useApp().actions.chooseLanguage(locale)`.
- `LanguageStep({ onContinue })`: renders `t.langTitle`, three `Btn`s labelled by `LANGUAGE_ENDONYM`, the one equal to `lang` selected (`accessibilityState={{ selected }}`), `testID="language-option-<code>"`, primary `Btn` `t.langContinue` with `testID="language-continue"`, hint `t.langHint`. Tapping an option calls `actions.setLang(code)` so the screen re-renders in that language at once. Its root `View` sets `direction: rtl ? 'rtl' : 'ltr'` (this screen renders outside `Root`). Continue calls `actions.chooseLanguage(lang)` then `onContinue()`.
- `LanguageGate({ children })`: `langChosen === null` → `<View testID="language-loading" />` on `p.bg`; `false` → `LanguageStep`; `true` → children.

- [ ] Step 1: Failing unit tests in `language.test.ts`: no stored key → `{ pref: 'system', chosen: false }`; stored `'system'` → `chosen: true`; stored `'he'` → `{ pref: 'he', chosen: true }`; corrupt value → `{ pref: 'system', chosen: false }`.
- [ ] Step 2: Failing component test `languageGate.test.tsx`: render `<SafeAreaProvider initialMetrics><AppProvider><LanguageGate><Text>SIGN IN</Text></LanguageGate></AppProvider></SafeAreaProvider>` with a cleared AsyncStorage → the language screen is visible and `SIGN IN` is not; press `language-option-he` → `t.langTitle` for Hebrew (`he.langTitle`) is shown; press `language-continue` → `SIGN IN` appears and `AsyncStorage.getItem('settings.language')` is `'he'`. Second test: with `'ar'` stored beforehand → `SIGN IN` renders and no language screen.
- [ ] Step 3: Implement. In `AppContext`, hydrate with `loadLanguagePrefState()` and keep `langChosen` in state; `chooseLanguage` = `applyLangPref(locale)` + `setLangChosen(true)`. Note `applyLangPref` saves through `saveLanguagePref`, so "chosen" is then durable because the key exists.
- [ ] Step 4: Run the two test files and `npx tsc --noEmit`. Then run `src/features/onboarding/__tests__/onboardingFlow.test.tsx` and `src/auth/__tests__` (if any) to confirm nothing that renders `AppProvider` broke — they render without `LanguageGate`, so they should be untouched.
- [ ] Step 5: Commit.

### Task 3: Setup chat pure module and per-account cache

**Files:**
- Create: `mobile/src/features/onboarding/setupChat.ts`
- Create: `mobile/src/lib/deviceSettings/setupChatCache.ts`
- Test: `mobile/src/features/onboarding/__tests__/setupChat.test.ts`, `mobile/src/lib/deviceSettings/__tests__/setupChatCache.test.ts`

**Interfaces (produced):**
```ts
export type SetupQuestionId = 'work' | 'day' | 'places' | 'done' | 'habits';
export interface SetupQuestion { id: SetupQuestionId; labelKey: keyof Strings; promptKey: keyof Strings; chipKeys: readonly (keyof Strings)[] }
export const SETUP_QUESTIONS: readonly SetupQuestion[]; // in that order; keys obSetupWorkLabel/Prompt/Chip1..5, obSetupDay… (4 chips), obSetupPlaces… (5), obSetupDone… (5), obSetupHabits… (5)
export const MAX_ANSWER_LENGTH = 150;
export type SetupAnswers = Record<SetupQuestionId, string>;
export const EMPTY_SETUP_ANSWERS: SetupAnswers; // all ''
export function answeredCount(a: SetupAnswers): number; // non-blank after trim
export function clampAnswer(text: string): string; // trim + cut to MAX_ANSWER_LENGTH code points
export function composeDescription(a: SetupAnswers, t: Strings): string; // "<label>: <answer>" per answered question joined by "\n"; '' when none; never longer than MAX_DESCRIPTION_LENGTH (assert with a test using 5×150-char answers in every locale)
export function nextQuestionIndex(i: number): number | null; export function previousQuestionIndex(i: number): number | null;
```
```ts
// setupChatCache.ts — mirrors routineCache.ts
export const SETUP_CACHE_VERSION = 1;
export interface SetupChatCache { version: number; answers: SetupAnswers; index: number; updatedAt: string }
export function setupChatStorageKey(accountId: string): string; // `onboarding.setupChat.v1.${accountId}`
export async function loadSetupChatCache(accountId: string): Promise<SetupChatCache | null>; // null when absent, corrupt, wrong version, or index out of range
export async function saveSetupChatCache(accountId: string, cache: SetupChatCache): Promise<void>;
export async function clearSetupChatCache(accountId: string): Promise<void>;
```

- [ ] Step 1: Write the failing tests: order of ids; `answeredCount` ignores whitespace; `clampAnswer` on a 200-char string returns 150 code points (use an Arabic string too); `composeDescription` with two answers gives two lines with the locale's labels (`strings.ar.obSetupWorkLabel`) and skips blanks; the 5×150 worst case in en/ar/he is ≤ 1000; cache round-trips, per-account key, corrupt JSON → null, index 99 → null.
- [ ] Step 2: Run them, expect failure. Step 3: implement. Step 4: run + `tsc`. Step 5: commit.

### Task 4: `SetupChatStep` component

**Files:**
- Create: `mobile/src/features/onboarding/SetupChatStep.tsx`
- Test: `mobile/src/features/onboarding/__tests__/setupChatStep.test.tsx` (model on `aboutYouStep.test.tsx` for the render harness)

**Interfaces:**
- Consumes Task 3.
- Produces:
```tsx
export function SetupChatStep(props: {
  answers: SetupAnswers; index: number;
  onChange: (update: (previous: SetupAnswers) => SetupAnswers) => void;
  onIndexChange: (index: number) => void;
  onRead: () => void;      // last question, at least one answer
  onSkip: () => void;      // "Skip for now" in the footer, always visible; also the primary when on the last question with zero answers (label t.obSetupFinish)
  onBack: () => void;      // called only when Back is pressed on question 0
  reading?: boolean; failed?: boolean;
})
```
- Rendering inside `OnboardingChrome step="about"`: title = `t[question.promptKey]`; above the card a `Txt` `fill(t.obSetupQuestionOf, { current: index+1, total: 5 })` with `testID="setup-question-of"`; on question 0 also `t.obSetupIntro`. Chip row: `View` `flexDirection:'row', flexWrap:'wrap', gap: 8` of `Btn`s (`testID="setup-chip-<questionId>-<n>"`, `accessibilityRole="button"`), tap → `onChange(prev => ({ ...prev, [id]: clampAnswer(label) }))`. Selected look when the field equals that chip's label (`backgroundColor: p.acs`). `TextInput` `testID="setup-answer-input"`, `maxLength={MAX_ANSWER_LENGTH}`, `placeholder={t.obSetupPlaceholder}`, `textAlign: rtl ? 'right' : 'left'`, counter `Txt latin` `"<n> / 150"`. Footer: primary is `t.obSetupNext` (not last) or `t.obSetupRead` (last, answered ≥ 1; `reading` → `t.obAboutReading`, disabled) or `t.obSetupFinish` (last, none answered → calls `onSkip`); secondary is `t.obBack` on every question (question 0 → `onBack`, else `onIndexChange(index-1)`). Skip: a third row link `Btn` labelled `t.obSkip` `testID="setup-skip"` placed above the footer in the scroll content (Chrome only has two footer slots). `footNote` = `t.obAboutFailed` when `failed`.

- [ ] Step 1: Failing tests: question 0 shows the work prompt and `Question 1 of 5`; chip tap fills the input with the chip text; Next moves to `index 1` (via `onIndexChange` spy); Back on question 0 calls `onBack`; on index 4 with answers the primary reads "Read my answers" and calls `onRead`; on index 4 with no answers primary reads "Finish without answers" and calls `onSkip`; `setup-skip` is visible on every index.
- [ ] Step 2–5: run/fail, implement, run/pass + `tsc` + `npx expo lint --no-cache`, commit.

### Task 5: Wire the flow: cache, describe, analytics, manual card, trim `AboutYouStep`

**Files:**
- Modify: `mobile/src/features/onboarding/OnboardingFlow.tsx` (`about` branch)
- Modify: `mobile/src/features/onboarding/AboutYouStep.tsx` (keep only the manual variant: props `{ onManual, onBack }`; delete the free-text variant, its `TextInput` and the `MAX_DESCRIPTION_LENGTH` re-export if unused elsewhere)
- Modify: `mobile/src/features/onboarding/__tests__/aboutYouStep.test.tsx` (drop free-text cases)
- Modify: `mobile/src/features/onboarding/__tests__/onboardingFlow.test.tsx` (extend)

**Behaviour:**
- State: `const [setup, setSetup] = useState<{ answers: SetupAnswers; index: number }>({ answers: EMPTY_SETUP_ANSWERS, index: 0 })`. On mount with `accountId`, `loadSetupChatCache(accountId)` seeds it. Every `onChange`/`onIndexChange` also `saveSetupChatCache(accountId, {...})` (fire-and-forget).
- `about` + `choices.ai !== 'granted'` → `<AboutYouStep onManual={() => void finishSetup('manual')} onBack={() => goBack('about')} />`.
- `about` + granted + `proposal === null` → `SetupChatStep` with `onRead={() => void readDescription(composeDescription(setup.answers, t))}`, `onSkip={() => void finishSetup('skipped')}`, `onBack={() => goBack('about')}`.
- `proposal !== null` → `AboutYouReviewStep` as today; `saveSuggestions` success path calls `finishSetup('saved')`.
- `finishSetup(reason)`: if `accountId` clear the cache; if `choices.analytics` send `recordAnalytics.mutate({ eventName: 'onboarding_setup_answered', properties: { answeredCount: answeredCount(setup.answers) } })`; then `advance('about')`. (The manual path reports `answeredCount: 0`.)
- `describeFailed` maps to `SetupChatStep failed`.

- [ ] Step 1: Failing flow tests (reuse the file's harness; walk welcome → consent (allow AI, analytics on) → routine skip): (a) the first setup question is shown; tapping chip `setup-chip-work-1` then Next ×4 then "Read my answers" calls `describeProfile` with a text containing `en.obSetupWorkLabel + ': ' + en.obSetupWorkChip1`; (b) unmount and remount after one answer → the answer and index are restored from AsyncStorage; (c) with AI declined the manual card shows and `describeProfile` is never called; (d) after "Finish without answers", `recordAnalyticsEvent` was called with `('onboarding_setup_answered', { answeredCount: 0 })` only when analytics was granted; (e) the review step still saves nothing without ticks.
- [ ] Step 2–5: run/fail, implement, run the whole onboarding test directory + `tsc` + lint, commit.

### Task 6: Maestro flows and the flow-lint test

**Files:**
- Modify: `mobile/.maestro/onboarding.yaml`, `mobile/.maestro/smoke.yaml`, `mobile/.maestro/auth-gate.yaml` (every `launchApp: clearState: true` is followed by `- tapOn: 'العربية'` then `- tapOn: id: 'language-continue'`).
- Modify `onboarding.yaml`'s "About you" block: assert the Arabic work prompt (`ar.obSetupWorkPrompt`), tap `id: setup-chip-work-1`, tap `التالي` ×4, tap `اقرا أجوبتي`, expect the review title `ar.obAboutReviewTitle`, tap `ما تحفظ إشي`, continue to notifications.
- Test: `mobile/src/config/__tests__/maestroFlows.test.ts` must pass (it checks every `id:` exists as a `testID` in source and every quoted string exists in a locale file, read its header for the exact rules).

- [ ] Steps: edit, run the maestro flow test, commit.

### Task 7: Verification and graph update

- [ ] `cd mobile && npx tsc --noEmit && npx expo lint --no-cache && npx jest` (full mobile suite).
- [ ] Root: `npm test` (the explicit file list) or at least the analytics contract suites.
- [ ] `graphify update .` locally so the graph reflects the new modules. Do not commit `graphify-out/`: `docs/operations/EXPANSION_ORCHESTRATION_LEDGER.md` requires it to stay uncommitted.
- [ ] Open the PR against `main` referencing #469, with the council verdict summary.
