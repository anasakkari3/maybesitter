# Testing Strategy — Maybesitter Mobile

## Overview
The mobile app contains comprehensive unit, widget, and integration tests to ensure visual and behavioral fidelity to the Google Stitch design.

## Running Tests
Run all unit and widget tests:
```bash
cd mobile
flutter test
```

Run integration test:
```bash
cd mobile
flutter test integration_test/app_test.dart
```

## Test Coverage
- **Unit Tests**:
  - `test/unit/commitment_model_test.dart`: Serialization, deserialization, `copyWith`.
  - `test/unit/capture_controller_test.dart`: Extraction state transitions (`idle` -> `submitting` -> `needsConfirmation` -> `saved`).
  - `test/unit/in_memory_repository_test.dart`: Seeded data, completion toggles, postpone actions.
  - `test/unit/date_formatter_test.dart`: Date header formatting and range helpers.

- **Widget & Integration Tests**:
  - `test/widget_test.dart`: Root `MaybesitterApp` rendering test.
  - `integration_test/app_test.dart`: End-to-end capture demonstration flow.
