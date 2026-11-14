# Mobile surface inventory (main `de7fcb84`, 2026-11-12)

Read from the code, not run. Paths are relative to `mobile/`. Endpoints are under `/api/mobile`.

## Conventions and global behaviour

**Navigation**
- There is no navigator library.
- `src/state/types.ts` (`Screen`) and `src/state/navigation.ts` hold the history. `src/Root.tsx` switches on it. Sheets are rendered by `src/screens/Sheets.tsx`.
- Tabs (`src/screens/TabBar.tsx`):

  | Tab | testID | Opens |
  |---|---|---|
  | «احكيها» | `tab-capture` | capture |
  | Today | `tab-today` | Today |
  | «الخطة» | `tab-calendar` | `CalendarScreen` |
  | My things | `tab-things` | My things |
  | Watching | `tab-watching` | Watching |

- Settings opens from the avatar (`open-settings`).
- Tasks: `capture`, `share`, `deleteAccount`, `calendarDemo`.

**Deep links** (`src/links.ts`, `maybesitter://`)
- Paths: `/today`, `/calendar`, `/things`, `/watching`, `/settings`, `/capture?source=tab|widget|share|notification&input=text|voice`, `/aiImport`, `/details`, `/postpone`, `/plan/YYYY-MM-DD`, `/commitments/:id`, `/item/:id`, `/next`.
- Query parameters: `?lang=ar|en|he` and `?theme=system|light|dark`.

**Gates**
- Build flags in `src/config/env.ts`:
  - `EXPO_PUBLIC_FEATURE_SHARE_INTAKE`, `_ICS_FEEDS`, `_CALENDAR_READ`, `_CALENDAR_WRITE`, `_SAFE_COMMITMENT_PATCH`, `_SOFT_REMINDERS`;
  - `EXPO_PUBLIC_KILL_SWITCH_VOICE`, `EXPO_PUBLIC_APPLE_SIGN_IN_ENABLED`, `EXPO_PUBLIC_ENABLE_TEST_CRASH`, `EXPO_PUBLIC_ENABLE_GOOGLE_CALENDAR_DEMO`.
- Server probes:
  - `capabilities/m4b`: `externalClashHold`, `eveningImpact`, `smartPostpone`;
  - `capabilities/m5a`: `calendarChoice`, `emailSources`;
  - `capabilities/m5b`: `memoryLearning`;
  - `capabilities/m6`: `searchHistory`;
  - `capabilities/m6b`: `memoryTranslation`;
  - `capabilities/features`: «الميزات».

**Errors the client maps**
- A 404 `feature_unavailable` becomes `FeatureUnavailableError` and hides the surface.
- A 429 becomes `QuotaExceededError` with scope `user_daily`, `user_minute`, `global_daily` or `user_monthly` (`src/api/errors.ts:348`; copy in `src/api/ui/userFacingMessage.ts`).
- **The client has no `cost_cap` handling.** QA must check what the server actually sends when a month's budget is spent.

**Global states**
- `OfflineBanner`: `offline-banner`, `offline-retry`.
- `QueryBoundary`: loading, error and retry. A 403 for revoked, deleted, consent_required, quiet_mode or feature_disabled shows a statement with no Retry.
- `ErrorBoundary`.
- Toast with undo.

## 1. Auth and onboarding

- **Language gate** (`src/features/language/LanguageGate.tsx`, `LanguageStep.tsx`): pick ar/en/he before sign-in. Maestro: `smoke.yaml`, `auth-gate.yaml`, `onboarding.yaml`.
- **Sign-in** (`src/screens/SignInScreen.tsx`, `src/auth/AuthGate.tsx`):
  - Google, Apple (behind its flag), email, create account, language switch.
  - After sign-in the app calls `POST devices`.
  - Tests: `src/auth/__tests__/*`.
- **Email auth** (`src/screens/EmailAuthScreen.tsx`): sign in, sign up, reset. The error never names a field, and reset answers the same whether or not the account exists.
- **Verify-email banner** (`src/auth/VerifyEmailBanner.tsx`).
- **Onboarding** (`src/features/onboarding/*`): Welcome → Consent (with Clarity) → Routine → About (SetupChat/SetupLife with voice, AI-import detour, AboutYou review) → Notifications (OS prompt).
  - API: `consents`, `consents/recommendations`, `pilot/trust`, `profile/routine`, `profile/describe` (+confirm), `profile/import` (+confirm), `analytics`.
  - States: `onboarding-consent-unreachable`, routine save failed, describe failed, `onboarding-about-review-empty`, `setup-answer-too-long`.

## 2. Today

- **Today** (`src/screens/TodayScreen.tsx`).
  - Actions: primary complete/postpone, row → details, swipe actions, groups, finished toggle, weekly occurrences, category filter, search, assistant.
  - Embedded components:
    - `NextStepCard` (accept, done, defer, dismiss, edit, why, prepare; `TodayEnergy`; `FeedbackFlagButton`);
    - `ProactiveInboxBanner`, `UpcomingPlanCard`, `TodayPlanRow`, `ConflictLine`, `DeadlineContext`, `BusyConflictChip`, `WeeklyOccurrenceRow`.
  - API: `commitments/today`, `commitments/upcoming`, `commitments/:id/actions`, `recommendations/next-step` (+actions), `plans/:d`, `plans/week`, `profile`, `consents`, `settings/categories`, `weekly-blocks/occurrences`, `calendar/busy`, `integrations/google/calendar`, `football`, `capabilities/m4b`, `capabilities/m5b`, `intelligence` (+generate), `goals/plans/upcoming`, `readiness`, `alpha/feedback`, `postpone-slots`.
  - States: `today-empty`, `today-all-done`, `today-quiet`, `today-quiet-hours`, `today-quiet-trust`.
  - Maestro: `today.yaml`, `next-step.yaml`.
- **Details** (`src/screens/DetailsScreen.tsx`).
  - Actions: done, postpone, drop, delete, edit (`EXPO_PUBLIC_FEATURE_SAFE_COMMITMENT_PATCH`), start, category, importance, history, prepare, place reminder.
  - States: `details-gone`, `details-closed-note`.
- **Sheets** (`src/screens/Sheets.tsx`).
  - Kinds: postpone (presets, custom, smart slots), edit, confirmDrop, confirmDelete, meetingPrep (`POST meetings/prepare`).
  - States: `postpone-slots-loading`, `postpone-slot-problem`, `postpone-problem`, `edit-problem`.

## 3. Capture and chat «احكيها»

- **Flow:** `src/features/capture/CaptureFlow.tsx`, `CaptureProvider.tsx`, `SayItChatPage.tsx`; screens `CaptureScreen`, `ReviewScreen` and `SavedScreen`.
  - Sheets: `ClarifySheet`, `ClipboardImportSheet`, `EditProposalItemSheet`, `SummaryEditSheet`.
  - Review blocks: `UnderstoodMessage`, `ProposalPointCards`, `SeedProposalSection`, `WeeklyChoice`, `ImpactBlock`.
- **Entry points:** the tab, `/capture?...`, the widget (voice), share, the goal/habit/seed chat entry, meeting prep and Drive import.
- **API:** `capture/chat`, `capture`, `capture/clarify`, `capture/confirm` (never retried), `capture/kinds`, `capture/impact`, `DELETE commitments/:id` (undo), `calendar/manual`, `seeds`, `analytics`.
- **States:** `capture-nothing`, `capture-error-*`, `capture-confirm-refused`, `capture-confirmed-elsewhere`, `review-none-selected`, `review-confirm-failed`, `saved-failed`, `saved-undo-partial`, `review-mailbox-partial`. On a quota error the typed text is kept.
- **Voice** (`src/features/capture/voice/*`): `voice-denied`, `voice-dictation-off`, `voice-note`; kill switch `EXPO_PUBLIC_KILL_SWITCH_VOICE`.
- **Maestro:** `capture.yaml`, `capture-edit.yaml`, `clarify.yaml`.

## 4. Plan

- **«الخطة»** (`src/screens/CalendarScreen.tsx`).
  - Actions: week strip, day, filter, search, free time, `WiderView`, `PlanDay` timeline, proposal → patch review, plan week, calendar settings.
  - States: `calendar-not-connected`.
- **Today's plan** (`src/screens/PlanScreen.tsx`).
  - Actions: build, accept, dismiss, regenerate, move, pick time, remove, why, morning plan.
  - API: `plans/:d` (+actions, build, regenerate, opened), `settings/plan`.
  - States: `plan-empty*`, `plan-generating`, `plan-offline-cold`, `plan-offline-readonly`, `plan-regenerate-capped`, `plan-regenerate-left`, `plan-build-failure`, `plan-edit-refused`, `plan-accept-refused`, `plan-day-over`.
  - Maestro: `plan.yaml`.
- **Week** (`src/features/plan/WeekScreen.tsx`).
  - API: `plans/week` (+accept), `calendar/busy`.
  - States: `week-empty`, `week-error-*`, `week-limit`, `week-waiting`, `week-noroom-*`.
- **Patch review** (`PatchReviewScreen` in `src/features/product/ControlScreens.tsx`): `patch-refused`.
- **Action modes / Add** (`ControlScreens.tsx`): navigation hubs only; weak tests.

## 5. My things and Watching

- **My things** (`src/features/things/ThingsScreen.tsx`).
  - API: `habits`, `seeds`, `commitments/search` (m6).
  - States: `things-recent-empty`, `m6-search-no-results`, `m6-search-more`.
- **Commitments list** and **contextual assistant**: `src/features/product/ContextScreens.tsx`.
- **Habits** (`HabitDetailScreen`, `HabitCadencePicker`): `habits` CRUD.
- **Seeds** (`src/features/seeds/SeedsScreen.tsx`): `seeds` CRUD and `seeds/:id/promote`; state `seeds-empty`.
- **Watching** (`src/features/watching/WatchingScreen.tsx`).
  - Contents: held items, `IntelligencePanel`, watches, pause all.
  - API: `trust/background-activity`, `held-items`, `capabilities/m4b`.
  - States: `watching-nothing`, `watching-no-watches`.
- **Background activity / watch builder** (`src/features/product/WatcherScreens.tsx`).
  - API: `trust/background-activity` (+attribution, history), `watchers` (+pause, delete), `football`.
  - States: `background-integrity`, `watch-team-none`.

## 6. Goals

- **Goals screen** (`src/features/goals/GoalExecutionScreen.tsx`) and the **plan flow** (`src/features/goalPlan/PlanFlow.tsx`, `AllTimesSheet.tsx`).
  - API: `goals/:id/execution` (+generate, regenerate, confirm, nodes), `goals/:id/plan` (+generate, regenerate, plans/:p, approve, times, batch, confirm, later), `goals/plans/upcoming`, `goals/from-statement/*`.
  - **The plan routes answer 404 everywhere today** (`MAYBESITTER_FEATURE_GOAL_PLAN` is unset).
- **IntelligencePanel** (`src/features/goals/IntelligencePanel.tsx`).
  - Actions: suggestions, questions, observations, Gmail scan, monitor on/off, backfill.
  - API: `intelligence` (+generate, observations, suggestions, answer), `intelligence/sources/gmail/monitor`, `intelligence/sources/gmail/scan`.

## 7. Memory

- **Knows** (`src/features/settings/KnowsScreen.tsx`, `src/features/memory/MemorySection.tsx`).
  - API: `profile`, `pilot/trust`, `memory`, `memory/summary`.
- **Memory** (`src/features/memory/MemoryScreen.tsx`).
  - Actions: edit, delete, delete all, suggestions, evidence, translate (m6b).
  - States: `memory-screen-empty`, `memory-screen-error`, `m6-translate-unavailable-*`.
  - Maestro: `memory.yaml`.
- **Personalization** (`ContextScreens.tsx`): consent, preferences, export.
- **AI import** (`src/features/aiImport/*`).
  - API: `profile/import` (+confirm).
  - States: `ai-import-refused`, `ai-import-read-failed`, `ai-import-save-failed`, `ai-import-nothing`, `ai-import-open-failed`.

## 8. Gmail

- **Google integration** (`src/features/google/GoogleIntegrationScreen.tsx`).
  - Actions: connect or reconnect per feature, disconnect, Calendar sync, Gmail scan (`src/features/m5a/emailScan.tsx`), Drive pick and import.
  - States: `google-not-configured`, `google-status-error`, `google-status-retry`, `google-status-reauth`, `email-scan-wait-*`, `email-scan-error`, `email-scan-reconnect`.
- **«انضاف من إيميلك»** (`src/features/m5a/AddedCard.tsx`): remove, load more.

## 9. Calendar

- **Calendar settings** (`src/features/settings/CalendarSettingsScreen.tsx`, `M5aCalendarSections.tsx`).
  - States: `calendar-permission-denied`, `calendar-none-writable`, `calendar-read-unavailable`, `calendar-write-unavailable`, `calendar-too-many-phones`, `calendar-save-failed`.
- **ICS links** (`src/features/calendarFeeds/CalendarFeedsScreen.tsx`).
  - Actions: subscribe, auto-accept, refresh, remove, deadline decisions, held items.
  - States: `ics-empty`, `ics-unavailable`, `ics-subscribe-error`, `ics-feed-error-*`.
- **Weekly blocks** (`src/features/weeklyBlocks/WeeklyBlocksScreen.tsx`).
- **Calendar demo** (dev only).

## 10. Football

- `src/features/settings/FootballSettingsScreen.tsx`: follow a club, fixtures, held fixtures. States: `football-save-failed`, `football-held-failure`.
- Sources hub: `SourcesScreen.tsx`.

## 11. Settings and «الميزات»

- **Hub** (`src/screens/SettingsScreen.tsx`). Five categories:
  - Day: routine, weekly blocks, energy/readiness and health, categories, financial.
  - Connections: integrations, AI import, calendar, sources, background.
  - Alerts: notifications, widget, places.
  - Privacy: personalization, knows, trust, activity.
  - App: language and appearance, account, about.
- **«الميزات»** (`FeaturesSettingsScreen.tsx`).
  - One switch per add-on; chips for on, off, needs subscription, allowance used and unavailable.
  - Hidden while the gate mode is `off`.
- **Notifications** (`NotificationsSettingsScreen.tsx`).
  - Settings: soft reminders, lead time, quiet hours, Must ceiling, hard ring, exact alarm, morning plan, continuous replan.
  - States: `notifications-denied`, `notifications-not-asked`, `must-exact-denied`, `must-ring-blocked`, `notifications-save-failed`.
- **Trust** (`TrustScreen.tsx`): consents, quiet mode, revoke, export, incident report.
- **Activity** and **feedback history**.
- **Other leaves:** language and appearance, about, widget settings, places.

## 12. Account

- `AccountScreen.tsx`: sign out runs `beforeSignOut` → `DELETE devices/:id`.
- `DeleteAccountScreen.tsx`: confirm, then re-auth, then Apple revoke, then `DELETE account`. The receipt is shown on `AccountDeletedScreen`.
- Maestro: `delete-account.yaml`.

## 13. Native

- **Widget:**
  - iOS: `targets/widget/*.swift`, iOS 17+, App Group `group.com.maybesitter.app`.
  - Android: `src/features/widget/android/*`.
  - Taps go to details, voice capture and Today. Titles are hidden unless enabled on that phone.
- **Share intent:** `expo-share-intent` (text, URL, up to 5 images, 1 file; on Android also PDF, zip and ics). Lands on `ShareScreen`, then `capture/share`, then review.
- **Notifications:**
  - Channels: general, awareness, hard.
  - Reminder actions: done, later, drop.
  - Exact alarms: `modules/exact-alarm`.
  - Routing: `routeFromNotification.ts`.
  - Calls: `reminders/receipts`.
- **Other native features:** voice (expo-speech-recognition), device calendar (expo-calendar), health (`modules/healthkit-readiness`, `modules/health-connect-readiness`), places (expo-location), clipboard, Clarity.

## Language, RTL and accessibility

- The language switch is live, with no restart. Direction is set in `src/Root.tsx` and `src/ui/DirectionRoot.tsx`.
- Copy lives in `src/i18n/locales/{ar,en,he}.json`.
- Text scale: `src/theme/textScale.ts`. Reduced transparency and reduced motion are handled.

## Known test gaps

- **No test at all:**
  - `src/features/nextStep/FeedbackFlagButton.tsx`
  - `src/features/today/DeadlineContext.tsx`
  - `src/features/onboarding/AiImportFlowStep.tsx`
  - the iOS widget UI (`targets/widget/NextStepWidget.swift`)
- **Weak coverage:** `ActionModesScreen`, `AddToMaybeSitterScreen`, `MyMaybeSitterScreen`, `IntegrationsScreen`, `ShareGuideSheet` (only `capabilityRows.test.tsx`).
- **Stale Maestro flows:**
  - `.maestro/feedback-history.yaml` taps `settings-history`, which no longer exists; the current ID is `activity-feedback-history`.
  - `.maestro/delete-account.yaml` taps «الإعدادات» as a tab, but Settings now opens from the avatar.
- **Placeholders:** the 50 `it.todo` cases in `src/__acceptance__/*/simulator.todo.test.*` are device checks that were never done.
