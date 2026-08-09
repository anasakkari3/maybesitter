import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/utilities/l10n_extensions.dart';
import '../../design_system/components/maybesitter_buttons.dart';
import '../../design_system/theme/app_theme.dart';
import '../../design_system/tokens/spacing.dart';
import '../../services/providers.dart';
import 'pilot_session_controller.dart';

class PilotBootstrapGate extends ConsumerWidget {
  final Widget child;

  const PilotBootstrapGate({super.key, required this.child});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final config = ref.watch(appConfigProvider);
    if (config.isMock) return child;

    final session = ref.watch(pilotSessionControllerProvider);
    if (session.status == PilotSessionStatus.authorized) return child;
    return PilotAccessScreen(state: session);
  }
}

class PilotAccessScreen extends ConsumerStatefulWidget {
  final PilotSessionState state;

  const PilotAccessScreen({super.key, required this.state});

  @override
  ConsumerState<PilotAccessScreen> createState() => _PilotAccessScreenState();
}

class _PilotAccessScreenState extends ConsumerState<PilotAccessScreen> {
  final TextEditingController _tokenController = TextEditingController();

  @override
  void dispose() {
    _tokenController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final colors = context.colors;
    final state = widget.state;
    final busy =
        state.status == PilotSessionStatus.loadingCredential ||
        state.status == PilotSessionStatus.validating;
    final copy = _copyFor(context, state.status);

    return Scaffold(
      backgroundColor: colors.background,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(AppSpacing.xl),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 440),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Icon(
                    copy.icon,
                    color: copy.destructive ? colors.danger : colors.brandStrong,
                    size: 36,
                  ),
                  const SizedBox(height: AppSpacing.lg),
                  Text(
                    copy.title,
                    textAlign: TextAlign.center,
                    style: context.text.heading1,
                  ),
                  const SizedBox(height: AppSpacing.sm),
                  Text(
                    copy.message,
                    textAlign: TextAlign.center,
                    style: context.text.supporting,
                  ),
                  const SizedBox(height: AppSpacing.xl),
                  if (state.status == PilotSessionStatus.noCredential ||
                      state.status == PilotSessionStatus.unauthorized) ...[
                    TextField(
                      controller: _tokenController,
                      obscureText: true,
                      enableSuggestions: false,
                      autocorrect: false,
                      decoration: InputDecoration(
                        labelText: l10n.pilotAccessTokenLabel,
                      ),
                      textInputAction: TextInputAction.done,
                      onSubmitted: (_) => _submit(),
                    ),
                    const SizedBox(height: AppSpacing.lg),
                    PrimaryButton(
                      label: l10n.pilotAccessContinue,
                      icon: Icons.lock_open_rounded,
                      onPressed: busy ? null : _submit,
                      isLoading: busy,
                    ),
                  ] else if (busy) ...[
                    const Center(child: CircularProgressIndicator()),
                  ] else ...[
                    PrimaryButton(
                      label: l10n.retryAction,
                      icon: Icons.refresh_rounded,
                      onPressed: () => ref
                          .read(pilotSessionControllerProvider.notifier)
                          .load(),
                    ),
                    if (!state.isTerminal) ...[
                      const SizedBox(height: AppSpacing.sm),
                      SecondaryButton(
                        label: l10n.pilotAccessClearToken,
                        icon: Icons.key_off_rounded,
                        onPressed: () => ref
                            .read(pilotSessionControllerProvider.notifier)
                            .clearCredential(),
                      ),
                    ],
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _submit() async {
    await ref
        .read(pilotSessionControllerProvider.notifier)
        .submitToken(_tokenController.text);
  }

  _PilotAccessCopy _copyFor(
    BuildContext context,
    PilotSessionStatus status,
  ) {
    final l10n = context.l10n;
    return switch (status) {
      PilotSessionStatus.loadingCredential ||
      PilotSessionStatus.validating => _PilotAccessCopy(
        title: l10n.pilotAccessValidating,
        message: l10n.pilotAccessMessage,
        icon: Icons.lock_clock_rounded,
      ),
      PilotSessionStatus.unauthorized => _PilotAccessCopy(
        title: l10n.pilotAccessInvalidTitle,
        message: l10n.pilotAccessInvalidMessage,
        icon: Icons.lock_outline_rounded,
        destructive: true,
      ),
      PilotSessionStatus.notAllowlisted => _PilotAccessCopy(
        title: l10n.pilotAccessNotAllowlistedTitle,
        message: l10n.pilotAccessNotAllowlistedMessage,
        icon: Icons.person_off_outlined,
        destructive: true,
      ),
      PilotSessionStatus.revoked => _PilotAccessCopy(
        title: l10n.pilotAccessRevokedTitle,
        message: l10n.pilotAccessRevokedMessage,
        icon: Icons.block_outlined,
      ),
      PilotSessionStatus.deleted => _PilotAccessCopy(
        title: l10n.pilotAccessDeletedTitle,
        message: l10n.pilotAccessDeletedMessage,
        icon: Icons.delete_outline_rounded,
      ),
      PilotSessionStatus.backendUnavailable => _PilotAccessCopy(
        title: l10n.pilotAccessBackendUnavailableTitle,
        message: l10n.pilotAccessBackendUnavailableMessage,
        icon: Icons.cloud_off_rounded,
      ),
      PilotSessionStatus.invalidPilotRuntimeConfig => _PilotAccessCopy(
        title: l10n.pilotAccessRuntimeConfigTitle,
        message: l10n.pilotAccessRuntimeConfigMessage,
        icon: Icons.error_outline_rounded,
        destructive: true,
      ),
      PilotSessionStatus.noCredential ||
      PilotSessionStatus.authorized => _PilotAccessCopy(
        title: l10n.pilotAccessTitle,
        message: l10n.pilotAccessMessage,
        icon: Icons.lock_outline_rounded,
      ),
    };
  }
}

class _PilotAccessCopy {
  final String title;
  final String message;
  final IconData icon;
  final bool destructive;

  const _PilotAccessCopy({
    required this.title,
    required this.message,
    required this.icon,
    this.destructive = false,
  });
}
