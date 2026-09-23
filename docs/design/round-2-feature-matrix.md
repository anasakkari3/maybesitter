# Round 2 — feature → backend → current UI → R2 UI → status

The inventory §5/§6 asked for, built from the repository (three read-only
sweeps on 2026-09-22, each claim spot-checked against the source before it
was used). This is the document that says what may be deleted and what may
not. Statuses are updated as phases land.

**Status key** — `R2 done` migrated to Round 2 and wired to the real contract ·
`R2 pending` has an R2 design, not yet migrated · `R2 new` no R2 design; an R2
surface designed and built here · `contextual` lives inside another surface ·
`background` no UI by design · `kept R1` intentionally left on the Round-1
chrome for now · `gap` a real feature with no client or no route.

## Core loop

| Feature | Backend | Current UI | R2 UI | Status |
|---|---|---|---|---|
| Today list, grouped Must/Should/Nice + Finished | `GET /commitments/today` → `useToday` | `TodayScreen` | Today (rest of day) | **R2 done** — groups kept (#169), Round-2 rows |
| "What matters now" (one primary) | next-step + today + plan, reconciled client-side (`composeToday`) | three competing cards | Today primary card | **R2 done** — one answer, cache contract closed |
| Next step (accept/edit/defer/dismiss/done, why, flag) | `GET/POST /recommendations/next-step[/actions]` | `NextStepCard` | Today primary | **R2 done** |
| Plan entry from Today | `GET /plans/{date}` | `TodayPlanCard` (vanished on load/error/dismissed) | Today plan row | **R2 done** — honest six-state row |
| Later (coming days on Today) | `GET /commitments/upcoming` | — | Today "later" | **R2 done** |
| Busy-conflict chip | device calendar cache | Today/Review chips | Today rows | **R2 done** (kept) |
| Category filter bar | `GET/PUT /settings/categories` | `CategoryBar` | — (not in R2) | **kept** on Today; R2 has no equivalent |
| Swipe / assistive row actions | `POST /commitments/{id}/actions` | `RowActions` | row circle + chevron | **R2 done** — circle added, swipe kept |
| Capture (text, voice, paste, examples) | `POST /capture` | `CaptureScreen` | capture task | **R2 pending** (Phase D) |
| Clarification question | `POST /capture/clarify` | `ClarifySheet` | `clarify` sheet | **R2 pending** (D) — server's own question, kept |
| Review (select, edit item, readings, confirm) | confirm payload | `ReviewScreen`, `EditProposalItemSheet` | review step | **R2 pending** (D) — protected experience |
| Saved + undo window | `POST /capture/confirm`, `DELETE /commitments/{id}` | `SavedScreen` | saved step | **R2 pending** (D) — protected |
| Share intake (text/link/PDF/images/chat/.ics) | `POST /capture/share` (flag) | `ShareScreen` | share task | **R2 pending** (J) |
| Commitment details | `GET /commitments/{id}` (ETag) | `DetailsScreen` | details | **R2 pending** (E) |
| Edit title/time/no-time | `PATCH /commitments/{id}` (If-Match, flag) | `EditSheet` | `edit` sheet | **R2 pending** (E) |
| Category on a commitment | same PATCH | `CategoryRow` | — | **contextual** in details (E) |
| Complete / postpone / drop / delete | `POST …/actions`, `DELETE` | details + sheets | details + `postpone` sheet + dialogs | **R2 pending** (E) — protected postpone sheet |
| Reopen a completed commitment | **no route** (`complete\|postpone\|cancel\|aware` only) | — | details "reopen" | **gap** — R2 designs it; backend follow-up (#173) |
| Daily plan: proposal / accepted / dismissed, explanation, kept-for-later | `GET /plans/{date}`, `POST …/actions` | `PlanScreen` | plan | **R2 pending** (F) |
| Plan build / regenerate (cap) | `POST …/build`, `…/regenerate` (429) | `PlanScreen` | plan | **R2 pending** (F) |
| Plan item move / take off | `POST …/actions {edit}` | `PlannedRow` + picker | `planMove` sheet | **R2 pending** (F) |
| Morning plan delivery setting | `GET/PUT /settings/plan` | Notifications settings | `morning` (stub) | **R2 new** (I) |
| Calendar (week strip, day list) | today + upcoming | `CalendarScreen` | calendar | **R2 pending** (G) — busy hatch to add |
| Device calendar write (flag) | `GET/PUT /settings/calendar`, device-calendar-link | `CalendarSettingsScreen` | `calendarSettings` (stub) | **R2 new** (G) |
| Device calendar read → busy | `POST/DELETE /calendar/busy` | headless + settings | — | **background** + settings (G) |
| ICS feeds (flag) | `/calendar/ics/**` | `CalendarFeedsScreen` | `feeds` (stub) | **R2 new** (G) |
| Google Calendar OAuth demo | none (Google direct), dev-only | `CalendarDemoScreen` | — | **kept R1**, dev-only, unreachable in release |
| Provider connections (Gmail…) | libs + transport exist, **no API route, no client** | — | — | **gap** — outside this migration; owner decision |
| Football: follow clubs, dismiss fixtures | `GET/PUT /football`, `DELETE …/fixtures/{id}` | `FootballSettingsScreen` | — (seed has CLUBS, no UI) | **R2 new** (I) |

## Trust, memory, settings

| Feature | Backend | Current UI | R2 UI | Status |
|---|---|---|---|---|
| Settings root | — | 13-row flat list | 4 groups | **R2 pending** (I) — grouped, progressive disclosure |
| Appearance (cycle) | device | row tap cycles | `langAppearance` (stub) | **R2 new** (I) — picker, not a cycle |
| Language (cycle) | device | row tap cycles | `langAppearance` (stub) | **R2 new** (I) — picker |
| Routine (5 questions) | `PUT /profile/routine` | `RoutineSettingsScreen` | `routine` (stub) | **R2 new** (I) |
| Readiness / energy | `GET/PUT /readiness` | `ReadinessSettingsScreen` | `energy` (stub) | **R2 new** (I) — renamed; see names map |
| HealthKit / Health Connect readiness adapters | — | **unwired** | — | **gap** — adapters exist, nothing imports them |
| Categories + filter-bar toggle | `GET/PUT /settings/categories` | `CategorySettingsScreen` | `categories` (stub) | **R2 new** (I) |
| Reminders (gentle, lead, quiet hours, must ceiling, hard ring, through-quiet, permission, exact alarms) | `GET/PUT /settings/reminders`, `POST /reminders/receipts`, `/devices` | `NotificationsSettingsScreen` | `reminders` (stub) | **R2 new** (I) |
| Notification permission request | OS + `/devices` | in Notifications settings | `permission`/`notif` (unbuilt) | **R2 new** (I/K) |
| Home-screen widget (titles opt-in) | device | `WidgetSettingsScreen` | `widget` (stub) | **R2 new** (I) |
| Trust & privacy (4 consents, quiet mode, calendar consent, revoke, export-unavailable) | `/consents/*`, `POST /pilot/trust` | `TrustScreen` | `trust` (stub) | **R2 new** (H) |
| What it knows (counts + never-lines) | `GET /pilot/trust` | `KnowsScreen` | `knows` (stub) | **R2 new** (H) |
| Memory: list, provenance, confidence, edit, delete+undo, delete-all, suggestions, adaptive card | `/memory`, `/memory/{id}`, `/memory/suggestions/{ruleId}` | `MemoryScreen`, `MemorySection` | `memory` (stub) | **R2 new** (H) |
| Data export | **no route** | "not available yet" card | — | **gap** — honest card kept |
| Activity + weekly summary + moments | `GET /activity`, `/activity/summary` | `ActivityScreen` | `activity` (stub) | **R2 new** (I) |
| Feedback history + revoke, next-step answers | `GET /feedback/history`, `POST …/revoke` | `FeedbackHistoryScreen` | — | **contextual** → folded into Activity (I) |
| About, legal links, test-crash rows | env | `AboutScreen`, `LegalLinks` | `about` (stub) | **R2 new** (I) |
| Account: email, sign-out, delete | Firebase, `DELETE /account` | Settings card, `DeleteAccountScreen` | `account` (stub), `deleteAccount` (unbuilt) | **R2 new** (L) |
| Deleted receipt | `DELETE /account` response | `AccountDeletedScreen` (above auth gate) | `deleted` (unbuilt) | **R2 new** (L) |
| Email verification banner | Firebase | `VerifyEmailBanner` | — | **kept**, Root banner |

## Entry and system

| Feature | Backend | Current UI | R2 UI | Status |
|---|---|---|---|---|
| Language gate (first run) | device | `LanguageStep` | `onboarding:lang` (unbuilt) | **R2 new** (K) |
| Sign in: Google / Apple (flag) / email + reset | Firebase | `SignInScreen`, `EmailAuthScreen` | `auth` (unbuilt) | **R2 new** (K) |
| Session expiry / 401 / 403 sign-out notice | client | sign-in notice | `revoked` scenario | **R2 new** (K) |
| Re-auth for deletion | `DELETE /account` 401 | in `DeleteAccountScreen` | `reauth` scenario | **R2 new** (L) |
| Onboarding: welcome, consent, routine, life narrative + setup chat, about-you review, notifications education | `/consents/*`, `/profile/routine`, `/profile/describe[/confirm]` | `features/onboarding/*` | `onboarding` (unbuilt) | **R2 new** (K) |
| Offline banner, query offline posture | `onlineManager` | `OfflineBanner` | `offline` scenario | **kept**; R2 banner treatment (M) |
| Error / loading / empty grammar | — | `QueryBoundary` + 7 hand-rolled empties | `error`/`loading`/`empty` scenarios | **R2 done** for Today; rolling out per phase (M) |
| Crash boundary | — | `ErrorBoundary` | — | **kept** |
| Deep links + notification taps | — | `links.ts`, `routeFromNotification` | routes | **R2 done** — arrivals with Today underneath (Phase B) |
| Android hardware back | — | **none** | — | **R2 done** (Phase B) |
| Push device registration, before-sign-out tasks, mock adapter, release guard, Maestro suite | various | headless | — | **background** |
| Design gallery (dev) | — | `Gallery` | `gallery` (unbuilt) | **kept R1**, dev-only |

## Backend routes with no client

`watchers/**`, `pilot/incidents`, `alpha/trace`, `POST /readiness`. None are
launch UX; recorded so they are not mistaken for orphaned features of the app.

## Internal concept → user-facing name (Arabic primary)

| Internal | Today (ar) | Round 2 (ar / en / he) | Note |
|---|---|---|---|
| Readiness | الجاهزية | طاقتك اليوم / Your energy today / האנרגיה שלך היום | jargon → what the screen actually asks |
| Trust centre / `trust` | مركز الثقة | الثقة والخصوصية / Trust & privacy / אמון ופרטיות | one name for row and screen |
| Memory / `knows` | شو بيعرف MaybeSitter | شو بيعرف عنك / What it knows about you / מה הוא יודע עליך | R2's own copy |
| Feedback history | السجل → «شو تعلّمه منك» | folded into نشاطي (Activity) | two history rows → one |
| Notifications / reminders | الإشعارات → «التذكيرات» | التذكيرات / Reminders / תזכורות | row = screen |
| Categories | التصنيفات | أجزاء حياتك / Parts of your life / תחומי החיים | in-screen copy promoted |
| Widget | ويدجت الشاشة الرئيسية | الشاشة الرئيسية / Home screen / מסך הבית | drops the transliteration |
| Quiet mode (trust) vs quiet hours (reminders) | وضع الهدوء / ساعات الهدوء | kept distinct, explained where each lives | two concepts, two places |

Domain identifiers are untouched; this table is the traceability.
