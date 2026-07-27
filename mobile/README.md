# Maybesitter Mobile Application

Flutter mobile application for iOS and Android built following the **Google Stitch** visual design system (`projects/5784545255932247559`).

## Prerequisites & Tool Versions
- **Flutter**: 3.44.8 (stable channel)
- **Dart**: 3.12.2 (stable)
- **OS**: macOS (arm64)

## Architecture & Structure
```text
mobile/
├── android/              # Native Android configuration
├── ios/                  # Native iOS configuration
├── assets/               # Scalable icons & raster assets
├── lib/
│   ├── app/              # App bootstrap, router, & root widget
│   ├── design_system/    # Stitch tokens (colors, spacing, typography) & component library
│   ├── core/             # Result pattern, Failure classes, & Date formatters
│   ├── models/           # UI models (Commitment, CaptureResult, AppSettings, ActivityEvent)
│   ├── services/         # Contracts & Mock service implementations
│   └── features/         # Onboarding, Today, Upcoming, Capture, Details, Activity, Settings
├── test/                 # Unit & widget tests
├── integration_test/     # E2E capture demonstration integration test
└── docs/                 # Architecture, Design system, Screen map, & Backend boundary docs
```

## Running the Application

### Install Dependencies
```bash
cd mobile
flutter pub get
```

### Run Analyzer & Tests
```bash
flutter analyze
flutter test
```

### Run on Simulator / Device
```bash
# Run on iOS Simulator
flutter run -d iPhone

# Run on Android Emulator
flutter run -d android
```

## Demo Flow Preview (Doctor / Work Capture Flow)
1. Open the app (`/today`).
2. Tap the floating **Capture Plan** button (`/capture`).
3. Enter or keep default text: `"Tomorrow I will go to the doctor and then work."`
4. Tap **Analyze** (`auto_awesome`).
5. Review the 2 extracted commitments:
   - **Must**: Go to the doctor (Tomorrow, 09:00 AM)
   - **Should**: Work afterward (Tomorrow, 11:30 AM)
6. Tap **Confirm 2 Commitments**.
7. Observe the **Success Save** confirmation (`/capture/success`) with **View Tomorrow** and **Undo** options.
8. Tap **View Tomorrow** to verify both commitments in the **Upcoming Agenda** (`/upcoming`).

## Fixture Preview Switcher
On the Capture Composer screen (`/capture`), expand the **Dev Fixture Previews** panel at the bottom to instantly preview:
- 2 Items Review (`needsConfirmation`)
- Clarification Needed (`needsClarification`)
- Nothing Found (`noCommitment`)
- Extraction Error (`extractionFailed`)

## Documentation Index
- [Architecture Overview](docs/architecture.md)
- [Design System & Tokens](docs/design-system.md)
- [Stitch Screen Map](docs/stitch-screen-map.md)
- [Backend Integration Boundary](docs/backend-integration.md)
- [Testing Strategy](docs/testing.md)
