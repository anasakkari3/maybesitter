# ADR — Separation of Stage B Engineering and Release Gates

## Status

Accepted (Owner Decision — 2026-09-29).

## Context

Previously, Stage B (issues #9–#48: Life-State, Memory, Priority, Decomposition, Planning, Advanced Recommendations, Coaching, Personalization, Shadow Release) was governed by a single monolithic lock: all work was prohibited until passing Market Evidence Gate #61 and module-specific evidence gates.

While the product discipline behind Gate #61 remains vital—preventing premature scaling of unvalidated features to users—completely freezing engineering prevented:
1. Technical exploration, architectural validation, and contract integrity checks.
2. Building and testing implementations safely in local development and staging environments.
3. Exercising schema migrations, isolation invariants, and privacy boundaries prior to pilot readiness.

## Decision

We formally split the governance gate for Stage B into two distinct gates:

1. **Build Gate (Engineering Gate):**
   - Permits building, integrating, and testing Stage B features locally and in staging environments.
   - All code must remain strictly behind default-off feature flags and runtime kill switches.
   - Status: `ENGINEERING_ALLOWED`.

2. **Release Gate (Product Gate):**
   - Strictly prohibits activating features for real users or deploying them to production.
   - Preserves Market Evidence Gate #61 and module-specific evidence gates as absolute prerequisites for any production exposure or general release.
   - Status: `RELEASE_LOCKED`.

All Stage B modules are consequently classified as:

```text
ENGINEERING_ALLOWED / RELEASE_LOCKED
```

### Owner Mandates and Invariants

The product owner has explicitly established the following operational boundaries:

1. **Interviews are no longer a blocker for engineering:**
   User interviews and cohort research are no longer a prerequisite for writing code, unit testing, or staging verification.
2. **Interviews and market evidence remain mandatory for release:**
   User interviews, behavioral lift evidence, and retention thresholds remain strictly required before general release, production activation, or claiming product efficacy.
3. **Staging-only execution:**
   Execution is strictly limited to local development and staging environments. Zero production exposure.
4. **No production exposure:**
   Stage B code paths must not be reachable in production builds or by production users. Release builds must fail closed if flags could be active.
5. **No recurring sync:**
   No recurring external-source ingestion or background syncing (e.g., continuous polling) may be enabled without separate explicit approval.
6. **Financial gate on costs:**
   No new unbudgeted operational costs or paid third-party API consumption may be introduced without an explicit financial gate sign-off.
7. **Explicit versioned consent before model ingestion:**
   Prohibit sending Calendar, Gmail, Drive, or other user context to Vertex/Gemini or external models without fresh, scoped, explicit versioned user consent.
8. **Mandatory rollback and kill switches:**
   Every Stage B capability must support instant remote disablement (kill switches) and clean rollbacks without data corruption.
9. **Proposal-only principle:**
   Model outputs cannot mutate canonical state directly. All mutations must pass through deterministic commands, validation, and explicit user confirmation.
10. **Engineering completion is not product evidence:**
    Delivering code, passing tests, or completing technical implementation does not count as product evidence and does not satisfy Market Evidence Gate #61.

## Consequences

- Engineering teams may now safely implement Stage B modules behind feature flags on local and staging branches.
- Production safety is guaranteed through default-off feature flags, kill switches, and strict environment isolation.
- Auditability, account deletion, cost attribution, and data provenance requirements must be validated in staging before any release consideration.
- Module status transitions across all roadmap documentation from `LOCKED` to `ENGINEERING_ALLOWED / RELEASE_LOCKED`.

## Owner decision 2026-10-01 — proactive loop released to production

The owner decided to release the proactive decision loop (`lib/intelligence/**`
— proactive, source-linked suggestions; outcome inference and learning; opt-in
Gmail monitoring; flag `MAYBESITTER_FEATURE_PROACTIVE_LOOP`) to production for
all users, before Market Evidence Gate #61, after reviewing that the gate
would otherwise keep it on staging.

What still holds for the loop in production:

- the kill switch `MAYBESITTER_KILL_SWITCH_PROACTIVE_LOOP` (one value change);
- proposal-only: nothing canonical changes without the person's acceptance;
- Gmail monitoring only for accounts that switch it on;
- the global (500/day) and per-user (60/day) model caps and cost attribution;
- account export and deletion coverage.

This is an exception for this loop only. Every other Stage B module remains
`ENGINEERING_ALLOWED / RELEASE_LOCKED`, and releasing the loop is not product
evidence for #61.
