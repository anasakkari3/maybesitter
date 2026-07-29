import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/utilities/l10n_extensions.dart';
import '../../design_system/components/maybesitter_buttons.dart';
import '../../design_system/theme/app_theme.dart';
import '../../design_system/tokens/spacing.dart';
import '../../services/providers.dart';

class OnboardingScreen extends ConsumerWidget {
  const OnboardingScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final colors = context.colors;
    final l10n = context.l10n;

    return Scaffold(
      backgroundColor: colors.background,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.xl),
          child: Column(
            children: [
              const Spacer(),
              Container(
                padding: const EdgeInsets.all(AppSpacing.xl),
                decoration: BoxDecoration(
                  color: colors.brandPrimary.withValues(alpha: 0.15),
                  shape: BoxShape.circle,
                ),
                child: Icon(
                  Icons.auto_awesome,
                  size: 64,
                  color: colors.brandPrimary,
                ),
              ),
              const SizedBox(height: AppSpacing.xl),
              Text(
                l10n.welcomeTitle,
                textAlign: TextAlign.center,
                style: context.text.display,
              ),
              const SizedBox(height: AppSpacing.md),
              Text(
                l10n.welcomeSubtitle,
                textAlign: TextAlign.center,
                style: context.text.body.copyWith(
                  color: colors.textSecondary,
                  height: 1.5,
                ),
              ),
              const Spacer(),
              PrimaryButton(
                label: l10n.getStartedAction,
                onPressed: () {
                  ref.read(appSettingsProvider.notifier).completeOnboarding();
                  context.go('/today');
                },
              ),
              const SizedBox(height: AppSpacing.md),
            ],
          ),
        ),
      ),
    );
  }
}
