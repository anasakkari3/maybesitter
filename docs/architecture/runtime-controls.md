# Sprint 00 runtime controls

Issue #3 establishes controls before any future intelligence module is connected.
The canonical contract is `src/contracts/v1/runtimeControls.ts`.

## Defaults

Capture is enabled so current behavior is preserved. Life-State, Memory,
Priority, Planning, Recommendation, Coaching, Feedback, Safety, and Evaluation
default to disabled because their product and module gates have not passed. All
kill switches default to `false`.

Each module has two environment controls:

- `MAYBESITTER_FEATURE_<MODULE>=true|false`
- `MAYBESITTER_KILL_SWITCH_<MODULE>=true|false`

Camel-case names use underscores, for example `LIFE_STATE`. Only exact `true`
and `false` values are accepted; missing or invalid values retain the safe
default.

## Decision order and fallback

The kill switch has precedence over the feature flag. An active kill switch or
disabled feature produces a versioned `rules_only` fallback contract that:

- forbids model execution;
- forbids direct canonical-state writes;
- explicitly guarantees that capture remains available.

Runtime integration must call `resolveModuleRuntime` before invoking a module.
This Sprint 00 change defines the boundary but does not activate future modules.

## Audit privacy

`createAuditEvent` produces a structured v1 envelope with event, correlation,
causation, module, time, and outcome fields. It copies only an explicit safe
allowlist. Raw input, titles, prompts, transcripts, and other unknown fields are
dropped at runtime even if an untyped caller supplies them.

Input may be represented only by a reviewed hash and length. Hashes are
pseudonymous data and must still be handled as personal data.

## Migration and rollback

No data migration is required; controls are additive and defaults preserve the
current capture path.

Rollback procedure:

1. Set the affected module's `MAYBESITTER_KILL_SWITCH_<MODULE>` to `true`.
2. Restart the runtime so environment configuration is re-read.
3. Verify the audit event reports `fell_back` and `kill_switch_active`.
4. Confirm capture still resolves to `enabled`.
5. Remove the feature integration only after evidence is retained.

Removing the contract files is not the operational rollback path. Kill switches
must remain available during incident response.

