# Feature add-ons and cost budgets — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split MaybeSitter into an always-on core plus add-on features that each switch on and off per user (by entitlement and by the user's own choice), with a monthly spend budget in cents per feature, and cut Gmail reading cost with a relevance-scoring stage (Jev, with a Gemini header-only fallback).

**Architecture:** One feature catalog (`lib/features/catalog.ts`) names every feature, its tier, the entitlements that grant it, the model purposes it spends through, and its monthly budget per grant. One gate (`lib/features/featureGate.ts`) turns catalog + stored entitlements + user preferences + this month's spend into one decision. Four places ask the gate: the model providers (capture/share/M5a permit), the Gmail jobs, the add-on routes, and a new `/api/mobile/capabilities/features` route the app reads to show or hide surfaces. Everything is behind `MAYBESITTER_ADDON_GATE_MODE` (`off` default → today's behaviour, `shadow` → decide and log only, `enforce`).

**Tech Stack:** Next.js 15 route handlers, TypeScript, Firestore via `lib/storage` adapter, Node test runner (`npm test` explicit list), React Native/Expo app (`mobile/`, Jest), Vertex Gemini 2.5 Flash, TypeSafe Jev (`/v1/systemone`).

**Spec:** Owner direction of 2026-11-10 (session transcript; summarised in `docs/architecture/adr-feature-addons-and-cost-budgets.md`, written in Task 9) and the published proposal page "معمارية الإضافات المدفوعة".

## Global Constraints

- Default behaviour must not change: with no new env vars set, every route, job and model call behaves exactly as on `origin/main` `e6872992`.
- New flags are default-off and pinned off in production in `infra/cloudrun/flags.sh` (AGENTS.md §6 Stage B rules).
- Free tier ceiling: ≤ 50¢ per user per month (owner); internal default 40¢ (`MAYBESITTER_FREE_MONTHLY_CENTS`, default `40`).
- Money is stored as integer nano-dollars (1¢ = 10,000,000 n$). Price table (list prices, verify in GCP Billing): Gemini 2.5 Flash input 300 n$/token, output 2,500 n$/token; Jev input 42 n$/token, output 0.
- Quality rule (owner): a cost cut may never silently drop a commitment. Email triage fails open (unsure, error, timeout, no key → read fully); self-replies and pre-model candidate signals are never triaged out; a random audit sample of triaged-out mail is read anyway.
- No email content in logs or telemetry; cost records carry feature, provider, tokens and n$ only.
- Jev sends mail text to a US processor: provider default off, staging only, needs disclosure + DPA before any real user (record in the ADR).
- No paid model calls during development or tests. All provider calls are injected fakes.
- Every new test file goes into `package.json` `test` list in place (not re-sorted) and is `git add`-ed before running.
- Enumerating guards to update when adding collections/routes: `tests/account/topLevelDeletionCoverage.test.ts`, `tests/personalization/deletionScopeCoverage.test.ts`, `tests/auth/routeGuardCoverage.test.ts`, `tests/meta/testRegistration.test.ts`, mobile fixtures via `tests/mobile/exportMobileApiFixtures.test.ts`.

## Review Focus

- A user with an entitlement whose `expiresAt` has passed but whose stored status is still `active` → treated as not entitled.
- Gate storage unreadable (Firestore error) in `enforce` mode → model call refused (same rule as `usageGuard`: unknown spend is not permission), but in `off`/`shadow` never blocks.
- Month rollover at UTC midnight on the 1st → spend starts at zero; the previous month's document is not read.
- Jev returns a malformed body, a 429, or times out → fallback to Gemini header triage, then to a full read; never a skip.
- Free user with no entitlements spending across several features → the 40¢ account-wide free cap stops all budgeted features, not just one.

---

### Task 1: Pricing, ledger and catalog (`lib/features/*`)

**Files:**
- Create: `lib/features/pricing.ts`, `lib/features/catalog.ts`, `lib/features/spendLedger.ts`
- Modify: `src/extraction/llm/llmProvider.ts` (add `'email_triage'` to `LlmPurpose`)
- Test: `tests/features/catalog.test.ts`, `tests/features/spendLedger.test.ts`

**Interfaces — Produces:**
- `costNanoUsd(model: PricedModel, tokens: { promptTokens?: number; outputTokens?: number }): number` — `PricedModel = 'gemini-2.5-flash' | 'jev'`; unknown Gemini model ids price as `gemini-2.5-flash`.
- `type FeatureId = 'assistant' | 'gmail_reading' | 'meeting_prep' | 'goal_plans' | 'memory_translation' | 'football'` (exact list adjusted to features that exist on main; see Task 1 Step 1).
- `interface FeatureManifest { id; tier: 'core' | 'addon'; titleKey: string; purposes: readonly LlmPurpose[]; costFeature: CostFeatureKind; freeMonthlyCents: number; grants: Readonly<Record<string, number>>; userCanDisable: boolean }`
- `FEATURE_CATALOG: readonly FeatureManifest[]`, `featureManifest(id)`, `featureForPurpose(purpose: LlmPurpose, context?: { source?: 'gmail' }): FeatureId`
- `monthKey(now: Date): string` (`YYYY-MM`, UTC), `readMonthSpend(uid, opts)`, `recordFeatureSpend(uid, featureId, nanoUsd, opts): Promise<void>` (swallows storage errors like `commitUsage`), stored at `users/{uid}/usage/spend-YYYY-MM` with `expireAt` = first day of month+2.

- [ ] Step 1: tests — every `LlmPurpose` maps to exactly one feature; core features have `userCanDisable: false`; free budgets sum ≤ 40; `costNanoUsd('gemini-2.5-flash', {promptTokens: 1000, outputTokens: 100}) === 550_000`; `costNanoUsd('jev', {promptTokens: 1000}) === 42_000`; ledger adds per feature and total, month rollover isolates months, storage error is swallowed.
- [ ] Step 2: run, see fail. Step 3: implement. Step 4: run, pass. Step 5: commit.

Budgets (monthly cents): free — assistant 20, gmail_reading 15, meeting_prep 2, goal_plans 3; grants — `base`: assistant 100; `gmail_light`: gmail_reading 135; `gmail_full`: gmail_reading 270; `meeting_prep`: meeting_prep 30; `goal_plans`: goal_plans 30; `memory_translation`: memory_translation 20. Football: core-free, no budget (no model).

### Task 2: Entitlements, preferences and the gate

**Files:**
- Create: `lib/features/accountFeatures.ts` (stored projection + preferences), `lib/features/featureGate.ts`
- Modify: `lib/storage/paths.ts` (`FEATURES = 'features'`, user-scoped), deletion/coverage guard lists
- Test: `tests/features/featureGate.test.ts`

**Interfaces — Produces:**
- `type GateMode = 'off' | 'shadow' | 'enforce'`; `gateMode(): GateMode` (env, read per call).
- `saveEntitlementProjection(uid, projection: EntitlementProjection, opts)`; `setFeaturePreference(uid, featureId, enabled: boolean, opts)`.
- `decideFeature(uid, featureId, opts?: { now?; storage? }): Promise<FeatureDecision>` with `FeatureDecision = { featureId; mode; allowed; enforced: boolean; reason: 'core' | 'free_allowance' | 'entitled' | 'not_entitled' | 'user_off' | 'budget_spent' | 'free_cap_spent' | 'gate_unavailable'; monthlyBudgetCents; spentCents; remainingNanoUsd }`. `allowed` is the decision; `enforced` says whether callers must obey it (`mode === 'enforce'`).
- `listFeatureDecisions(uid, opts): Promise<FeatureDecision[]>`

- [ ] Steps: tests for each reason; expired entitlement; preference off for addon; core cannot be turned off; free cap across features; shadow returns `enforced:false`; storage failure → `gate_unavailable` and `allowed:false` only in enforce. Implement, pass, commit.

### Task 3: Model-call enforcement and spend recording

**Files:**
- Modify: `lib/llm/usageGuard.ts` (`ReservationOutcome += 'feature_budget'`, `QuotaScope += 'user_monthly'`, `retryAfterSecondsFor('user_monthly')` → next UTC month), `lib/llm/captureProvider.ts`, `lib/llm/shareProvider.ts`, `lib/intelligence/m5aGmailScan.ts` (before `reserveQuotaPermit`), `settleQuotaPermitSlot` spend recording.
- Test: `tests/features/featureEnforcement.test.ts`

- [ ] Steps: in enforce mode a denied feature never reaches `reserveCall`/the provider and surfaces `QuotaScope 'user_monthly'`; every answered call records n$ to its feature; off mode is byte-for-byte today's flow (provider fakes see identical calls). Commit.

### Task 4: Email relevance triage (Jev + Gemini header fallback)

**Files:**
- Create: `lib/intelligence/emailTriage.ts`, `lib/llm/jevClient.ts`
- Modify: `lib/intelligence/m5aGmailScan.ts` (stage after `preModelCandidateSignals`), marker outcome `'triaged'` with `triageScore`, counter `messagesSkippedTriage`.
- Test: `tests/intelligence/emailTriage.test.ts`

**Interfaces:** `scoreEmailRelevance(uid, input: { from: string | null; subject: string | null; body: string }, deps): Promise<{ probability: number; scorer: 'jev' | 'gemini_header' } | null>`; env: `MAYBESITTER_EMAIL_TRIAGE_MODE` (`off`|`shadow`|`enforce`, default off), `MAYBESITTER_EMAIL_TRIAGE_THRESHOLD` (default `0.15`), `MAYBESITTER_EMAIL_TRIAGE_AUDIT_RATE` (default `0.05`), `MAYBESITTER_JEV_API_KEY`, `MAYBESITTER_JEV_BASE_URL` (default `https://api.typesafe.ai`), `MAYBESITTER_JEV_MODEL` (default `jev-latest`).

- [ ] Steps: Jev request shape `{model, state, questions:{relevant:{type:'noul', instructions}}}` → reads `answers.relevant.noul`; Jev failure → Gemini header call (`purpose 'email_triage'`, From + Subject + first 600 chars, `maxOutputTokens` 16); both fail → null → full read; self-reply/candidate → never scored; enforce + p < threshold + not audited → marker `done/triaged`, no model call; shadow → always read; spend recorded under `gmail_reading`. Commit.

### Task 5: Gmail jobs and add-on routes ask the gate

- Gmail jobs skip users whose `gmail_reading` decision is enforced-denied; Gmail scan/monitor start routes return `403 {success:false, error:'feature_locked', feature}`; meeting prep / goal plan / memory translate routes rely on Task 3 and map `user_monthly`.
- Tests in `tests/features/featureRoutes.test.ts`. Commit.

### Task 6: `/api/mobile/capabilities/features` (GET list, PUT preference)

- Response `{ success: true, mode, features: [{ id, tier, enabled, reason, userCanDisable, usedPercent }] }` (no cents to the client); PUT body `{ enabled: boolean }` on `[id]`. Update route-count guard and fixtures export. Commit.

### Task 7: Mobile — features client, hook, settings screen, locked states

- Skills: `design-design-system`, `design-accessibility-review`, `design-ux-copy`; final `design-design-critique`.
- Zod schema + `getFeatures`/`setFeatureEnabled` in `mobile/src/api`, `useFeatures` hook, a «الميزات» section in Settings (core vs add-ons, toggle for add-ons, usage bar), Gmail entry shows locked state when `enabled:false`; `QuotaScope 'user_monthly'` + `feature_locked` error mapping with ar/en/he copy. Jest tests. Commit.

### Task 8: Flags, dev grant script, ADR

- `infra/cloudrun/flags.sh`: new env vars, production pinned `off`; `scripts/dev-grant-features.ts` (refuses unless emulator/memory storage and non-production env); `docs/architecture/adr-feature-addons-and-cost-budgets.md`. Commit.

### Task 9: Whole-branch verification

- `npm test`, `npm run typecheck`, `npm run check:test-registration`, `npm run check:no-flutter`, mobile `npx tsc --noEmit` + targeted jest (`--maxWorkers=4`) + `npx expo lint`; simulator run of the app on the branch with screenshots; independent review; stop every process started.
