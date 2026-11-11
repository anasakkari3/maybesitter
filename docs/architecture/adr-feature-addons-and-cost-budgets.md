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
   - the Gmail jobs and the M5a scan, before a permit is reserved; the football projection and the fixture watchers in the per-minute sweep pass over a person who switched football off (the shared club poll still runs while anyone follows the club);
   - the add-on routes, which answer the existing 404 `feature_unavailable` (`lib/features/featureRoute.ts`) so installed apps already hide them;
   - `GET /api/mobile/capabilities/features` (+ `PUT …/[id]` for the person's switch), which the app reads to show or hide surfaces.
4. **Rollout mode** — `MAYBESITTER_ADDON_GATE_MODE`: `off` (default; reads and writes nothing, the product behaves exactly as before), `shadow` (decide and log `shadow_deny`, never obey), `enforce`. Staging is `shadow`, production `off`.
5. **Money** — integer nano-dollars (1¢ = 10⁷ n$). List prices in `lib/features/pricing.ts`: Gemini 2.5 Flash $0.30/M in, $2.50/M out. GCP Billing stays the source of truth.
6. **Holds, not read-then-charge** — under `enforce` a call holds its worst-case cost (all allowed output tokens, the prompt at two characters a token) in `users/{uid}/usage/spend-YYYY-MM` inside the transaction that checks the budget, then settles to the real cost or releases on failure; holds expire after 15 minutes. Every path that spends on the model holds: both providers and the services that call the gated provider directly (memory summary, memory translation, plan narration). `tests/features/featureSpendCoverage.test.ts` fails on a new direct spender.
7. **The free ceiling holds for everyone** over the features they use on a free allowance; a purchase raises only its own feature. `tests/features/catalog.test.ts` checks each purchase's added budget against its net after 18% VAT and a 30% store fee.
8. **A spent budget** refuses as `cost_cap:user_monthly` (new `QuotaScope 'user_monthly'`, waits until the next UTC month). Capture falls back to rules; M5a ends the scan as a spent day does, and resuming costs nothing because the check runs before any model call. An unreadable gate refuses under `enforce` only (same rule as `usageGuard`).

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

Free budgets sum to 40¢; an account with no purchase is also held by the account-wide free ceiling `MAYBESITTER_FREE_MONTHLY_CENTS` (default 40, clamped to the owner's 50¢). Every grant's budget is below what its price nets after a 30% store fee (`tests/features/catalog.test.ts` enforces it): base ₪10 ≈ $3, gmail_light $4, gmail_full $5 (owner direction: Gmail is $4–5, never $2), the $1 add-ons.

### Email triage (Gmail cost cut)

Owner idea, 2026-11-10: skim like a person. Stage 1 is the existing free bulk filter. Stage 2 scores From + Subject + the first lines for relevance and skips the full read below a threshold. Stage 3 is the full Gemini read. Stage 4 is the existing post-read filter (verbatim evidence, own text, single agreement sentence). See `lib/intelligence/emailTriage.ts`.

- Scorer: one Gemini call over From, Subject and the first 600 characters (`purpose: 'email_triage'`, its own 600/day action cap so it never eats the capture caps), only while budgets are enforced; no score means a full read. It fails open on quality.
- Self-replies, dated candidates and (rule 2) any reply or forward (`isConversationReply`) are never triaged out. A deterministic audit sample of skipped mail is read anyway, and a miss is logged content-free.
- `MAYBESITTER_EMAIL_TRIAGE_MODE` is `off` in both environments. The threshold defaults to 0.15 and is clamped to at most 0.5.
- **Jev was dropped (owner, 2026-11-11).** Its weights are closed and it is served only from the United States (TypeSafe, or gateways at the same price). jevai.org is a community site with no operator, terms or privacy policy, and it rejected every call. Its open twin Jeff (Qwen3.5-0.8B, English only, no commitment adapter) would beat Gemini only above roughly 230k mails a month, on a Cloud Run GPU batch job with a fixed floor. The client, its flags and its price were removed; Gemini is the only scorer.

### Golden-set run, 2026-11-11 (Gemini header scorer)

`scripts/run-email-triage-eval.ts`, run on 199 inbox mails from the owner's last 60 days (Promotions and Social tabs excluded) at the owner's order. Claude labelled them, not the owner: 9 hold a commitment, 19 are borderline, 171 hold nothing. The set and the per-mail report live outside the repository in `~/.config/maybesitter/golden-mail/` (0600). The scorer saw From, Subject and Gmail's snippet (about 150 characters), which is less than the 600 characters the scan sends, so the recall below is a lower bound.

- **The first run found a defect.** All 199 calls were billed (1.54¢), and none was scored. `maxOutputTokens: 16` cut every answer at `{"relevant_`, so the fallback could never skip a mail. It is now 64 (`TRIAGE_MAX_OUTPUT_TOKENS`, and a test pins ≥ 64).
- Second run cost 1.89¢ for 199 calls (≈ 0.0095¢ a mail):

  | Threshold | Mail skipped | Commitments missed | Borderline missed |
  |---|---|---|---|
  | 0.10 | 5% | 0 | 0 |
  | **0.15 (default)** | **85%** | **0** | 3 |
  | 0.30 | 85% | 1 | 3 |

  The three borderline mails missed at 0.15 are a CI failure notice, a shared course folder and a recruiter's thank-you.
- The one commitment missed at 0.30 was a lecturer's reply with the subject "Re:". It scored 0.2, one coarse step above the default. Rule 2 now reads every reply and forward. With that rule applied, none of the 9 commitments is skipped at any threshold up to 0.5.
- Limits:
  - Nine positives is a small sample.
  - The free bulk rule would already remove many of these job alerts before triage, so the saving on top of it is smaller than 85%.
  - Before enforce, re-run on full 600-character bodies and on the owner's own labels.

## Adding a feature

1. Add a manifest to `FEATURE_CATALOG`, with its purposes, budgets and grants.
2. Call `featureLockedResponse(uid, '<id>')` at the routes where it starts spending or showing.
3. If it spends through a provider, the purpose mapping charges it automatically. Pass `features: featureHooksFor('<id>', storage)` when the purpose alone does not say which feature.
4. Add its copy in the app's features screen.
5. Add a store product with the grant id.

The core never imports an add-on.

## Not done yet

- The store purchase flow: RevenueCat SDK in the app, products, and a webhook that writes the projection. iOS needs the Apple Developer account, which has not been bought. Until then `scripts/dev-grant-features.mjs` grants entitlements on the local emulator only.
- Showing `user_monthly` as its own scan status. M5a reports a spent month as the existing daily-limit state (checked once a day, before any Gmail call), and a switched-off add-on as `monitoring_off`.
- The Gemini triage scorer runs only while budgets are enforced; with the gate off or in shadow, the mail is read fully.

## Review

An independent review on 2026-11-10 found one P0 (three model paths outside the gate), five P1 and six P2 issues; all were fixed on the branch before merge (commits `4cc94528`, `f8556de5`).
