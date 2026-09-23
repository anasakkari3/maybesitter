# Fifteen-surface expansion — capability audit

Starting commit: af6bd0f1c27dcec52a6ff9c76560aa79a4ac0e81 (Astra R2 branch plus completed R3 context work). Isolated branch: design/astra-product-expansion. Graph report built at c066f91b; af6bd0f changes only generated graph data. Current Git sources checked directly.

| Reference | Existing surface / data | Status | Implementation boundary |
|---|---|---|---|
| 01 Today | TodayScreen, useToday/useUpcoming/usePlan, /commitments and /plans | LIVE | Preserve primary, derived progress and real plan; contextual assistant entry, no provider inbox inventions |
| 02 My MaybeSitter | Firebase AuthUser, routine, language, notifications, trust | PARTIAL | Real account/preferences links; name is read-only; personality/name customization previews |
| 03 Calendar / commitments | CalendarScreen, commitment queries | LIVE | Secondary searchable/filterable commitment list; source only when returned |
| 04 Integrations | deviceCalendar, busy-calendar consent, football, ICS build gates; lib/integrations provider adapters | PARTIAL | Device-calendar configuration is available; OAuth provider access has no mobile connect/list boundary; no Connected claim from sign-in provider |
| 05 Assistant | current commitments, daily plan, CaptureProvider | PARTIAL | Factual contextual card and real navigation; preparation/team coordination previews; no chat history or artificial messages |
| 06 Modes | capture vs daily-plan flows | PARTIAL | Actions route to existing flows; no persisted mode or pretend difference in reasoning |
| 07 Add | ShareProvider, normalizeShareIntent, CaptureProvider | PARTIAL | Existing OS share intake handles image/text; in-app camera/file picker unavailable; route shared content through the same Review/Confirm |
| 08 Goal execution | memory supports kind=goal; no mobile goal/milestone/linked-step API | PARTIAL | Real saved goal titles; future roadmap/link/progress model preview, no invented milestones/counts |
| 09 Personalization | useConsents, useMemory/useMemorySuggestion/usePatchMemory/useDeleteAllMemory; /memory/suggestions, /consents/personalization | LIVE subset | Consent + evidence-based proposals + saved facts and correction; no invented learning history, no new inference rules |
| 10 Patch review | PlanDiff contract in planningContracts.ts; dailyPlan DTO carries current plan only, no previous revision/diff endpoint | PARTIAL | Before/after empty future structure; links to real current plan; cannot accept fabricated diff |
| 11 Google Calendar | native device calendar read/write controls; Google demo gated development only | PARTIAL | Explain device-account route, link existing real settings; OAuth detail unavailable; no provider-specific sync/disconnect claims |
| 12 Background activity | /mobile/watchers list/pause/delete/history, watcher engine | PARTIAL | Read server status and lastObservedAt; pause/resume/delete real definitions; notification effect currently queues intent, no delivery claim; no fake next check |
| 13 PDF review | /capture/share; PDF channel; ShareProvider → CaptureProvider | PARTIAL | Client classifies PDF, but channels/index.ts registers no PDF reader. Entire PDF analysis is preview. Image/text share still uses existing consent/review/confirm; never claim page count/confidence not returned |
| 14 Habit detail | routine profile; contracts mention habit but no executable habit mobile CRUD/occurrences | MISSING end-to-end | Cadence/windows/recovery/occurrence future UX; no infinite generated work, no pretend pause/save |
| 15 Watch builder | /watchers POST persists normalized condition; signals.ts supports readiness/fixture only | PARTIAL | Source-specific draft preview; creation unavailable until discoverable source identity and delivered effects are end-to-end; no raw opaque IDs requested from users |

## Architectural decisions

Keep existing Today/Calendar/Settings stacks and Capture task. New destinations are leaves in that history. Add and modes converge on existing Capture/Plan. Integrations describe access; watcher builder describes conditions; background activity describes actual definitions. All new queries remain uid-scoped, validated, unpersisted, with shared apiRequest and userFacingMessage. Do not change backend or locked Stage B engines.

Quick/Planner is an action chooser, not a stored preference: capture already selects its extraction path; a permanent mode would falsely imply a separate engine. The live daily plan remains a proposal with explicit acceptance.

The reference images are design inputs, not runtime fixtures. No reference examples (BA 162, syllabus, sample milestones, invented inbox) are inserted into product data. Preview fields say what is missing rather than displaying fake populated values.
