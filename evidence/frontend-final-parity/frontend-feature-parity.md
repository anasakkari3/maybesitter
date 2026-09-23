# Final frontend feature parity

This ledger reconciles the coral mobile frontend with current `main` at
`7799ec75e0c62e426e5eed7b3ae7f726f51c2426` and coral source
`c67c516813b354c75dd961e65445e73858757305` on
`integration/coral-final-parity`.

The audit covered [163 closed issues](./closed-issues-reviewed.json), [314 merged pull requests](./merged-prs-reviewed.json), all 75 canonical
`/api/mobile/**` routes, the React Native endpoint clients, the screen union and
every production branch in `mobile/src/Root.tsx`. The machine-readable ledger
is [`frontend-feature-parity.json`](./frontend-feature-parity.json); it is the
canonical per-feature record for issue/PR links, domain/API/mobile paths,
runtime evidence and legacy-dependency disposition.

## Result

| Classification | Count | Meaning |
|---|---:|---|
| `LIVE_CONNECTED` | 37 | A real user-facing mobile path is connected to canonical behavior. |
| `BACKGROUND_ONLY` | 3 | Real behavior runs behind a visible result or system host and does not need a dedicated screen. |
| `INTERNAL_ONLY` | 7 | Engineering/runtime capability is intentionally absent from production navigation. |
| `COMING_SOON_GENUINE` | 9 | The production mobile contract or source adapter is genuinely absent; the UI says so only for that missing part. |
| `SUPERSEDED` | 4 | A duplicate or prototype path was removed after its replacement was verified. |
| **Total** | **60** | Distinct product capabilities reconciled. |

## Live connected surfaces

- Account authentication, account isolation, language-first onboarding and
  separate consent decisions.
- Typed, voice and clipboard capture through one clarification/review/confirm
  state machine.
- Native share intake for text, email, WhatsApp exports, images and documents.
- Today/upcoming commitments plus details, edits and every lifecycle action.
- Device-calendar write-back, busy-time conflict detection and external ICS
  feeds, each behind its real build/permission gate.
- Daily plan build, accept, edit and regenerate, plus continuous-replan proposal
  review with explicit accept/reject and protected-block display.
- Next-step recommendation feedback, memory CRUD, personalization controls,
  routine profile and readiness context.
- AI context import from ChatGPT, Gemini, Claude or another assistant, with
  bounded paste handling, explicit candidate review and confirmed memory writes.
- Activity history, feedback transparency, reminders, notification actions,
  widgets, football fixtures and category preferences.
- Seeds, goal execution graphs/progress/checkpoints, habit definitions and
  readiness watchers.
- Canonical background-monitor projection, global pause, lifecycle controls and
  complete attribution chains.
- Financial context with source provenance, visible conflicts, corrections,
  user-entered obligations and manual-only removal.
- Account deletion, Trust, the coral accessibility/localization system and one
  production navigation tree.

## Background and internal capabilities

- The morning planning job creates plans in the background; Plan also offers a
  user-directed build path.
- Device registration and content-free analytics support reminders and product
  reliability without a dedicated screen.
- Travel constraints enter canonical planning when a connected context source
  provides them.
- Priority, Life-State, decomposition, coaching and safety modules remain
  internal engines. Their user-facing output is presented through Capture,
  Today, Next step and Plan rather than as raw technical controls.
- The Google Calendar verification demo stays development-only and is refused
  by the release guard in staging/production.
- RescueTime aggregate context and cross-provider identity have domain
  adapters but no mobile connection contract. External action/MCP gateways,
  RevenueCat entitlement projections, vertical pack lifecycle, Timefold shadow
  comparison and credential-gated provider probes are internal foundations,
  not production controls or purchase flows.

## Truthful future labels

The audit corrected an Explore section that had shown unsupported watcher
sources as live. These parts now remain explicitly future-facing because a
production mobile route or adapter is absent:

- Direct in-app camera and file picker.
- Direct Google Calendar, Gmail and Google Drive account connections.
- WHOOP connection.
- Flight, package, football, Notion and location watcher source adapters.
- Habit-occurrence review/complete/skip: the action routes exist, but no mobile
  occurrence-list read contract exists, so the client cannot safely discover
  occurrence IDs.
- Assistant preparation/coordination, weekly mode, personality and assistant
  naming.
- Grouped syllabus/PDF extraction. Document share intake itself is live.
- Personal data export.

## Previously orphaned capabilities now resolved

- Goal execution routes now have typed mobile schemas, endpoints, query hooks
  and a coral screen with user-stated goal creation, progress, proposals, explicit commitment/habit
  confirmation, checkpoints, linked work, unlink and regeneration.
- Habit definition routes now have typed clients and a coral screen for
  explicit creation, pause/resume and delete.
- Continuous replan proposals now flow through the plan response and a real
  patch-review surface with live accept/reject actions.
- Background Activity now reads the canonical trust projection rather than a
  parallel local list and shows decision/effect/artifact attribution plus the
  server orphan-integrity count.
- Financial manual-obligation writes are reachable, validated, and remain
  advisory: adding a bill does not silently change a plan.
- Pilot incident reporting now has a reachable Trust form that sends only the
  chosen surface and category. It sends no raw notes or user content.
- Create actions for memory, kept learning suggestions, habits and readiness
  watchers now accept the routes' HTTP 201 responses. Simulator UAT exposed
  the false error that appeared even when the server had saved the object.
- A postponed commitment shows both its original deadline and when it comes
  back, on Today and Details. The postpone action does not rewrite the deadline.
- AI context import now has authenticated proposal/confirm routes and reachable
  onboarding and What MaybeSitter knows entry points. Pasted source text remains
  ephemeral; only candidates the user confirms become provenance-tagged memory.

## Orphan backend reconciliation

The route inventory found one participant-facing mobile route without a caller:
`POST /api/mobile/pilot/incidents`. It is now connected to Trust. Goal
execution and habit definitions had routes but no complete coral path; both
now have typed clients and reachable controls. The RescueTime, provider identity,
external action/MCP, RevenueCat/vertical pack, Timefold and verification
modules have no production mobile setup/action route and are classified
`INTERNAL_ONLY` in the ledger. No unexplained production mobile route remains.

Authenticated local-stack findings and certification limits are recorded in
[`uat.md`](./uat.md).

## Verification boundary

Repository tests and contract evidence verify the connected behavior. Native
calendar, HealthKit/Health Connect, push delivery, widgets, share extensions
and device permissions still require simulator or physical-device
certification in the appropriate signed build. Direct external-provider paths
also require their production account/credential setup. No physical-device
claim is made by this ledger.
