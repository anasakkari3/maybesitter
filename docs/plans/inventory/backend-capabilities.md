# Backend capability inventory (main `de7fcb84`, 2026-11-12)

Read from the code, not run. Routes live in `src/app/api/**`.

## Facts that change how you test

1. **Cloud Run serves only some paths.** `src/middleware.ts` serves only these and answers 404 to everything else, including every legacy web route:
   - `/api/mobile/*`
   - `/api/health*`
   - `/api/internal/*`
   - `/api/early-access` and `/api/early-access/events`
   - `/api/oauth/google/{callback,picker}`
2. **Every model call needs AI consent** (`PUT /api/mobile/consents/ai-processing`, checked in `lib/llm/consentGatedProvider.ts`).
   - Caps from `lib/llm/usageGuard.ts`: 60 calls per user per day, 150k tokens per user per day, 8 calls per user per minute.
   - Global cap: 3000 a day on staging, 500 in production.
   - Without consent or quota, routes fall back to rules.
3. **Goal-plan routes answer 404 in both environments.** `MAYBESITTER_FEATURE_GOAL_PLAN` is set nowhere.
4. **The add-on gate never refuses today.** `MAYBESITTER_ADDON_GATE_MODE` is `shadow` on staging and `off` in production, and `refuses()` is true only under `enforce`.
5. **Many flags are env-locked.** These allow only local, test and staging in code: `CAPTURE_KINDS`, `FREE_SLOTS`, `EXTERNAL_CLASH_HOLD`, `EVENING_IMPACT`, `SMART_POSTPONE` (m4b), `CALENDAR_CHOICE`, `EMAIL_SOURCES` (m5a), `MEMORY_LEARNING` (m5b), `SEARCH_HISTORY` (m6), `MEMORY_TRANSLATION` (m6b) and `goalPlan`.
6. **Priority ordering is off.** `MAYBESITTER_FEATURE_PRIORITY` is unset, so Today uses plain ordering.

## `/api/mobile/**` by area

In the tables: $ = can call Gemini; N = no model call.

**Auth, trust and analytics**
- There is no login route: the client sends a bearer Firebase ID token, checked by `lib/auth/tokenVerifier.ts` (revocation cache of 60 s).

| Route | Methods | $ | Gate |
|---|---|---|---|
| `pilot/trust` | GET POST | N | — |
| `pilot/incidents` | POST | N | — |
| `analytics` | POST | N | — |
| `alpha/feedback` | — | N | `MAYBESITTER_ALPHA_FEEDBACK_ENABLED` (unset, so off) |
| `alpha/trace` | — | N | `MAYBESITTER_ALPHA_TRACE_ENABLED` (unset, so off) |
| `readiness` | GET PUT POST | N | — |
| `activity`, `activity/summary` | — | N | — |
| `trust/background-activity` (+`history`, `attribution`) | — | N | — |

**Capture**

| Route | Methods | $ | Gate |
|---|---|---|---|
| `capture` | POST | capture_extraction | — |
| `capture/clarify` | POST | capture_extraction | — |
| `capture/confirm` | POST | N | — |
| `capture/chat` | POST | capture_chat | — |
| `capture/kinds` | GET | N | `CAPTURE_KINDS` + memory module |
| `capture/impact` | POST | N | m4b eveningImpact |
| `capture/share` | POST | share_extraction | `SHARE_INTAKE_ENABLED` |
| `seeds` (+`[id]`, `[id]/promote`) | — | N | capture module |

**Commitments**

| Route | $ | Gate |
|---|---|---|
| `commitments/today`, `commitments/upcoming` | N | ranked by priority only if the flag is on |
| `commitments/[id]` (GET PATCH DELETE) | N | — |
| `commitments/[id]/actions` | N | smart postpone needs m4b and the HMAC key |
| `commitments/[id]/postpone-slots` | N | m4b smartPostpone |
| `commitments/[id]/device-calendar-link` | N | — |
| `commitments/search` | N | m6 + add-on `search_history` |
| `habits` (+occurrences complete and skip) | N | — |
| `weekly-blocks` (+occurrences) | N | — |
| `reminders/receipts` | N | — |

**Plans**

| Route | $ | Notes |
|---|---|---|
| `plans/[date]` (GET) | plan_explanation, only when it builds | — |
| `plans/[date]/build`, `plans/[date]/regenerate` | plan_explanation | — |
| `plans/[date]/actions`, `/opened`, `/cause` | N | — |
| `plans/week` | N | — |
| `plans/week/accept` | Y\* | — |

\* The service map marks the call; this note does not say which purpose it bills.

**Goals**

| Route | $ | Gate |
|---|---|---|
| `goals/[id]/plan/*` (12 routes) | goal_decomposition | `goalPlan` module (off everywhere) + add-on `goal_plans` |
| `goals/[id]/execution` (+generate, regenerate) | goal_decomposition | add-on `goal_plans` only |
| `goals/[id]/execution/confirm`, `nodes/[nodeId]` | N | — |

**Memory and profile** (all need the memory module, which is on in both environments)

| Route | $ | Gate |
|---|---|---|
| `memory` (+`[id]`, `suggestions/[ruleId]`) | N | — |
| `memory/summary` | memory_summary | m5b + add-on |
| `memory/[id]/translation` | memory_translate | m6b + add-on |
| `profile`, `profile/routine` | N | — |
| `profile/describe` (+confirm) | profile_extraction | — |
| `profile/import` (+confirm) | ai_context_import | — |

**Next step**

| Route | $ | Gate |
|---|---|---|
| `recommendations/next-step` (+actions) | N | recommendation module; arm `personalized` |
| `feedback/history`, `feedback/[id]/revoke` | N | — |
| `meetings/prepare` | meeting_prep | add-on |

**Proactive intelligence** (all behind `intelligenceEnabled()`, which is on in both environments)

| Route | $ |
|---|---|
| `intelligence` (POST analyze) | semantic_observation |
| `intelligence/generate` | semantic_observation |
| `intelligence/suggestions/[id]` | N |
| `intelligence/suggestions/[id]/answer` | semantic_observation |
| `intelligence/observations/[id]` | N |
| `intelligence/added` (+DELETE `[autoAddId]`) | N |

**Gmail**

| Route | $ | Gate |
|---|---|---|
| `intelligence/sources/gmail/monitor` | N directly; the job spends | AI consent + add-on `gmail_reading` |
| `intelligence/sources/gmail/scan` | capture_extraction, semantic_observation, and email_triage when on | AI consent + add-on; `m5:true` also needs `system/m5aControls.email.enabled` |
| `integrations/google/gmail/scan` | share_extraction | add-on `gmail_reading` |

**Google and calendar**
- Routes need the OAuth client, secret and KMS key, or they answer `not_configured`.
- Google: `integrations/google` (+connect, callback, disconnect, calendar, drive/picker, drive/import, which spends share_extraction).
- Calendar:
  - `calendar/busy`; free slots need m4a.
  - `calendar/busy/{sources,intent,register}` and `calendar/choice` need m5a calendarChoice.
  - `calendar/manual`, `settings/calendar`.
- ICS feeds (`ICS_FEEDS_ENABLED`, KMS): `calendar/ics` (+`[feedId]`, `refresh` with a 5-minute cooldown, `deadlines/[itemKey]`). `held-items` needs m4b.
- Scopes: `calendar.freebusy`, `gmail.readonly`, `drive.file`, `openid`, `userinfo.email`.

**Football**
- `football` (add-on; `FOOTBALL_DATA_API_KEY`), `football/held/[fixtureId]` (m4b), `football/fixtures/[commitmentId]`.

**Capabilities**
- `capabilities/features` (+`[id]` PUT), `capabilities/m4b`, `m5a`, `m5b`, `m6`, `m6b`.

**Push**
- `devices` (+`[installationId]`), `settings/reminders`. The jobs send `plan_ready` and `hard_reminder`.

**Account**
- `account` DELETE (forced revocation check; receipt pepper), `account/export` GET.

**Consents**
- `consents`, `consents/ai-processing`, `consents/personalization`, `consents/recommendations`.

**Settings and watchers**
- `settings/categories`, `settings/monitoring`, `settings/plan`.
- `watchers` (+`[id]`, `pause`, `history`).

**Financial**
- `financial/connection` (sandbox only), `financial/context`, `financial/manual`.

## Internal jobs

All are POST and authenticated by Scheduler OIDC (`lib/auth/schedulerOidc.ts`).

| Route | Job | Schedule | $ |
|---|---|---|---|
| `/api/internal/jobs/run` | `jobs-tick-*` | every minute | N |
| `/api/internal/jobs/daily-plan` | `daily-plan-tick-*` | every minute | plan_explanation |
| `/api/internal/jobs/hard-reminders` | `hard-reminders-tick-*` | every minute | N |
| `/api/internal/jobs/watchers` | `watcher-sweep-*` | every minute | N |
| `/api/internal/jobs/replan` | `replan-tick-*` | every 5 minutes | N |
| `/api/internal/calendar/ics/refresh` | `ics-feed-refresh-*` | every 30 minutes | N |
| `/api/internal/jobs/football-sync` | `football-sync-daily-*` | 01:00 Jerusalem | N |
| `/api/internal/jobs/maintenance` | `maintenance-daily-*` | 03:17 Jerusalem | N |
| `/api/internal/jobs/intelligence-gmail` | `intelligence-gmail-*` | every minute | Y |
| `/api/internal/jobs/intelligence-gmail-sweep` | `intelligence-gmail-sweep-*` | every minute (staging only live) | Y |
| `/api/internal/m5a-controls` | none (scripts) | — | N |

## Flags (`infra/cloudrun/flags.sh`)

Production versus staging:
- **On in both:** PROACTIVE_LOOP, MEMORY, RECOMMENDATION, ICS_FEEDS_ENABLED and SHARE_INTAKE_ENABLED.
- **Off in production, on in staging:** CAPTURE_KINDS, FREE_SLOTS, the three m4b flags, CALENDAR_CHOICE, EMAIL_SOURCES, MEMORY_LEARNING, SEARCH_HISTORY and MEMORY_TRANSLATION.
- **Different values:**

  | Flag | Production | Staging |
  |---|---|---|
  | `ADDON_GATE_MODE` | off | shadow |
  | `LLM_GLOBAL_DAILY_CALL_CAP` | 500 | 3000 |
  | Maximum instances | 3 | 2 |

- **Same in both:** `EMAIL_TRIAGE_MODE` off, `FREE_MONTHLY_CENTS` 40, model gemini-2.5-flash in europe-west1.

## Existing test tooling

- **Unit and route tests:**
  - `npm test` runs 614 files (Node test runner).
  - `npm run test:emulator` runs 27 files against Firestore and Auth emulators.
  - Acceptance suites are in `tests/acceptance/m*/` (dynamic route imports).
- **Routes with no route-level test:**
  - the internal job routes (only their handlers are tested);
  - the ICS `[feedId]` routes;
  - the alpha routes;
  - the financial routes.
- **Thin coverage (one file each):** the m5a calendar routes, `capabilities/*`, `capture/impact`, `postpone-slots`, `held-items`, `football/held`, Google drive and gmail, `intelligence/added*` and `meetings/prepare`.
- **Live and black-box scripts** (`scripts/`): `blackbox-staging-api.mjs` (creates a synthetic Firebase account against `STAGING_CANDIDATE_URL`), `live-capture-check.ts`, `verify-goal-steps-live.ts`, `verify-meeting-prep-live.ts`, `verify-durability.ts`, `run-*-eval.ts`, `seed-dense-account.mjs`, `dev-grant-features.mjs`.
