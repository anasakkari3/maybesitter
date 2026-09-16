# Language gate and guided setup chat (#469)

Status: approved by the LLM council on 2026-09-17 (owner delegated the decision).
Sprint: Launch S3. Branch: `feat/469-language-and-setup-chat`.

## Goal

1. The first screen a fresh install shows is a language choice (العربية / עברית / English).
   Every later screen, sign-in included, renders in that language.
2. The single free-text "About you" box becomes a guided setup: five concrete
   questions, one per screen, each with tappable chips that fill an editable
   answer. The answers reach the existing `profile/describe` endpoint as one
   labelled text, and the existing review step stays the only thing that
   persists memory facts.

## Council decisions (see chat verdict)

| Question | Decision |
|---|---|
| Where the language step lives | Before sign-in, at first launch, gated on "no stored language preference". Writes `settings.language`, the same key Settings writes. |
| Chat UI | Existing `OnboardingChrome`, one question per screen, Back/Continue/Skip. No bubble transcript. |
| Persistence | Answers are cached on device per account (same pattern as `routineCache`) and restored on relaunch. Cleared when the step finishes or on sign-out. |
| The five questions | work or study · a typical day · places you go regularly · something you finished lately · habits you keep. "Achievement" stays (owner named it) but sits fourth, is phrased concretely, and has a "nothing comes to mind" chip. |
| Chips vs typing | Tapping a chip fills the answer field with a starter sentence; the field stays editable. Typing is optional. Each answer ≤ 150 characters. |
| Payload | Client concatenates answered questions as `Label: answer` lines into the existing `{ text }` (≤ 1,000 chars, 5×150 + labels fits). No server schema or prompt change. |
| AI consent declined | The chat is not shown. The manual card from #168 stays as it is. Zero describe calls. |
| Telemetry | One new content-free event `onboarding_setup_answered` with `answeredCount` (0–5), sent only when analytics consent was granted on this run. |
| Out of scope | Model-chosen follow-ups, voice per answer, structured `{ answers }` payload / `profile-v2`, bubble UI. |

## Architecture

### 1. LanguageGate (`mobile/src/features/language/LanguageGate.tsx`)

Mounted in `App.tsx` directly under `AppProvider`, above `AuthProvider`. It
reads `AppContext.langPrefLoaded` and `langPref`:

- while the stored preference is still being read → plain background (same as `AuthGate` loading);
- `langPref === 'system'` and no explicit choice has ever been stored → render `LanguageStep`;
- otherwise → children.

"Has ever been stored" needs one new bit, because `'system'` is both the
default and a legal explicit choice. `language.ts` gains
`loadLanguagePref()` returning `{ pref, chosen }` where `chosen` is whether the
key existed; `AppContext` exposes `langChosen: boolean | null` (null while
loading) and `chooseLanguage(locale)`, which calls the existing
`applyLangPref` and marks it chosen. Installs that upgraded from an earlier
build with a stored preference skip the gate (they chose already).

`LanguageStep` (`mobile/src/features/language/LanguageStep.tsx`): title in
all three languages stacked ("اختار لغتك · בחר שפה · Choose your language"),
three large option buttons named in themselves (`LANGUAGE_ENDONYM`), the one
matching `resolveLanguage('system')` preselected, one primary button whose
label is in the currently selected language. Selecting flips `lang` at once,
so the screen itself re-renders in the chosen language and direction.

`AppProvider` already flips `direction` through `Root`; the gate renders
outside `Root`, so `LanguageStep` sets `direction` on its own root view the
same way `Root` does (`rtl ? 'rtl' : 'ltr'`).

### 2. Setup chat (`mobile/src/features/onboarding/setupChat/`)

- `setupChat.ts` — pure module: `SETUP_QUESTIONS` (id, labelKey, promptKey,
  chips: `{ id, labelKey }[]`), `MAX_ANSWER_LENGTH = 150`, `SetupAnswers`
  (`Record<QuestionId, string>`), `EMPTY_SETUP_ANSWERS`, `answeredCount`,
  `composeDescription(answers, t)` → labelled text or `''`, `next/previous`
  helpers, `MAX_DESCRIPTION_LENGTH` assertion (compose never exceeds it).
- `setupChatCache.ts` (`mobile/src/lib/deviceSettings/`) — per-account
  AsyncStorage copy of `{ version, answers, index, updatedAt }`, load/save/clear,
  every call try/caught, mirrors `routineCache`.
- `SetupChatStep.tsx` — renders one question inside `OnboardingChrome`
  (`step="about"`): prompt, chip row (`flexWrap`, `gap`, no left/right
  offsets), a `TextInput` with the counter, footer Continue (or "Read it" on the
  last question) and Skip. Back goes to the previous question, and from the
  first question to the previous onboarding step. Chip tap replaces the field
  with the chip's starter sentence for the current language.
- `OnboardingFlow.tsx` — the `about` branch renders `SetupChatStep` when AI is
  granted, `AboutYouStep`'s manual card when it is not. On "Read it" it calls
  `readDescription(composeDescription(...))`; `AboutYouReviewStep` is unchanged.
  On finish (save, save nothing, or skip) it clears the cache and reports
  `onboarding_setup_answered` if `choices.analytics` is true.
- `AboutYouStep.tsx` keeps only the manual variant (the free-text variant is
  removed with its strings).

### 3. Strings

New keys in `en.json`, `ar.json`, `he.json` (the compiler enforces parity):
language screen (3), per question: prompt + short label (10), chips (5 questions
× 4–6 chips ≈ 24), chat footer (2: "Next", "Read my answers"), counter reuse.
Hebrew stays machine translated and flagged.

### 4. Server (analytics only)

`onboarding_setup_answered` added to `ANALYTICS_EVENT_NAMES`,
`privacySafeEvents` (`['answeredCount']`), `loopAnalytics` client-reportable
list, and the mobile `analytics` schema. Nothing else on the server changes.

### 5. Maestro

`onboarding.yaml`, `smoke.yaml`, `auth-gate.yaml` (the `clearState` flows)
gain a first step that taps `العربية` on the language screen. `onboarding.yaml`
walks the five questions: tap one chip on the first, skip the rest, reach the
review, save nothing, reach notifications.

## Testing

- `language.test.ts`: `loadLanguagePref` reports `chosen` correctly; a stored `'system'` counts as chosen.
- `languageGate.test.tsx`: fresh install shows the step before sign-in; choosing Hebrew renders the sign-in screen in Hebrew RTL; a stored preference skips the gate.
- `setupChat.test.ts`: order, next/previous, `composeDescription` output, skipped questions omitted, 150-char cap, total never above 1,000, `answeredCount`.
- `setupChatCache.test.ts`: per-account key, round-trip, corrupt value → empty.
- `setupChatStep.test.tsx`: chip fills the field, Back on question 1 leaves the step, Skip always visible, "Read it" disabled with nothing answered on the last question? No: "Read my answers" is enabled when at least one answer exists, otherwise the footer primary reads Skip-equivalent "Finish".
- `onboardingFlow.test.tsx`: existing claims still hold; new: answers survive a remount; AI declined shows the manual card and never calls `describeProfile`; the analytics event carries `answeredCount` and only fires with consent.
- Parity/typed-keys tests pass with the new strings; `maestroFlows.test.ts` passes with the updated flows.
- Root: contract tests for the new analytics event name.

## Acceptance (from #469, adjusted by the council)

- Fresh install: language screen first; picking עברית flips sign-in to Hebrew RTL at once; Settings shows the same choice.
- Five questions, one at a time, chips on each, each skippable, Back works, answers survive an app kill.
- Submitting shows the existing review; only confirmed items reach memory with provenance.
- AI declined: no request reaches `profile/describe`; manual card shown.
- Skipping every question finishes onboarding.
- `npm run lint -- --no-cache`, `npm run typecheck`, `npm test` in `mobile/` green; root `npm test` green for the touched contracts.
