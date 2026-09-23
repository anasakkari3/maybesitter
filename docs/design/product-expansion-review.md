# MaybeSitter product expansion review

## 1. Starting point

Starting SHA: `af6bd0f1c27dcec52a6ff9c76560aa79a4ac0e81`.
Branch: `design/astra-product-expansion`, isolated worktree `code/astra-product-expansion`.
The source branch remains untouched. No merge, push, deployment or release was performed.
The final commit identifier is recorded in the generated gallery report after commit.

## 2. Surface coverage

All fifteen requested destinations exist in the current mobile architecture. “Implemented” includes explicitly labelled preview destinations; it does not mean their missing backend capabilities are live.

| # | Surface | Delivered behavior |
|---|---|---|
| 01 | Today | Existing real next action, progress, plan preview and upcoming context retained; contextual assistant entry added |
| 02 | My MaybeSitter | Real account identity; language, effective reminders, routine and personalization controls; future assistant name/style labelled |
| 03 | Calendar / commitments | Existing Calendar retained; secondary list with search, active/done/all filters, time sort and real Details |
| 04 | Integrations | Honest provider availability, live device-calendar settings, existing energy/source controls |
| 05 | Contextual assistant | Current recorded commitment, Details, agenda, shared Add flow; preparation and coordination are future capabilities |
| 06 | Quick / Planner | Existing Capture and daily Plan actions; weekly mode preview, no meaningless stored preference |
| 07 | Add | Source/intention hub converging on existing Capture/Share/Review/Confirm, routine reminders and Memory |
| 08 | Goal execution | Actual goal memory, empty state, future roadmap/current milestone/linked steps/habits/checkpoints structure |
| 09 | Personalization | Real consent and evidence-based suggestions; Keep, Dismiss and explicit edited preference save; recent actual stored records, Memory editing/deletion, Trust |
| 10 | Patch review | Clearly marked future before/proposed/protected structure; disabled accept; real current daily-plan link |
| 11 | Google Calendar | Future direct connection explained separately from currently usable device-calendar access |
| 12 | Background activity | Actual watcher list, status and observation time; pause/resume and confirmed deletion; source access link when blocked |
| 13 | PDF review | Honest preview of grouped proposed dates and extraction limitations, with Capture fallback |
| 14 | Habit detail | Preview of cadence/duration/windows/flexibility/recovery/occurrences; existing routine link |
| 15 | Watch builder | Editable local draft with source-specific conditions and effects; summary; disabled creation |

## 3. Evidence

Workspace deliverables: `outputs/astra-product-expansion/index.html`, `screenshots/`, `references/`, `manifest.json`, `logs/`, `flows/` and `scripts/`.
PDF: `output/pdf/MaybeSitter-product-expansion.pdf`.

The gallery pairs the supplied reference with a native implementation capture. References are English concept images; primary implementation captures are Arabic dark mode with real local test records. These are not a strict same-state before/after comparison. All implementation images use the same dedicated iPhone 17 Pro / iOS 26.5 simulator, `FE12AE51-7348-481E-B8B7-35CEF6A356ED`, and the same local Firebase account `visual-ab@example.test`. PNGs are original 1206 x 2622 captures. Images are fitted without stretching or drawn-over UI. SHA-256 hashes are in the manifest.

No fake Connected/reauth, extracted PDF items, habit occurrences, goal milestones or patch changes are shown. Those states cannot be reproduced as live supported capabilities. The local account has no new eligible memory suggestion; the editing boundary is tested using an actual handler fixture rather than fabricated runtime observations.

## 4. Capability matrix and real behavior

See [product-expansion-matrix.md](product-expansion-matrix.md) for reference-to-query-to-backend mapping and LIVE/PARTIAL/MISSING classifications.

Live additions reuse existing authenticated hooks and endpoints. The only new network client surface is watchers: validated DTOs, shared `apiRequest`, UID-scoped queries, explicit user mutations, no mutation retries, no networking persistence, and shared user-facing error mapping. Background controls change persisted definitions; they do not promise that a queued notification has been delivered.

Personalization correction saves the user's wording as a user-stated preference. It does not silently Keep or Dismiss the original inferred suggestion, and the UI explains this. Existing full Memory owns supersession history and deletion. Consent errors are visible and retryable where appropriate; unavailable memory is not presented as an empty personal record.

## 5. Backend and API gaps

- Mobile provider connection/list/OAuth transport is absent. Firebase Google sign-in is not Calendar consent. The development-only Calendar demo is not a production connection.
- Native device-calendar read/write access exists, with separate permissions and confirmation. Direct Google synchronization, provider-specific last-sync and disconnect are not fabricated.
- PDF is recognized by intake classification, but the share reader registry has no PDF reader. PDF extraction/review therefore remains a preview.
- Goal memory exists; executable milestone, linked-step and progress APIs do not.
- Habit CRUD and occurrence execution do not exist end-to-end.
- A PlanDiff domain contract exists, but the mobile daily-plan response provides no previous revision/diff. Existing proposal acceptance remains available.
- Watcher list/create/pause/delete/history endpoints exist. Registered signal observers cover readiness and football fixtures. Source discovery and delivered effects are incomplete, so the builder cannot create a convincing flight/package integration merely by storing a definition.
- Export of complete personalization data is unavailable.

No backend files, API contracts, feature guards, auth bypass rules or locked Stage B engines were changed.

## 6. Shared design and navigation

Added `ProductPage`, `ProductSection`, `ProductRow`, `ProductActions`, `ProductIcon`, `AvailabilityBadge`, `PreviewNotice` and `PreviewAction`. All use existing theme roles, text primitives, safe-area ownership, motion and back behavior. Grouped sections use flat divided rows instead of repeated nested cards.

The capability model centralizes LIVE, AVAILABLE, COMING_SOON, BETA, BLOCKED and NEEDS_REAUTH. Screen-specific status comes from real server records where available.

The existing Today/Calendar/Settings stacks and Capture task remain. New leaves enter those histories; they do not introduce a competing tab system. Add and mode selection converge on existing Capture and Plan implementations. Integrations describe access, Watch describes a condition, and Background describes current persisted definitions.

At larger Dynamic Type sizes, rows/actions stack, Back remains pinned and long titles scroll with content. This was changed after AX5 review found that pinned titles occupied too much of the viewport. Scaling remains uncapped.

## 7. Deliberate reference deviations

- Existing teal/sand theme roles are retained under the current mobile contract; coral was not introduced. The palette question was left open during implementation and the default was communicated.
- Existing three-tab architecture is retained instead of copying Home/Calendar/Tasks/Me.
- No duplicated composer or artificial conversation/typing history. The assistant presents real context and actionable navigation.
- No copied BA 162, syllabus dates, Gmail tasks, milestones or reference completion metrics.
- Preview pages use legitimate empty states and availability labels. Their composition is consequently less populated than the supplied references.
- Quick/Planner is an action chooser. Existing automatic extraction remains; the UI does not pretend that a new global reasoning mode exists.
- The commitments list explicitly covers Today and Upcoming, not the complete history.
- Today and Saved/Review retain the prior R3 improvements. This pass does not redesign those already validated flows.

## 8. Runtime verification

- Arabic dark: native captures of all fifteen destinations, including RTL back controls, dates, mixed Latin provider names and account email.
- Arabic light, English light and Hebrew light: profile/settings runtime captures; correct back direction and layout mirroring. User content remains in its original language.
- xxxLarge and AX5: actual simulator text category changes; stacked profile/background UI, persistent Back, long scrolling watcher draft and summary.
- Capture → clarification → Review → explicit Confirm → Saved completed against the local backend.
- Daily Plan proposal and explicit acceptance checked on the dedicated local account.
- Background active → paused → resumed → confirmation → deleted checked through the native UI on a disposable persisted watcher.
- Backend smoke checks read Today, Upcoming, Memory, consents, watcher list and daily plan; create/pause/resume/delete succeeded on an isolated local record.

These are local emulator/simulator checks, not production provider certification or physical-device VoiceOver validation. Hebrew layout/string coverage was checked; native editorial review remains advisable.

## 9. Automated verification

- Mobile TypeScript: PASS.
- Full mobile Jest: 203 suites, 2,708 tests, one snapshot PASS.
- Included RTL, uncapped Dynamic Type, navigation, screen shell, design contracts, auth and existing domain regression suites.
- New tests cover navigation convergence, source-specific watcher conditions, disabled preview creation, actual watcher response parsing, failed mutation without optimistic success/retry, account-scoped invalidation and explicit preference edit/save.
- Relevant ESLint: zero errors, two pre-existing `react-hooks/refs` warnings in Root's link-handler refs. No new lint warnings.
- `git diff --check`: PASS.
- Graphify AST update completed. It reported an existing parser limitation in unchanged `lib/recommendation/selector/candidates.ts`; no semantic API extraction was used. Generated backup/cache files were moved to the evidence directory, outside the product repository.

Some existing test suites emit React test-environment act warnings while passing. Those were not hidden or fixed through unrelated changes.

## 10. Remaining limitations and review decision

This is a coherent navigation and availability expansion, not a fully delivered advanced assistant. Missing transports and domain APIs still limit how rich the live content can be. Goal, PDF, habit and patch pages are deliberate previews, and need their respective backend work before they can match the populated references behaviorally.

The product remains honest about what works. No screen reports a provider connection, extraction result, learning event, applied plan patch or created watcher without a real supporting operation. Human review should assess visual density, the retained palette and whether the future surfaces should ship now or remain behind a product release decision.

The branch is left for human review, not merged. Final SHA and clean-status verification are recorded in the generated report.
