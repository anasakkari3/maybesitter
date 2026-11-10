# ADR: Feature add-ons and monthly cost budgets

Status: accepted for engineering, 2026-11-10. Release-locked (default off, production pinned off) until the owner releases it.
Owner direction: session of 2026-11-10. Implementation plan: `docs/superpowers/plans/2026-11-10-feature-addons.md`.

## Context

The owner wants the subscription to become a bundle of per-feature subscriptions: a core that always works, add-ons that each switch on and off per person, new add-ons pluggable at any time, and no cost the business cannot recover from customers. Before this change every feature switch was a per-environment flag (`infra/cloudrun/flags.sh`, `system/m5aControls`), model caps were the same for everyone (`lib/llm/usageGuard.ts`), and the entitlement judgement (`lib/integrations/revenuecat/entitlements.ts`) was used only by `lib/packs`.

## Decision

1. **One catalog** — `lib/features/catalog.ts` lists every feature: tier (`core` | `addon`), the model purposes it spends through, its free monthly budget in cents (`null` = purchase required), the budget each store grant gives it, and whether the person may switch it off. Nothing else describes a feature.
2. **One decision** — `lib/features/featureGate.ts` combines the stored entitlement projection, the person's own switches (`users/{uid}/features/{entitlements,preferences}`) and this month's spend (`users/{uid}/usage/spend-YYYY-MM`) into one `FeatureDecision`. Nothing else reads those documents to decide.
3. **Four enforcement points** ask it:
   - the model providers (`captureProvider`, `shareProvider`), before the daily reservation, and charge the feature after the call answers (`lib/features/providerGate.ts`);
   - the Gmail jobs and the M5a scan, before a permit is reserved;
   - the add-on routes, which answer the existing 404 `feature_unavailable` (`lib/features/featureRoute.ts`) so installed apps already hide them;
   - `GET /api/mobile/capabilities/features` (+ `PUT …/[id]` for the person's switch), which the app reads to show or hide surfaces.
4. **Rollout mode** — `MAYBESITTER_ADDON_GATE_MODE`: `off` (default; reads and writes nothing, the product behaves exactly as before), `shadow` (decide and log `shadow_deny`, never obey), `enforce`. Staging is `shadow`, production `off`.
5. **Money** — integer nano-dollars (1¢ = 10⁷ n$). List prices in `lib/features/pricing.ts`: Gemini 2.5 Flash $0.30/M in, $2.50/M out; Jev $0.042/M in, output free. GCP Billing stays the source of truth.
6. **A spent budget** refuses as `cost_cap:user_monthly` (new `QuotaScope 'user_monthly'`, waits until the next UTC month). Capture falls back to rules; M5a ends the scan as a spent day does, and resuming costs nothing because the check runs before any model call. An unreadable gate refuses under `enforce` only (same rule as `usageGuard`).

### Budgets (monthly, cents)

| Feature | Tier | Free | Grants |
|---|---|---|---|
| assistant (capture, chat «احكيها», share, profile, plan narration) | core | 18 | base 100 |
| gmail_reading (M5a scan, monitor, auto-add extraction, triage) | add-on | 15 | gmail_light 135, gmail_full 270 |
| meeting_prep | add-on | 2 | meeting_prep 30 |
| goal_plans | add-on | 3 | goal_plans 30 |
| memory_learning | add-on | 2 | memory_plus 20 |
| memory_translation | add-on | — | memory_plus 20 |
| search_history, football | add-on | free, no model | — |

Free budgets sum to 40¢; an account with no purchase is also held by the account-wide free ceiling `MAYBESITTER_FREE_MONTHLY_CENTS` (default 40, clamped to the owner's 50¢). Every grant's budget is below what its price nets after a 30% store fee (`tests/features/catalog.test.ts` enforces it): base ₪10 ≈ $3, gmail_light $3, gmail_full $5, the $1 add-ons.

### Email triage (Gmail cost cut)

Owner idea, 2026-11-10: skim like a person. Stage 1 is the existing free bulk filter. Stage 2 scores From + Subject + the first lines for relevance and skips the full read below a threshold. Stage 3 is the full Gemini read. Stage 4 is the existing post-read filter (verbatim evidence, own text, single agreement sentence). See `lib/intelligence/emailTriage.ts`.

- Scorer order: TypeSafe Jev through jevai.org (`MAYBESITTER_JEV_URL`, `MAYBESITTER_JEV_MODEL`, secret `MAYBESITTER_JEV_API_KEY`), then a Gemini header-only call (`purpose: 'email_triage'`, its own 600/day action cap so it never eats the capture caps), then a full read. It fails open on quality.
- Self-replies and dated candidates are never triaged out. A deterministic audit sample of skipped mail is read anyway, and a miss is logged content-free.
- `MAYBESITTER_EMAIL_TRIAGE_MODE` is `off` in both environments. The threshold defaults to 0.15 and is clamped to at most 0.5.
- **Before any real user:** Jev runs in the United States. It needs a DPA with SCCs, an update to the processor disclosure, and a before/after run on an owner-labelled mail set showing zero lost commitments. On 2026-11-10 the owner's jevai.org key authenticated (`tools/list` worked) but `tools/call` answered "credentials or model access were rejected", and REST `/api/v1/decisions` returned 502. No live decision has been observed yet.

## Adding a feature

1. Add a manifest to `FEATURE_CATALOG`, with its purposes, budgets and grants.
2. Call `featureLockedResponse(uid, '<id>')` at the routes where it starts spending or showing.
3. If it spends through a provider, the purpose mapping charges it automatically. Pass `features: featureHooksFor('<id>', storage)` when the purpose alone does not say which feature.
4. Add its copy in the app's features screen.
5. Add a store product with the grant id.

The core never imports an add-on.

## Not done yet

- The store purchase flow: RevenueCat SDK in the app, products, and a webhook that writes the projection. iOS needs the Apple Developer account, which has not been bought. Until then `scripts/dev-grant-features.mjs` grants entitlements on the local emulator only.
- Per-user filtering of the football poll and the watcher sweep for a switched-off football add-on. The routes and the UI respect the switch; the background poll does not yet.
- Showing `user_monthly` as its own scan status. M5a reports a spent month as the existing daily-limit state.
