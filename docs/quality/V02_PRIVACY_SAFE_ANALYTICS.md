# V02 privacy-safe analytics

The v1 schema covers the complete narrow-loop event vocabulary from capture through recommendation decisions, reason opening, calendar consent, deletion, and pricing intent. Events contain anonymous identifiers, cohort/experiment assignment, timestamps, and event-specific scalar properties only.

Validation is strict: unknown top-level fields, event-inappropriate properties, raw-message-like keys, non-scalar values, long strings, invalid timestamps, and analytics events without consent are rejected. A deletion receipt is essential and may remain after the user's other analytics events are removed.

Reports compute unique-user activation, a fixed event funnel, Week-4 and Week-8 activity retention, calendar connection behavior, and deletion counts. The JSONL fixture is the reconciliation source for tests. Experiment assignment and ISO-week cohorts are deterministic.

Migration is additive. Rollback stops accepting v1 events and removes the report builder; deletion processing must continue until all retained v1 data reaches its deletion/retention deadline.
