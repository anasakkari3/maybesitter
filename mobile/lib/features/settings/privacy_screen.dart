import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/utilities/l10n_extensions.dart';
import '../../design_system/components/maybesitter_app_bar.dart';
import '../../design_system/components/maybesitter_buttons.dart';
import '../../design_system/components/maybesitter_scaffold.dart';
import '../../design_system/theme/app_theme.dart';
import '../../design_system/tokens/radius.dart';
import '../../design_system/tokens/spacing.dart';

/// Privacy and data.
///
/// This screen used to hold three controls that did nothing: an encryption
/// switch wired to an empty callback, an analytics switch wired to another,
/// and a "Delete all data" button that showed "All local data cleared" without
/// clearing anything. A control that reports success without acting is a false
/// claim, and the fact that it looks like a control is what makes it one.
///
/// All three are gone. The two switches were never choices — nothing read them
/// — and the delete was a duplicate of a real, server-backed deletion that
/// lives in the trust centre. Rebuilding a second local delete here would have
/// been worse than removing this one: it would have deleted less than the
/// user's word for it implies, which is a quieter version of the same lie.
/// What is left states what is actually true and points at the controls that
/// actually work.
class PrivacyScreen extends ConsumerWidget {
  const PrivacyScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final colors = context.colors;

    return MaybesitterScaffold(
      appBar: MaybesitterAppBar(
        title: l10n.privacyTitle,
        subtitle: l10n.privacySubtitle,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          tooltip: l10n.backAction,
          onPressed: () => Navigator.pop(context),
        ),
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // The behaviour record: what the app observed, and how to correct it.
            _Card(
              children: [
                Material(
                  color: Colors.transparent,
                  child: ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: Icon(
                      Icons.visibility_outlined,
                      color: colors.brandPrimary,
                    ),
                    title: Text(l10n.feedbackHistoryEntryTitle),
                    subtitle: Text(l10n.feedbackHistoryEntrySubtitle),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: () => context.push('/settings/privacy/feedback-history'),
                  ),
                ),
              ],
            ),

            const SizedBox(height: AppSpacing.lg),

            // A statement, not a switch. Encryption was never something this
            // app offered to turn off, and the only thing it can honestly claim
            // to protect is the credential it puts in the platform keychain.
            _Section(
              title: l10n.privacyStorageTitle,
              children: [
                MergeSemantics(
                  child: Row(
                    children: [
                      Icon(Icons.key_outlined, size: 18, color: colors.textMuted),
                      const SizedBox(width: AppSpacing.smd),
                      Expanded(
                        child: Text(
                          l10n.privacyTokenStorageLabel,
                          style: context.text.cardTitle.copyWith(fontSize: 15),
                        ),
                      ),
                      const SizedBox(width: AppSpacing.sm),
                      Text(
                        l10n.privacyTokenStorageValue,
                        style: context.text.supporting.copyWith(
                          color: colors.textSecondary,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),

            const SizedBox(height: AppSpacing.lg),

            // Analytics, consent and deletion are real and they are elsewhere.
            // Saying so beats showing a local copy that cannot honour them.
            _Section(
              title: l10n.privacyRealControlsTitle,
              children: [
                Text(
                  l10n.privacyRealControlsMessage,
                  style: context.text.supporting,
                ),
                const SizedBox(height: AppSpacing.smd),
                SecondaryButton(
                  label: l10n.privacyOpenTrustCenterAction,
                  icon: Icons.shield_outlined,
                  onPressed: () => context.push('/settings/trust'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _Section extends StatelessWidget {
  final String title;
  final List<Widget> children;

  const _Section({required this.title, required this.children});

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Semantics(
          header: true,
          child: Text(
            title,
            style: context.text.caption.copyWith(
              color: context.colors.textMuted,
              letterSpacing: 0.6,
            ),
          ),
        ),
        const SizedBox(height: AppSpacing.sm),
        _Card(children: children),
      ],
    );
  }
}

class _Card extends StatelessWidget {
  final List<Widget> children;

  const _Card({required this.children});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Container(
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: colors.surface,
        borderRadius: AppRadius.card,
        border: Border.all(color: colors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: children,
      ),
    );
  }
}
