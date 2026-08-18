# Internal Alpha Dogfood Review Workflow

> This document describes the internal workflow for reviewing flagged
> feedback sessions during pre-pilot alpha hardening. It is tooling
> for the development team; it does NOT authorize pilot deployment.

## Overview

During alpha hardening, a small internal team uses MaybeSitter with
realistic scenarios and flags recommendations that are wrong, confusing,
not useful, invasive, or technically broken. Flags are stored locally
(bounded 30-day retention) and reviewed before any external exposure.

## Flag categories

| Flag | Meaning | Example |
|---|---|---|
| `recommendation_wrong` | The next step is factually incorrect or doesn't apply | Proposes "Pay rent" when no rent commitment exists |
| `misunderstood_me` | The extractor misread the user's input | "Email Alex" parsed as "Call Alex" |
| `not_useful` | Technically correct but unhelpful or too vague | "Do something about the report" |
| `invasive` | Feels overly personal or assumes sensitive context | Proposes medical scheduling without user mention |
| `technical_problem` | App error, broken UI, or unexpected behavior | Recommendation card shows "null" |

## How to flag (Flutter)

1. A recommendation is shown in the **Next Step** card.
2. Tap the **Report** button (bottom-right of the card).
3. Select one of the 5 flag categories.
4. Optionally add a short note (max 500 characters).
5. The flag is sent to the backend and stored.

## How to review flags

### List all flagged sessions
```bash
node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/alpha-review.ts
```

### Filter by participant or session
```bash
node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/alpha-review.ts --participant p001
node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/alpha-review.ts --session abc123
```

### Delete data for a participant or session
```bash
node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/alpha-review.ts --delete-participant p001
node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/alpha-review.ts --delete-session abc123
```

## Privacy and retention

- Flags are stored locally in `.maybesitter/alpha-feedback/` (one JSON file per flag).
- **Bounded retention**: flags older than 30 days are automatically pruned.
- **No raw content**: flags carry proposalId, commitmentId, and an optional 500-char note — no unrestricted content.
- **Pseudonymous**: participantId is a pilot pseudonym, not a real identity.
- **Deletion**: per-session and per-participant deletion is supported via the CLI.
- **Access boundary**: flags are only accessible through the CLI and the alpha feedback API (guarded by pilot auth + alpha mode flag).
- **Private messages are never ingested** by this system.

## What is collected during alpha

| Field | Stored | Purpose |
|---|---|---|
| participantId | Yes (pseudonym) | Group flags by participant |
| sessionId | Yes | Group flags by session |
| proposalId | Yes | Link flag to the specific recommendation |
| commitmentId | Yes (optional) | Link to the underlying commitment |
| category | Yes | 5 fixed categories |
| note | Yes (optional, 500 chars max) | Free-text context |
| createdAt | Yes | Timestamp |

What is **NOT** collected: raw user text, full recommendation text, model internals, or personal information.
