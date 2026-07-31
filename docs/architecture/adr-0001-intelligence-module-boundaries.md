# ADR 0001 — Intelligence module boundaries and contracts (Sprint 00)

## Status
Accepted (Sprint 00).

## Context
Sprint 00 issue #1 requires enforceable boundaries across:

- Capture
- Life-State
- Memory
- Priority
- Planning
- Recommendation
- Coaching
- Feedback
- Safety
- Evaluation

The approved wedge is still narrow. Most modules above must remain non-operative until their roadmap gates pass. We still need one consistent contract surface now so later sprints can integrate without reworking ownership, dependency direction, or write rules.

## Decision
1. **Versioned contracts**  
   We define `src/contracts/v1/moduleContracts.ts` as the canonical v1 TypeScript contract registry for all intelligence modules, including:
   - input/output envelope shape
   - error vocabulary
   - provenance envelope
   - explicit write policy (`allowsDirectStateWrites: false`)

2. **Dependency direction (enforced policy)**  
   Intelligence modules may depend only on:
   - contracts
   - deterministic services
   - adapters

   They may not directly depend on persistence internals.

3. **State-write rule**  
   Intelligence modules must never write canonical user state directly.  
   Required path:

   `Intelligence -> deterministic service command -> persistence adapter`

4. **Hard constraints stay deterministic**  
   All state mutations and hard validation constraints remain in deterministic services (`commandService`, `stateMachine`, and boundary validators such as timezone validation).

5. **Current-wedge safeguard**  
   Non-Capture modules in `v1` are intentionally non-operative placeholders with stable contracts, preventing accidental activation before their sprint gates.

## Ownership
- Backend owns module contracts and deterministic write pathways.
- Future sprint teams implement module internals behind the existing contracts.

## Consequences
- Integrations can start against stable contracts without enabling future modules.
- Boundary violations can be detected by contract tests before merge.
- Capture can evolve while preserving architectural invariants expected by later sprints.

## Migration and rollback

This change adds contracts and routes the existing Capture command application
through a deterministic gateway; it does not change stored state or require a
data migration. Existing Capture behavior remains the default.

To roll back an integration, first use the runtime controls documented in
`runtime-controls.md` to force the affected module to rules-only operation while
retaining Capture. Revert the gateway wiring only after confirming that no
canonical state write bypasses `commandService`; removing the contracts alone
is not a safe operational rollback.
