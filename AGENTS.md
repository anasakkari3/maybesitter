# MaybeSitter — repository rules

This is the canonical MaybeSitter monorepo. Read this before changing anything.

## 1. React Native under `mobile/**` is the only canonical product

`mobile/**` is the MaybeSitter product client: an Expo (React Native,
TypeScript) app. It is the only user-facing surface that counts as the product.
Product work happens there. Read `mobile/AGENTS.md` before touching it.

The previous Flutter client is retired. Nothing in this repository should
reference it as current; its final state is preserved on the tag
`archive/flutter-final`.

## 2. The design source of truth is the approved coral continuation

The accepted coral/charcoal continuation is the visual baseline for `mobile/**`.
Its reference hashes and palette are recorded in
`mobile/src/design/coral.source.json`; implementation decisions and coverage are
in `docs/design/coral-continuation.md`. The Round-2 Claude Design export in
`design/R2App.dc.html` remains the structural reference for navigation,
typography and motion. The earlier Round-1 export and teal Round-2 palette are
historical material, not the current product appearance.

## 3. No new product features in the legacy web UI

The Next.js web UI is a **frozen legacy surface**. It is retained for reference
and for the backend routes that share its App Router, but it is not the product.
Do not add features to it, do not extend it, and do not treat its behaviour as a
product requirement.

It is frozen, **not** deleted. Do not remove it in this pass.

## 4. Root Next.js/server code may be changed only for these reasons

Modify root/server code only when required by:

- mobile backend APIs (`/api/mobile/**`)
- persistence
- tests
- evaluation
- analytics
- pilot infrastructure

Any other change to root/server code is out of scope.

## 5. A web implementation never satisfies a mobile acceptance criterion

If an issue's acceptance criteria describe user-facing behaviour, that behaviour
must exist in the React Native client. Implementing it in the web UI does not
close the issue, does not count as evidence, and does not satisfy a gate.

## 6. Stage B remains evidence-gated and locked

Issues #9–#48 (Sprints 02–11: Life-State, Memory, Feedback aggregation,
Priority, Decomposition, Planning, Advanced Recommendations, Coaching,
Personalization, Shadow Release) are **locked**.

Stage B work must not begin merely because an engineering review gate passed. It
additionally requires the Market Evidence Gate (#61) and the relevant
module-specific evidence gate. See `docs/strategy/CURRENT_PRODUCT_STRATEGY.md`
and issue #49.

The sprint dates on those milestones are historical planning assumptions, not
approved execution commitments.

---

## Architecture

The intended runtime path is:

```
React Native (mobile/**)
  → /api/mobile/**
    → domain/application services (lib/services/**, src/domain/**)
      → persistence
        → pilot/analytics infrastructure
```

### `/api/mobile/**` is the mobile backend boundary

The React Native client talks to `/api/mobile/**`. Keep that boundary current
when product-facing backend behaviour is required by the client, and adapt
through existing domain/application services rather than restoring historical
backend-agent contracts.

The root `tsconfig.json` excludes `mobile/`; the app has its own toolchain and
`package.json`.

## History

This repository has two unrelated roots, joined by an explicit merge:

- `70570c8d` (2026-04-08) — backend/shared line
- `30fe87b8` (2026-07-28) — the former Flutter product line

The Flutter client was replaced by React Native in September 2026. Its last
state, including uncommitted font work at the time of the switch, is on the tag
`archive/flutter-final`; its original separate-repository history is on
`backup/flutter-canonical-d0c865c`. Dated plans, specs and reviews under
`docs/` that mention Flutter are historical records of that period.

---

## Mandatory implementation skill routing

For every implementation, debugging, review, regression-fix, or integration
lane, determine the affected surface BEFORE editing code and invoke the
applicable installed Skills.

### React / Next.js

Use `vercel-react-best-practices` when modifying or reviewing React/Next.js
rendering, components, client/server boundaries, data fetching,
performance-sensitive frontend code, or other relevant React/Next.js behavior.
Do not blindly apply web-specific recommendations to unrelated backend code.

### User-facing UI

Use `design-design-system` and `design-accessibility-review` whenever modifying
or creating a user-visible screen, component, interaction, form, state,
navigation surface, or visual pattern. For React Native / Expo work, adapt
generic/web recommendations to the actual mobile platform; never introduce
web-only APIs into React Native.

Before merging a meaningful user-facing UI change, also use
`design-design-critique` as a final review pass after the feature works — not
as a replacement for functional testing.

### Product copy / localization

Use `design-ux-copy` whenever changing buttons, CTAs, errors, warnings,
onboarding text, empty states, settings descriptions, notification copy,
explanatory text, or user-visible Arabic, Hebrew, or English strings. Preserve
MaybeSitter's existing product voice and localization contracts; do not rewrite
unrelated copy merely because the skill suggests alternatives.

### CI / GitHub Actions

Use `github-actions-sparen` ONLY when modifying, debugging, or reviewing
`.github/workflows/**`, GitHub Actions behavior, or CI execution structure. Do
not optimize CI merely because an implementation lane exists.

### Figma / explicit design handoff

Use `figma-to-code` and `design-design-handoff` ONLY when an actual
Figma/design artifact or explicit visual handoff is part of the task.

### Skills that must not auto-pollute implementation

Do NOT automatically invoke marketing, SEO, sales, brand,
document-generation, presentation, spreadsheet, Notion, website-builder, or
other unrelated Skills during normal engineering work, nor Claude/Anthropic
operational Skills merely because they are installed. They remain available
when a task genuinely requires them.

### Precedence

Skills are advisory implementation aids. They NEVER override, in descending
order of authority:

1. security/privacy/account-isolation requirements;
2. repository AGENTS.md contracts;
3. current source-code architecture and invariants;
4. GitHub issue acceptance criteria;
5. current tests and API contracts;
6. explicit orchestration ownership/dependency constraints.

If a Skill recommendation conflicts with the repository architecture, ignore
that recommendation and follow the repository. Never perform unrelated
refactoring just because a Skill identifies an improvement.

### Sub-agents

The orchestrator is responsible for Skill routing. Whenever a lane is
delegated to a sub-agent, state explicitly which of the above Skills apply to
its task; never assume a sub-agent remembered a Skill from another lane.

- Backend-only domain/service change: usually no UI Skill.
- Next.js/React change: `vercel-react-best-practices`.
- React Native screen: `design-design-system` + `design-accessibility-review`,
  plus `design-ux-copy` if strings change, plus `design-design-critique`
  before final merge review.
- CI change: `github-actions-sparen`.
