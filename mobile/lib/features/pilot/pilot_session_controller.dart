import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../config/app_config.dart';
import '../../models/pilot_trust.dart';
import '../../services/api/api_client.dart';
import '../../services/auth/pilot_credential_store.dart';
import '../../services/contracts/pilot_trust_service.dart';

enum PilotSessionStatus {
  loadingCredential,
  noCredential,
  validating,
  authorized,
  unauthorized,
  notAllowlisted,
  revoked,
  deleted,
  backendUnavailable,
  invalidPilotRuntimeConfig,
}

class PilotSessionState {
  final PilotSessionStatus status;
  final PilotTrustSnapshot? snapshot;
  final PilotStopReason? reason;

  const PilotSessionState({
    required this.status,
    this.snapshot,
    this.reason,
  });

  bool get isTerminal =>
      status == PilotSessionStatus.revoked ||
      status == PilotSessionStatus.deleted;
}

class PilotSessionNotifier extends StateNotifier<PilotSessionState> {
  final AppConfig config;
  final PilotCredentialStore credentialStore;
  final PilotTrustService trustService;

  PilotSessionNotifier({
    required this.config,
    required this.credentialStore,
    required this.trustService,
  }) : super(
         const PilotSessionState(
           status: PilotSessionStatus.loadingCredential,
         ),
       ) {
    load();
  }

  Future<void> load() async {
    if (config.isMock) {
      state = const PilotSessionState(status: PilotSessionStatus.authorized);
      return;
    }

    state = const PilotSessionState(
      status: PilotSessionStatus.loadingCredential,
    );
    final token = (await credentialStore.readToken())?.trim();
    if (!mounted) return;
    if (token == null || token.isEmpty) {
      state = const PilotSessionState(status: PilotSessionStatus.noCredential);
      return;
    }
    await _validateStoredCredential();
  }

  Future<void> submitToken(String token) async {
    if (config.isMock) {
      state = const PilotSessionState(status: PilotSessionStatus.authorized);
      return;
    }

    final trimmed = token.trim();
    if (trimmed.isEmpty) {
      state = const PilotSessionState(status: PilotSessionStatus.noCredential);
      return;
    }
    await credentialStore.writeToken(trimmed);
    await _validateStoredCredential(clearInvalidCredential: true);
  }

  Future<void> clearCredential() async {
    await credentialStore.deleteToken();
    if (!mounted) return;
    state = const PilotSessionState(status: PilotSessionStatus.noCredential);
  }

  Future<void> markRevoked() async {
    if (!mounted) return;
    state = const PilotSessionState(status: PilotSessionStatus.revoked);
  }

  Future<void> markDeleted() async {
    await credentialStore.deleteToken();
    if (!mounted) return;
    state = const PilotSessionState(status: PilotSessionStatus.deleted);
  }

  Future<void> _validateStoredCredential({
    bool clearInvalidCredential = false,
  }) async {
    state = const PilotSessionState(status: PilotSessionStatus.validating);
    try {
      final snapshot = await trustService.getSnapshot();
      if (!mounted) return;
      if (snapshot.trust.isDeleted ||
          snapshot.exposure.reason == PilotStopReason.deleted) {
        state = PilotSessionState(
          status: PilotSessionStatus.deleted,
          snapshot: snapshot,
          reason: PilotStopReason.deleted,
        );
        return;
      }
      if (snapshot.trust.isRevoked ||
          snapshot.exposure.reason == PilotStopReason.revoked) {
        state = PilotSessionState(
          status: PilotSessionStatus.revoked,
          snapshot: snapshot,
          reason: PilotStopReason.revoked,
        );
        return;
      }
      state = PilotSessionState(
        status: PilotSessionStatus.authorized,
        snapshot: snapshot,
        reason: snapshot.exposure.reason,
      );
    } on UnauthorizedException catch (error) {
      if (clearInvalidCredential) {
        await credentialStore.deleteToken();
      }
      if (!mounted) return;
      state = PilotSessionState(
        status: PilotSessionStatus.unauthorized,
        reason: PilotStopReason.fromJsonString(error.reason),
      );
    } on PilotNotAdmittedException catch (error) {
      if (!mounted) return;
      state = PilotSessionState(
        status: _statusForPilotReason(error.reason),
        reason: error.reason,
      );
    } on OperatorConfigurationException {
      if (!mounted) return;
      state = const PilotSessionState(
        status: PilotSessionStatus.invalidPilotRuntimeConfig,
      );
    } on NetworkException {
      if (!mounted) return;
      state = const PilotSessionState(
        status: PilotSessionStatus.backendUnavailable,
      );
    } catch (_) {
      if (!mounted) return;
      state = const PilotSessionState(
        status: PilotSessionStatus.backendUnavailable,
      );
    }
  }

  PilotSessionStatus _statusForPilotReason(PilotStopReason reason) {
    return switch (reason) {
      PilotStopReason.notAllowlisted || PilotStopReason.wrongInstance =>
        PilotSessionStatus.notAllowlisted,
      PilotStopReason.revoked => PilotSessionStatus.revoked,
      PilotStopReason.deleted => PilotSessionStatus.deleted,
      _ => PilotSessionStatus.unauthorized,
    };
  }
}
