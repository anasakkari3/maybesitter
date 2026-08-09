import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/pilot_trust.dart';
import '../../services/contracts/pilot_trust_service.dart';
import '../../services/providers.dart';

enum PilotTrustStatus { loading, ready, notAdmitted, failed }

class PilotTrustUiState {
  final PilotTrustStatus status;
  final PilotTrustSnapshot? snapshot;
  final PilotStopReason? notAdmittedReason;

  /// True while an action is in flight. Controls are disabled rather than
  /// hidden, so the participant never loses sight of what exists.
  final bool applying;

  const PilotTrustUiState({
    this.status = PilotTrustStatus.loading,
    this.snapshot,
    this.notAdmittedReason,
    this.applying = false,
  });

  PilotTrustUiState copyWith({
    PilotTrustStatus? status,
    PilotTrustSnapshot? snapshot,
    PilotStopReason? notAdmittedReason,
    bool? applying,
  }) => PilotTrustUiState(
    status: status ?? this.status,
    snapshot: snapshot ?? this.snapshot,
    notAdmittedReason: notAdmittedReason ?? this.notAdmittedReason,
    applying: applying ?? this.applying,
  );
}

class PilotTrustNotifier extends StateNotifier<PilotTrustUiState> {
  final PilotTrustService service;
  final String participantId;

  PilotTrustNotifier({required this.service, required this.participantId})
    : super(const PilotTrustUiState()) {
    load();
  }

  Future<void> load() async {
    state = state.copyWith(status: PilotTrustStatus.loading);
    try {
      final snapshot = await service.getSnapshot(
        participantId: participantId,
      );
      // load() is kicked off from the constructor, so a short-lived widget can
      // be disposed before the request returns.
      if (!mounted) return;
      state = PilotTrustUiState(
        status: PilotTrustStatus.ready,
        snapshot: snapshot,
      );
    } on PilotNotAdmittedException catch (error) {
      if (!mounted) return;
      state = PilotTrustUiState(
        status: PilotTrustStatus.notAdmitted,
        notAdmittedReason: error.reason,
      );
    } catch (_) {
      if (!mounted) return;
      state = const PilotTrustUiState(status: PilotTrustStatus.failed);
    }
  }

  Future<void> apply(PilotTrustAction action) async {
    state = state.copyWith(applying: true);
    try {
      final snapshot = await service.apply(
        participantId: participantId,
        action: action,
      );
      if (!mounted) return;
      state = PilotTrustUiState(
        status: PilotTrustStatus.ready,
        snapshot: snapshot,
      );
    } on PilotNotAdmittedException catch (error) {
      if (!mounted) return;
      state = PilotTrustUiState(
        status: PilotTrustStatus.notAdmitted,
        notAdmittedReason: error.reason,
      );
    } catch (_) {
      if (!mounted) return;
      // Keep the last known snapshot on screen. Blanking the trust controls
      // because one request failed would be worse than showing stale state.
      state = state.copyWith(
        status: PilotTrustStatus.failed,
        applying: false,
      );
    }
  }
}

final pilotTrustControllerProvider =
    StateNotifierProvider<PilotTrustNotifier, PilotTrustUiState>((ref) {
      return PilotTrustNotifier(
        service: ref.watch(pilotTrustServiceProvider),
        participantId: ref.watch(appConfigProvider).participantId,
      );
    });
