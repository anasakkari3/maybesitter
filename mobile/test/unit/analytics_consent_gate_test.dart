/// Analytics follow the consent the user actually gave.
///
/// The provider used to read AppSettings.analyticsOptOut, which defaulted to
/// true, was never persisted, and had no setter anywhere -- so every pilot
/// event was silently discarded while the Trust Center showed a consent toggle
/// that changed nothing.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:maybesitter_mobile/features/trust/pilot_trust_controller.dart';
import 'package:maybesitter_mobile/models/pilot_trust.dart';
import 'package:maybesitter_mobile/services/mock/in_memory_pilot_loop_analytics_service.dart';
import 'package:maybesitter_mobile/services/providers.dart';

PilotTrustUiState _loaded({required bool analyticsConsent}) {
  return PilotTrustUiState(
    status: PilotTrustStatus.ready,
    snapshot: PilotTrustSnapshot(
      trust: PilotTrustState(
        participantId: 'p1',
        recommendationConsent: true,
        analyticsConsent: analyticsConsent,
        calendarConsent: false,
        quietMode: false,
        updatedAt: DateTime(2026, 8, 20),
      ),
      exposure: const PilotExposureDecision(
        allowed: true,
        reason: PilotStopReason.authorized,
      ),
      whatKnows: WhatMaybeSitterKnows(
        participantId: 'p1',
        confirmedCommitmentCount: 0,
        recommendationConsent: true,
        analyticsConsent: analyticsConsent,
        calendarConnected: false,
      ),
    ),
  );
}

ProviderContainer _container(PilotTrustUiState trustState) {
  return ProviderContainer(
    overrides: [
      pilotTrustControllerProvider.overrideWith(
        (ref) => _StubTrustNotifier(trustState),
      ),
    ],
  );
}

class _StubTrustNotifier extends StateNotifier<PilotTrustUiState>
    implements PilotTrustNotifier {
  _StubTrustNotifier(super.state);

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  test('without recorded consent, analytics are disabled', () {
    final container = _container(_loaded(analyticsConsent: false));
    addTearDown(container.dispose);

    expect(
      container.read(pilotLoopAnalyticsServiceProvider),
      isA<DisabledPilotLoopAnalyticsService>(),
    );
  });

  test('while trust state is still loading, analytics stay disabled', () {
    final container = _container(const PilotTrustUiState());
    addTearDown(container.dispose);

    // Not knowing yet is not consent.
    expect(
      container.read(pilotLoopAnalyticsServiceProvider),
      isA<DisabledPilotLoopAnalyticsService>(),
    );
  });

  test('with recorded consent, analytics are no longer disabled', () {
    final container = _container(_loaded(analyticsConsent: true));
    addTearDown(container.dispose);

    expect(
      container.read(pilotLoopAnalyticsServiceProvider),
      isNot(isA<DisabledPilotLoopAnalyticsService>()),
    );
  });
}
