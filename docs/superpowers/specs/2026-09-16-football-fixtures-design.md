# Football fixtures as commitments — design

**Date:** 2026-09-16
**Status:** design approved in brainstorming; implementation plan to follow

## The problem

A user who follows a club wants the product to know, without being told, that
there is a match. Not as trivia on a separate screen — as a fact about their
time. The four requirements, in the owner's words:

1. The app **knows** there is a match next Saturday.
2. It **does not place** any work at that time.
3. Matches are **added to the calendar** automatically.
4. If the user creates a commitment that lands on a match, the app **warns**
   about the collision.

Requirement 4 is the one that sets the quality bar for everything else. A
collision warning is only worth having if the fixture data behind it is
current. A match that moved and was not re-synced makes the product block the
wrong evening, warn about a clash that no longer exists, and stay silent about
the real one — three confident lies from one stale row. Freshness is therefore
a correctness requirement here, not a nice-to-have.

## Non-goals

- Live scores, lineups, standings, results. The product is not a sports app.
  It cares about a match only as an interval of the user's time.
- Following arbitrary clubs. The MVP ships a curated list (owner's decision);
  free-text search over every club in the world is a later question.
- Per-match opt-in. Following the club is the consent. See "Opt-out, not
  opt-in".

## Decision: where this lives

Rejected — **fixtures as busy blocks only.** `buildDailyPlanInput` already
takes an injected `busyBlocks` argument (the UC-3.2 / #186 seam, still
unfilled), and pushing fixtures in there would satisfy requirements 1 and 2
with almost no code. It fails the owner's actual request: a busy block is
anonymous time, it does not appear among the user's commitments, cannot be
opted out of, and carries no reminder. The owner asked for matches *as
commitments*.

Rejected — **thin direct sync.** Fetch fixtures, create commitments keyed by
match id, no provenance layer. Cheapest to write, but every re-sync question —
did this match move, was it cancelled, did the user already dismiss it — has
to be answered by hand-rolled logic, and requirement 4 depends on getting all
three right.

**Chosen — external-source projection.** Fixtures are an external source
projected into commitments, reusing the provenance shape in
`src/contracts/v1/externalTaskContracts.ts` (`ExternalTaskReference`:
`externalId`, `fingerprint`, `conflict`, `linkedCommitmentId`, `detachedAt`).
That contract was written for exactly this class of problem and already
answers "the remote row changed" and "the user detached this" as states rather
than as ad-hoc branches.

The OAuth half of the integration contracts
(`integrationConnectionContracts.ts`) is **not** used. Those model a
per-user account at a provider with tokens, re-auth and revocation. There is
no per-user football account — there is one application-level API key. Each
following user gets one synthetic scope id (their uid) so the per-scope delete
path still works; nothing else from that contract is pulled in.

## Architecture

```
football-data.org
      │   once per day, per CLUB (never per user)
      ▼
FixtureProvider          interface; the vendor sits behind it
      ▼
fixture store            shared across all users
      ▼
projectFixtures(uid)     per following user
      ▼
Commitment  (kind=task, scheduled_event, durationMinutes=120, origin=external_feed)
      ├─► FixedEvent blocking=true   → no work placed there   (req 2)
      ├─► agenda / calendar surfaces                          (req 3)
      ├─► collision check on create                           (req 4)
      └─► reminder pipeline
```

**Fetch per club, not per user.** One thousand users following Barcelona is
still one request for Barcelona's fixtures. The free tier allows 10 requests
per minute; a per-user fetch would exhaust it at a few dozen users and the
design would have to be rebuilt under load. Request volume here is a function
of the curated list's size, not of user count.

## Data model changes

### 1. Duration (`src/domain/stateMachine.ts`)

`TimeSpec` gains `durationMinutes: number | null`.

Today `buildDailyPlanInput` blocks a hardcoded `DEFAULT_FIXED_EVENT_MINUTES`
(30) for every pinned commitment. A football match is ~120 minutes, so without
this the product would block the first half and schedule work over the second.
The planner reads `timeSpec.durationMinutes ?? DEFAULT_FIXED_EVENT_MINUTES`, so
every existing commitment keeps its current behaviour and `defaultTimeSpec()`
supplies `null` for stored state written before this change.

There are three consumers of the missing duration, not one:

| Consumer | Today | After |
|---|---|---|
| `buildDailyPlan.ts` `DEFAULT_FIXED_EVENT_MINUTES` | blocks 30 min | blocks the real duration |
| `mobile/src/features/calendar/eventDraft.ts` `DEFAULT_MINUTES` | 30-min calendar event | real-length event |
| collision check (new) | n/a | compares real intervals |

`eventDraft.ts:30` already says it gives "every commitment in the domain a
thirty-minute duration nobody asked for". This is a general improvement, not a
football field: a two-hour meeting has the same bug today, in all three
places.

### 2. Origin (`src/domain/stateMachine.ts`)

`Commitment` gains `origin: 'user' | 'external_feed'` (default `'user'`).

The product needs to know a commitment was not typed by a human: it skips
confirmation, it may be removed by the source, and its removal by the user must
be remembered. Provider details stay out of the domain — that is
`EXTERNAL_TASK_BOUNDARY_POLICY.providerSpecificTaskFieldsAllowed: false`, and
the details live on the `ExternalTaskReference` keyed by `linkedCommitmentId`.

`CommitmentKind` is deliberately **not** extended with `'event'`. Only one
place branches on it today (`pressureService.ts:524`, choosing between "this
task" and "this follow-up" in copy), so the cost of adding a variant is low —
but so is the benefit: nothing in this feature would read it. `origin` carries
the distinction the feature actually uses, and a variant nothing branches on is
a variant that drifts out of date.

### 3. Followed clubs

Per-user: an array of club ids, stored beside the user's other settings. An
array from day one even though the MVP screen is simple — the alternative is a
data migration to add the second club later, for no saving now.

### 4. Curated club list

`data/footballClubs.json`, version-controlled: our stable `clubId`, the
provider's team id, and the display name in `ar` / `he` / `en`. Names are
carried in all three languages rather than taken from the provider, which
returns one language: an Arabic UI showing "Barcelona" in Latin script beside
Arabic commitments is the kind of seam users read as breakage.

## Sync

A new job handler on the existing runner (`lib/jobs/internalJobs.ts`,
`POST /api/internal/jobs/run`). No new cron, no new deployment surface.

Daily, for each club in the curated list with at least one follower:

1. Fetch fixtures in a rolling 60-day window.
2. Normalize to `Fixture { providerMatchId, competition, homeTeam, awayTeam,
   kickoffUtc, status, venue }`.
3. Upsert into the fixture store, computing `contentHash` over the normalized
   payload.

Requests are issued sequentially with spacing that respects 10/min.

**Failure is silent and non-destructive.** If the provider is down or the key
is missing, the job logs and exits; previously synced fixtures stay. It never
deletes a user's commitments because a fetch failed — that would empty
somebody's Saturday over a 503.

## Projection

For each user following club C, for each fixture of C in the horizon:

| Situation | Action |
|---|---|
| No `ExternalTaskReference` for this `(uid, matchId)` | Create commitment (`status: 'active'`), create the reference |
| Reference exists, `contentHash` unchanged | Nothing |
| Reference exists, kickoff moved | Update `timeSpec`, emit a reschedule so the reminder follows |
| Fixture `status: 'cancelled'` | Drop the commitment |
| Reference has `detachedAt` set | **Never recreate** |

Commitments are created straight to `active`, not `draft` /
`pending_confirmation`: following the club was the confirmation, and routing 50
matches a season through a confirmation queue is the outcome the owner
explicitly rejected.

### Opt-out, not opt-in

The user's choice is exercised twice: once when picking clubs, and any time
after by dismissing a single match. Dismissal sets `detachedAt` on the
reference, which is what stops the next night's sync from resurrecting it. A
dismissal that a sync undoes is worse than no dismissal at all.

## Requirement 2 — not placing work on a match

Falls out of the model. A commitment whose `timeSpec.kind` is
`scheduled_event` already becomes a `FixedEvent` with `blocking: true`
(`buildDailyPlan.ts`), and the planner's validator already refuses to place
work inside one. The only change is the duration fix above. No new blocking
logic is written.

## Requirement 4 — collision warning

A server-side check on the commitment create/update path: given the proposed
instant and duration, find overlapping blocking intervals among the user's
`scheduled_event` commitments, and return a **warning** alongside the created
commitment.

It warns, it does not refuse. The user is allowed to book over a match; they
are not allowed to do it without knowing.

Overlap uses the existing `intervalsOverlap` from
`lib/planning/shared/time.ts` — half-open intervals, strict `<` on both sides,
zero-length intervals intersect nothing. Mobile's
`features/calendarDemo/overlap.ts` already mirrors that convention on purpose;
a third implementation would be the first chance for the two to disagree.

## Requirement 3 — calendar

Honest statement of where this lands:

- **In-app agenda:** works as soon as the commitment exists. No extra work.
- **Device calendar:** **available.** #185 merged to `main` as `bc89195`
  partway through this design, and its shape could not suit this feature
  better: `deviceCalendarSync.reconcile` is one function over the commitments
  the app is already holding, run when the lists change — not a write hung off
  each mutation. A fixture commitment is an ordinary commitment, so it becomes
  a calendar event with **zero football-specific code**, and a kickoff that
  moves moves the event by the same path. Requirement 3 needs the duration fix
  above and nothing else.
- **ICS feed** (`/api/calendar.ics`): reads the legacy `Item` model, not
  `Commitment`. Bridging it is a separate piece of work and is **out of scope**
  here. Fixtures will not appear in the ICS feed in this MVP.

## Reminders

The fixture commitment is eligible for the existing reminder pipeline
(`notificationDecisionService` → schedule / cancel / reschedule on `dueAt`), so
a kickoff that moves reschedules the reminder without football-specific code.

**Delivery to the phone does not exist on `main`.** `expo-notifications` is on
the unmerged `s3-196-184-notifications` branch — checked again after #185
landed; still not merged. Until it does, a fixture reminder is a scheduled
decision nobody receives. This is the feature's one remaining external
dependency, and it is stated rather than designed around.

## Learning: raising priority over time (phase 2)

The owner's second-stage requirement: once it is clear the user watches every
match, stop treating each one as a neutral block and treat football as
something that matters to them.

`Priority.source` already has an `'inferred'` variant, and
`lib/priority/mobileRanking.ts` already surfaces inferred-high as
`estimated_important`. The inference — a user who has kept N consecutive
matches gets subsequent fixtures at `{ level: 'high', source: 'inferred' }` —
is the only new part.

Deliberately phase 2. It is an adaptive behaviour operating on the priority
engine, which is the most consequential part of the product, and it is worth
shipping only once there is real opt-out data to infer from. Shipping it with
the MVP would mean tuning a learner against zero observations.

## Timezones

Kickoffs are stored as UTC instants and converted for display through the
existing i18n timezone utilities, on the server. Offsets are never computed on
device: Hermes has `Intl.DateTimeFormat` but shapes `longOffset` differently
and has returned a zero offset, and Jest running on Node hides it. A match
shown an hour off is indistinguishable, to the user, from the product being
broken.

## Error handling

| Failure | Behaviour |
|---|---|
| `FOOTBALL_DATA_API_KEY` missing | Feature reports itself off; no crash, no silent half-state |
| Provider 5xx / timeout | Job logs and exits; existing fixtures untouched |
| Rate limit hit | Back off, resume next run; partial sync is valid |
| Malformed fixture payload | Skip that fixture, record it, continue the rest |
| Club in list, unknown to provider | Surfaces at sync as a named error, not a silent empty list |

## Testing

- **Provider adapter:** normalization from recorded provider payloads,
  including postponed and cancelled. Fixtures are recorded, never live — a test
  suite that depends on a real football schedule fails on international breaks.
- **Projection:** each row of the projection table, including the one that
  matters most — a dismissed match that a later sync must not recreate.
- **Duration:** a 120-minute commitment blocks 120 minutes of the plan, and a
  commitment without a duration still blocks 30.
- **Collision:** overlap, abutment (no warning), zero-length.
- **Timezone:** a kickoff near local midnight lands on the correct local day.

`npm test` is an explicit file list, not a glob. Every new test file must be
added to it or it will pass by never running.

## Phasing

- **P0** — data model (duration, origin), provider + adapter, fixture store,
  sync job, projection, blocking.
- **P1** — collision warning end to end, club-following UI in all three
  languages, per-match dismissal.
- **P2** — inferred priority; reminder delivery once #196/#184 merges.
  Device-calendar writing is *not* here: it arrives with P0's duration fix.

## Risks

- **Unmerged dependency.** Reminder delivery (#196/#184) is still on a branch.
  P0 and P1 do not depend on it.
- **`main` moves under this work.** #185 merged *during* this design session
  and turned one of its dependencies into a solved problem. Other lanes are
  active in sibling worktrees; the plan should re-check assumptions about
  `main` rather than trusting this document's snapshot of it.
- **Free-tier ceiling.** 10 requests/minute and limited competitions. The
  curated list must stay inside covered competitions, and the provider must
  stay behind the adapter interface so it can be replaced without touching
  projection.
- **Provider attribution.** The free tier requires attribution; the club list
  UI has to carry it.
- **Curated list staleness.** A club that changes provider id breaks silently
  unless the sync reports unknown clubs by name.
