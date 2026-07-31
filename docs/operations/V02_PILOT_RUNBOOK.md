# V02 pilot operations and rollback

Operational owner: **Anas Akkari**

Responsibilities:

- monitor pilot failures
- activate kill switch
- approve rollback
- review privacy incidents

## Controls

V02 recommendation remains off unless `MAYBESITTER_FEATURE_RECOMMENDATION=true`. Immediately stop recommendation exposure with `MAYBESITTER_KILL_SWITCH_RECOMMENDATION=true`; Capture remains available. Restart the application after an environment change and verify `/assistant` reports insufficient evidence instead of a recommendation.

## Monitoring and incident response

Monitor recommendation endpoint errors, invalid analytics rejections, confirmation-boundary failures, and privacy/deletion incidents. On a persistence or privacy concern, activate the kill switch first, preserve privacy-safe event IDs and timestamps, notify Anas Akkari, and do not copy raw user messages into the incident record.

## Rollback

Anas Akkari approves rollback. Keep the kill switch active, revert the integrated V02 candidate, and retain deletion processing for already collected v1 analytics until retention obligations are satisfied. Re-enable only after the full V02 gate is rerun on a named SHA.
