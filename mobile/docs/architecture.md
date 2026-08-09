# Architecture Overview — Maybesitter Mobile

## Overview
The Maybesitter Mobile application is built with **Flutter (v3.44.8)** and **Dart (v3.12.2)** targeting iOS and Android platforms. It follows a clean, feature-driven architecture decoupled from any specific backend implementation through explicit service contracts.

## Architecture Layers

```text
mobile/lib/
├── app/                  # Application bootstrap, root widget, GoRouter setup
├── core/                 # Shared utilities, Result pattern, Failure classes, platform helpers
├── design_system/        # Stitch design tokens (colors, spacing, typography, themes) & shared UI library
├── models/               # Immutable UI data models (Commitment, CaptureResult, AppSettings, ActivityEvent)
├── services/             # Abstract service contracts & Mock implementations
│   ├── contracts/        # CommitmentRepository, CaptureService, ActivityRepository, NotificationService, ConnectivityService
│   └── mock/             # InMemoryCommitmentRepository, MockCaptureService, MockActivityRepository, etc.
└── features/             # Feature-oriented screen modules
    ├── onboarding/       # Welcome and onboarding flow
    ├── today/            # Today's focus & commitments agenda
    ├── upcoming/         # Multi-day upcoming agenda & calendar view
    ├── capture/          # Voice/text capture, AI extraction review, clarification, & success save flow
    ├── commitment_details/# Commitment detail view, postpone sheet, & editing
    ├── activity/         # Timeline log of AI extractions & commitment completions
    └── settings/         # Theme preference, notifications, & data privacy settings
```

## State Management & Dependency Injection
- **Riverpod (`flutter_riverpod`)**: Used as the single source of truth for UI state management and service dependency injection.
- Service contracts (e.g., `CommitmentRepository`) are exposed via Riverpod `Provider` instances.
- Feature logic and async flows (e.g., `CaptureNotifier`) use `StateNotifier`.

## Navigation
- **GoRouter (`go_router`)**: Provides declarative, type-safe navigation.
- Bottom navigation tabs (`/today`, `/upcoming`, `/activity`, `/settings`) use a `ShellRoute`.
- Modal flows (`/capture`, `/capture/review`, `/capture/clarification`, `/capture/success`, `/commitments/:id`) present root navigator routes with modal transitions.

## Isolation Invariant
- Backend and AI extraction models are strictly mocked on the mobile frontend.
- No Ollama, Gemma, Python pipelines, or API keys are placed in `mobile/`.
