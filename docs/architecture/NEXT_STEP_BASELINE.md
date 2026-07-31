# Deterministic next-step baseline

The V02 baseline ranks only confirmed, non-closed commitments. Allowed evidence is explicit due/reminder time, lateness derived from that time, user-selected importance, explicitly supplied effort, and the caller-provided current time.

Hard exclusions run before ranking: unconfirmed and closed commitments are ineligible, and malformed explicit times fail closed. A candidate with no explicit evidence produces no recommendation. Ranking is lexicographic: overdue, upcoming urgency, explicit importance, shorter explicit effort, then commitment ID. This makes replay independent of input order.

Every selected result is converted to the V02 proposal/explanation contract and retains confirmation-before-persistence. `compareVariantSelection` reports whether a future variant agrees with the locked baseline while preserving the baseline evidence labels.

Migration is additive. Rollback removes the baseline service and fixture without changing canonical domain state or Capture behavior.
