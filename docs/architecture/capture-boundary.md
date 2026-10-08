# Capture proposal and persistence boundary

## Contract and ownership

Capture uses the versioned v1 contracts in `src/contracts/v1/captureContracts.ts`.
Extraction output is untrusted and can only produce a proposal. The proposal
contract deliberately has no persisted or saved field. Canonical writes belong
only to `CapturePersistenceAdapter` and are reachable only from
`confirmCapture` after scope, status, selection, and idempotency validation.

```text
raw input
→ extraction proposal
→ schema validation in the extraction provider
→ semantic validation at the Capture boundary
→ explicit user confirmation
→ transactional deterministic persistence adapter
→ canonical state
```

Model output never receives a persistence dependency. Failed schema or semantic
validation creates a rejected proposal, and rejected or unconfirmed proposals
cannot reach the adapter.

## Failure and compatibility behavior

- Capture feature flags and kill switches use the Sprint 00 runtime controls.
- A disabled model path or active Capture kill switch selects rules-only
  extraction; Capture itself remains available.
- Confirmation is scoped, idempotent, and rejects unknown selections.
- The adapter evaluates the complete command batch against a private candidate
  state before committing it, preventing partial mutation.
- Audit envelopes contain a SHA-256 input hash and length, never raw input,
  prompt, title, or transcript.
- Existing web Capture behavior is unchanged. This boundary is additive and is
  not enabled as a production route in Sprint 01.

## Capture kinds subfeature

`MAYBESITTER_FEATURE_CAPTURE_KINDS` extends the mobile proposal boundary with
habit, goal, and thought-entry points. It defaults off, its kill switch wins,
and production is hard-denied in code regardless of the flag. While it is off,
the legacy capture wire omits all v8 fields.

Confirmation remains proposal-only until one atomic transaction writes every
selected family. Chat-created habits use `source: 'capture_chat'`, retain the
proposal id in their confirmation, and materialize their occurrences through
the habit-domain builders. Goals are user-stated memory records with
`provenance.origin: 'capture'` and `originRef` set to the proposal id. Thought
seeds use `source: 'capture'` and the same proposal id as `sourceRef`. These
records therefore remain attributable in account export and are covered by the
same per-account deletion path as their collections.

## Migration

No stored-state migration is required. Consumers may adopt the v1 proposal and
confirmation contracts incrementally. Until a consumer is migrated, the new
boundary has no production traffic and does not alter the existing route.

## Rollback

First activate `MAYBESITTER_KILL_SWITCH_CAPTURE=true` to force rules-only
extraction while keeping Capture available. Stop new consumers from calling the
boundary, allow or reject already-issued proposals explicitly, then revert the
focused #6 commit. No canonical-state rollback is required because proposal
creation never writes state and confirmation writes use existing domain
commands. Verify rollback with the contract test suite and a clean state
snapshot before and after an unconfirmed proposal.
