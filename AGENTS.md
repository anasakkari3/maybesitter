# MaybeSitter — repository rules

This is the canonical MaybeSitter monorepo. Read this before changing anything.

## 1. React Native under `mobile/**` is the only canonical product

`mobile/**` is the MaybeSitter product client: an Expo (React Native,
TypeScript) app. It is the only user-facing surface that counts as the product.
Product work happens there. Read `mobile/AGENTS.md` before touching it.

The previous Flutter client is retired. Nothing in this repository should
reference it as current; its final state is preserved on the tag
`archive/flutter-final`.

## 2. The design source of truth is the Claude Design project

All product UI follows the Claude Design project
`https://claude.ai/design/p/d96ab124-0531-4fef-9e0b-084677ee8911`
(`MaybeSitter.dc.html`). Older design material — the Stitch tokens, the
Indigo/violet Flutter design system and the September 2026 design brief — is
superseded and must not be used as a reference.

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
