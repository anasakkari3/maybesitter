# MaybeSitter — repository rules

This is the canonical MaybeSitter monorepo. Read this before changing anything.

## 1. Flutter under `mobile/**` is the only canonical product

`mobile/**` is the MaybeSitter product client. It is the only user-facing
surface that counts as the product. Product work happens there.

## 2. No new product features in the legacy web UI

The Next.js web UI is a **frozen legacy surface**. It is retained for reference
and for the backend routes that share its App Router, but it is not the product.
Do not add features to it, do not extend it, and do not treat its behaviour as a
product requirement.

It is frozen, **not** deleted. Do not remove it in this pass.

## 3. Root Next.js/server code may be changed only for these reasons

Modify root/server code only when required by:

- Flutter backend APIs (`/api/mobile/**`)
- persistence
- tests
- evaluation
- analytics
- pilot infrastructure

Any other change to root/server code is out of scope.

## 4. A web implementation never satisfies a Flutter acceptance criterion

If an issue's acceptance criteria describe user-facing behaviour, that behaviour
must exist in the Flutter client. Implementing it in the web UI does not close
the issue, does not count as evidence, and does not satisfy a gate.

## 5. Stage B remains evidence-gated and locked

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
Flutter (mobile/**)
  → /api/mobile/**
    → domain/application services (lib/services/**, src/domain/**)
      → persistence
        → pilot/analytics infrastructure
```

### Known gap: `/api/mobile/**` is not implemented on this line

The Flutter client calls `/api/mobile/capture`, `/api/mobile/capture/confirm`,
`/api/mobile/commitments/today`, `/api/mobile/commitments/upcoming` and
`/api/mobile/commitments/{id}`. **None of these routes exist in this
repository.** They have never been on `main`.

An implementation exists only in an unrelated local history (the
`checkpoint/sprint-01-backend` line, mirrored in the untracked working
directories `code/maybesitter-backend-agent` and
`code/maybesitter-backend-phone-test`). That implementation was written against
an older capture/extraction contract and does **not** compile against the
current services — a direct copy produces 53 TypeScript errors across
`mobileCaptureService`, `semanticSafetyGate` and the LLM provider layer,
because `ConfirmProposalResult`, `ExtractionResult`, `ExtractionContext`,
`CaptureProposalStatus` and `ExtractAndMapOptions` have all since diverged.

Restoring the mobile API surface is therefore a **port**, not a merge, and is
tracked as its own work item. Until it lands:

- `mobile/test/integration/backend_canonical_flow_test.dart` fails with
  connection-refused against `127.0.0.1:4321`, because that backend does not
  exist here.
- The Flutter client cannot talk to this repository's backend.

## Cleanup debt

Carried intentionally to keep the canonicalization diff minimal:

- `MetadataTile` / unused `SectionHeader` paths — cleanup candidate after V03;
  intentionally retained during canonicalization to minimize unrelated diff.
- `agent/flutter-ui-refresh-wave` commit `3055852` (screen redesign for Today,
  Upcoming, Details, Settings, Appearance, Privacy) is **intentionally rejected
  and superseded** for the canonical line. Those screens have since accumulated
  adaptive, localization, bidi, accessibility and product work; reapplying the
  historical redesign now would create regression risk outside the V03 critical
  path. The unadopted visual concepts remain eligible for a separate post-V03
  design review.

## History

This repository has two unrelated roots, joined by an explicit merge:

- `70570c8d` (2026-04-08) — backend/shared line
- `30fe87b8` (2026-07-28) — Flutter product line

The Flutter line was developed in a separate repository that was never connected
to this one. Its original history is preserved on `backup/flutter-canonical-d0c865c`.
