# Legacy frontend removal

Legacy removal happened only after each production replacement was present in
the coral navigation and had source/test evidence. Backend, domain and native
code was retained whenever the replacement still depended on it.

| Removed legacy item | Replacement | Evidence |
|---|---|---|
| `mobile/src/design/Gallery.tsx` | Production coral screens plus render, token and accessibility tests | No Gallery import or screen route remains; the stale component-inventory entry was removed. |
| `mobile/src/features/plan/TodayPlanCard.tsx` | `mobile/src/features/plan/TodayPlanRow.tsx` | Component test was migrated to `TodayPlanRow.test.tsx`; Today composes live plan data through the new row. |
| `mobile/src/state/seed.ts` | Account-scoped mobile API queries and domain records | No seed-store import remains; `oneTruth`, reachability and screen suites verify live data paths. |
| Separate Review/Saved navigation states | `CaptureFlow` derives Capture, Review and Saved from one transaction state | `Screen` has one `capture` entry and `Root` has one capture branch. Review/Saved remain reusable controlled views, not alternate production routes. |
| Prototype-only unreachable screens and seeded yesterday state from issue #486 | Canonical Today/Calendar/Commitments navigation | PR #535 removed the unreachable product path; current reachability tests cover the intentional tree. |
| Hand-rolled destination jumps for coral additions | `mobile/src/state/navigation.ts` history plus the canonical `Screen` union | Navigation and screen-reachability suites cover back, arrival and deep-link behavior. |

## Duplicate-path audit

- `mobile/src/Root.tsx` is the sole production screen switch.
- The production tabs are Today, Calendar, Say it and Settings, with the coral
  assistant action integrated into the same shell.
- There is one Details path, one Capture transaction, one Plan path and one
  Trust path.
- The frozen legacy Next.js surface was not modified or promoted; repository
  policy identifies `mobile/**` as the only canonical client.
- The development Google Calendar demo remains double-gated and is not a
  production frontend.
- A repository reference scan finds no remaining `Gallery.tsx`,
  `TodayPlanCard`, or `state/seed.ts` dependency.

## Intentionally retained shared views

`ReviewScreen`, `SavedScreen`, `CaptureScreen` and the capture sheets remain
because `CaptureFlow` renders them as phases of one canonical state machine.
They are components, not duplicate routes. Domain services, mobile API routes,
native bridges and tests were retained wherever the final coral frontend still
uses them.
