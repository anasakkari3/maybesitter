# V03 Lane C: Mobile Operational & Device Readiness Audit Report

**Date**: 2026-08-09  
**Branch**: `ops/v03-mobile-readiness`  
**Status**: `LANE C COMPLETE`

---

## Executive Summary & Readiness Verdicts

| Domain | Readiness Verdict | Key Status / Blocker Summary |
| :--- | :--- | :--- |
| **ANDROID** | **`READY`** | Toolchain installed & verified (`Android SDK 36`, `Build-Tools 36.0.0`, `OpenJDK 17/21`, `Gradle 9.1.0`, accepted licenses). `flutter build apk --debug` succeeded (`✓ 153MB APK built`). Repository working tree clean. |
| **IOS PHYSICAL / TESTFLIGHT** | **`BLOCKED`** | Blocked by code signing, bundle ID registration, and missing App Store distribution credentials. Xcode simulator succeeds, but physical device and TestFlight distribution cannot proceed without explicit provisioning setup. |
| **PILOT BACKEND DEPLOYMENT** | **`DESIGN READY`** | Deployment architecture designed as a candidate for 25–40 mobile-only participants. Legacy `/assistant` web UI completely excluded. Deployment implementation frozen pending #79 port completion and canonical backend alignment. |

---

## A. Android Operational Readiness

### 1. Toolchain Setup & Environment Verification
The Android development toolchain was configured on the macOS host without altering tracked repository files:

* **Flutter SDK**: `3.44.8` (Channel stable, Dart `3.12.2`)
* **Android SDK Root**: `/opt/homebrew/share/android-commandlinetools`
* **Installed Platforms**: `android-36`, `android-35`, `android-34`
* **Installed Build Tools**: `36.0.0`, `35.0.0`, `34.0.0`, `28.0.3`
* **Java/JDK Compatibility**: OpenJDK 17 (`/opt/homebrew/opt/openjdk@17`) and Android Studio bundled JDK (Java 21.0.10) verified.
* **Gradle & AGP**: Gradle `9.1.0` with Android Gradle Plugin `com.android.application` `9.0.1` and Kotlin `2.3.20`.
* **SDK Licenses**: All Android SDK licenses accepted (`sdkmanager --licenses`).

`flutter doctor -v` output:
```
[✓] Flutter (Channel stable, 3.44.8, on macOS 26.5.2 25F84 darwin-arm64)
[✓] Android toolchain - develop for Android devices (Android SDK version 35.0.0)
    • Platform android-36, build-tools 35.0.0
    • Java binary at: /Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java
    • All Android licenses accepted.
[✓] Xcode - develop for iOS and macOS (Xcode 26.6)
[✓] Connected device (3 available)
• No issues found!
```

### 2. Build Verification
Ran debug APK build from `mobile/`:
```bash
flutter build apk --debug
```
**Result**: `✓ Built build/app/outputs/flutter-apk/app-debug.apk` (153.3 MB, exit code `0`).

### 3. Repository Changes & Technical Debt
* **Repository Changes**: `0` tracked code changes required for build capability.
* **Documented Technical Debt**:
  1. **Kotlin Gradle Plugin (KGP) Warning**: `flutter_timezone` plugin applies legacy KGP. Future Flutter releases will require upgrading this dependency to support Built-in Kotlin.
  2. **SDK Location Notice**: `cmdline-tools;latest` location warning autodetected during package installation (non-fatal, build succeeded).

---

## B. iOS Operational Readiness Audit

Simulator builds currently succeed, but physical device deployment and TestFlight distribution are **`BLOCKED`**.

### Detailed iOS Blockers:

1. **Code Signing Identity Missing**:
   * Machine Keychain inspect (`security find-identity -v -p codesigning`) reveals only `Apple Development: anas392004@icloud.com (9759F6688X)`.
   * **Missing**: No `Apple Distribution` certificate exists for TestFlight / App Store IPA archiving.

2. **Development Team Mismatch**:
   * Xcode project (`Runner.xcodeproj/project.pbxproj`) defines `DEVELOPMENT_TEAM = S44ZPQ3K3F`.
   * Local certificate team ID is `9759F6688X`. Automatic provisioning fails without an active developer session for `S44ZPQ3K3F`.

3. **Bundle Identifier Registration**:
   * Current Bundle ID: `com.maybesitter.maybesitterMobile`.
   * **Missing**: Needs explicit registration on App Store Connect under the organization's paid Developer Account.

4. **Physical Device UDID Provisioning**:
   * Physical iPhone testing requires target device UDIDs (e.g. connected iPhone `00008130-0019441136D1001C`) to be registered in the Apple Developer Portal under a Development Provisioning Profile.

5. **TestFlight Automated Export Setup**:
   * `flutter build ipa` requires an App Store Distribution Provisioning Profile, Export Options Plist (`method: app-store`), and App Store Connect API Key (`KeyID`, `IssuerID`, `.p8` private key) for automated upload.

---

## C. Pilot Deployment Architecture (Candidate Design Specification)

Architecture for **25–40 pilot participants** in a mobile-only environment:

### Operational Guidance & Constraints
* **Scope Lock**: Design candidate only. Do NOT implement Postgres migration, JWT auth, RLS, multi-tenant persistence, or Cloud Run/ECS infrastructure until issue #79 lands and the post-#79 canonical backend decision is finalized.
* **Web UI Status**: The legacy `/assistant` web interface is strictly excluded. Mobile clients only interface with canonical `/api/mobile/*` endpoints.

### Candidate Architectural Summary
1. **Hosting Model**: Containerized Node.js service (Cloud Run / ECS Fargate).
2. **Ingress**: TLS 1.3 `api-pilot.maybesitter.com` with Cloudflare WAF protection.
3. **Data Model**: Multi-tenant database or isolated persistent volumes per participant.
4. **Kill Switch**: Global (`PILOT_KILL_SWITCH_ENABLED=true` $\rightarrow$ 503) and per-participant token revocation.
5. **Backups**: Daily automated snapshots with Point-In-Time Recovery (PITR).
