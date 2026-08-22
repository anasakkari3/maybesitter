import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:maybesitter_mobile/config/app_config.dart';
import 'package:maybesitter_mobile/services/providers.dart';

/// Shared override for widget/unit tests that render `MaybesitterApp` or
/// `TodayScreen` (which embeds `NextStepCard`), or that otherwise exercise
/// mock-specific fixture behavior (e.g. `MockCaptureService`'s keyword
/// splitting), without a live backend.
///
/// `AppConfig`'s default is `ApiMode.localBackend` (real extraction backend
/// by default, not a hardcoded mock) since the fix that made real extraction
/// the mobile app's default instead of `MockCaptureService`. `NextStepCard`
/// fires a real network fetch via `nextStepControllerProvider` on its first
/// frame, and `flutter test`'s fake-async sandbox cannot complete that
/// outbound `http.Client()` call, so any test rendering the full app tree
/// without this override hits an opaque `pumpAndSettle timed out` failure.
/// Explicit mock mode keeps such tests settle-able without a live backend.
final mockModeProviderOverride = appConfigProvider.overrideWith(
  (ref) => const AppConfig(apiMode: ApiMode.mock),
);

/// Convenience for tests that build their own [ProviderContainer] rather
/// than a `ProviderScope` widget tree.
ProviderContainer buildMockModeContainer({List<Override> overrides = const []}) {
  return ProviderContainer(overrides: [mockModeProviderOverride, ...overrides]);
}
