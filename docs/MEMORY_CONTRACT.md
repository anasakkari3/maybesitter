# Memory Contract v1.0

## Memory Kinds

All memory kinds defined in the system:
- `observation` — raw record of what the user said (ENABLED in Sprint 1)
- `commitment` — something the user intends or agreed to do (ENABLED in Sprint 1)
- `fact` — a verified piece of information about the user's life (RESERVED — Sprint 2)
- `preference` — a pattern the user prefers (RESERVED — Sprint 2)
- `hypothesis` — a system-inferred guess (RESERVED — Sprint 3)

## Sprint 1 Scope
Only `observation` and `commitment` are implemented. The types for `fact`, `preference`, and `hypothesis` exist in `memoryTypes.ts` but have no runtime code.

## Notification Policy
A commitment is eligible for notification ONLY when ALL of:
1. `status` is `"confirmed"` or `"scheduled"`
2. `dueAt` is defined
3. `confidence >= 0.85`
4. `requiresConfirmation === false`

## Commitment State Transitions
See `commitmentStateMachine.ts` for the transition table. Terminal states (`completed`, `cancelled`, `expired`) can only be reversed via a `corrected` event.

## Entity Resolution
When a new candidate arrives, the system checks open commitments for the same user within the last 30 days. Matching uses participant overlap, action similarity, temporal proximity, and semantic similarity. Scores >= 0.85 auto-link, 0.60–0.84 request confirmation, < 0.60 create new.

## Out of Scope (Sprint 1)
- Vector database
- Automatic preference learning
- Personality modeling
- Cross-app integrations
- Multi-agent architecture
