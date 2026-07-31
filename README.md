# Maybesitter

## Current product strategy

> **Turn overwhelm into one clear next step.**
>
> MaybeSitter captures what you committed to, proposes one realistic next action, explains why, and keeps you in control.

The approved strategy is **NARROW AND TEST**. The broader Core Intelligence architecture is a conditional North Star, not the automatic implementation sequence. See [Current Product Strategy](docs/strategy/CURRENT_PRODUCT_STRATEGY.md) and [the market-evidence-gated roadmap](https://github.com/anasakkari3/maybesitter/issues/49).

Maybesitter is a local-first commitment assistant for people whose day gets noisy fast.

It is built around a simple idea: the problem is not always forgetting. Sometimes every task feels equally urgent, and the hard part is deciding what deserves attention now.

This repo is currently a **single-user local MVP**. It is useful and test-covered, but it is not a full cloud SaaS product yet.

## What works now

- Capture commitments through the dashboard assistant
- Add, edit, complete, acknowledge, postpone, cancel, and delete items
- Sort active items into **Must / Should / Nice** priority buckets
- Ask clarification questions when a reminder is missing key details
- Avoid creating reminders from informational no-op messages
- Show a daily agenda and a compact daily calendar
- Surface calm pressure nudges for overdue or repeatedly ignored commitments
- Track commitment state with a deterministic domain state machine
- Persist app data locally on the server
- Export local data as JSON
- Expose a read-only iCalendar feed at `/api/calendar.ics`
- Run a local reminder worker for scheduled reminder processing
- Use browser notifications when the app has permission and the worker/app are running

## What is not production-ready yet

- Real login/signup accounts
- Multi-user cloud sync
- Payments or premium subscriptions
- Recurring tasks as a user-facing feature
- True two-way calendar sync
- Reliable mobile push notifications
- Public production analytics/insights pages
- A hosted multi-instance deployment story

The landing page mentions some future capabilities. Treat those as roadmap, not shipped functionality.

## Assistant response engine

Maybesitter includes a V3 conversational response engine under:

```text
lib/services/responseEngine/
```

The response pipeline is:

```text
SemanticEvent
-> UserSituationAnalysis
-> Intent / Strategy Selection
-> ResponsePlan
-> Language Realizer
-> Validation
-> AssistantTurn.message
```

The engine is designed to keep user-visible responses conversational while preserving deterministic safety:

- completion should sound like completion, not tracking
- confirmation should not pretend a change already happened
- no-op responses should not imply persistence
- pressure messages must match their selected strategy
- raw ISO timestamps and legacy scaffold terms are blocked from production assistant copy

## Tech stack

- Next.js 14 App Router
- React 18
- TypeScript
- Tailwind CSS
- Node test runner
- File-backed local persistence
- Optional local LLM extraction path with rule-based fallback

## Getting started

Install dependencies:

```bash
npm install
```

Run the app and reminder worker together:

```bash
npm run dev:reliable
```

Or run them separately:

```bash
npm run dev
npm run worker
```

Open:

```text
http://localhost:3000
```

## Scripts

```bash
npm run dev             # Start the Next.js dev server
npm run dev:reliable    # Start dev server and reminder worker together
npm run worker          # Run the reminder worker
npm run build           # Build for production
npm start               # Start the production server
npm run start:reliable  # Start production server and reminder worker together
npm test                # Run the full test suite
npm run test:registry      # Run the dataset-governance tests only
npm run validate:registry  # Validate the dataset registry, lock ledger, and reports
```

## Dataset registry

Datasets, splits, lineage, consent, locked test sets, and evaluation reports are
governed by one registry under `data/registry/`, with versioned contracts and
validators in `lib/evaluation/registry/`. See [Dataset registry and evaluation
governance](docs/data/DATASET_REGISTRY.md) for the manifest shape, the
locked-test immutability policy and its change procedure, and the
evaluation-report contract.

Nothing in the app imports it — it is governance tooling for the model/data
track, and the artifacts it governs live in the Gemma pipeline working copies.

## Main routes

| Route | Status | Purpose |
| --- | --- | --- |
| `/` | Shipped with caveats | Marketing landing page |
| `/dashboard` | Shipped | Main app surface |
| `/assistant` | Shipped | Assistant-focused surface |
| `/settings` | Shipped | Local profile, preferences, notifications, data export |
| `/api/calendar.ics` | Shipped | Read-only calendar feed |
| `/auth/login` | Compatibility only | Redirects into single-user mode |
| `/auth/signup` | Compatibility only | Redirects into single-user mode |
| `/analytics` | Developer-gated | Local pattern view |
| `/insights` | Developer/demo | Project/business insights |
| `/calculator` | Developer/demo | Business calculator |

Developer-only navigation is controlled by:

```bash
NEXT_PUBLIC_MAYBESITTER_DEVELOPER_PAGES=true
```

## Data storage

Runtime app data is stored locally under:

```text
.maybesitter/
```

The app currently uses a single local user profile. This is intentional for the reliability MVP.

For a real hosted product, replace the file-backed local store with a transactional database, proper authentication, tenancy, and a managed job runner.

## Reminder behavior

Maybesitter supports local reminder processing through the worker:

```bash
npm run worker
```

Browser notifications depend on browser permission and local runtime availability. This is not equivalent to hosted mobile push notifications.

## Quality gates

The current suite covers:

- domain state transitions
- extraction and fallback behavior
- assistant response semantics
- adversarial response-engine quality checks
- pressure strategy/message compatibility
- agenda behavior
- persistence and scheduler behavior
- calendar feed generation

Run:

```bash
npm test
npm run build
```

Current verified state during this cleanup:

```text
108/108 tests passing
production build passing
```

## Project status

Maybesitter is best described as:

```text
Local-first single-user MVP: usable, test-covered, not a full SaaS product.
```

The next product work should focus on production hardening before public launch:

- real auth and account model
- deployment data model
- hosted reminder reliability
- landing page copy/encoding polish
- broader long-term conversational quality review

