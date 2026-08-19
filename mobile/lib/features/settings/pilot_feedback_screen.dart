import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/utilities/l10n_extensions.dart';
import '../../design_system/components/maybesitter_app_bar.dart';
import '../../design_system/components/maybesitter_buttons.dart';
import '../../design_system/components/maybesitter_scaffold.dart';
import '../../design_system/components/maybesitter_segmented_control.dart';
import '../../design_system/theme/app_theme.dart';
import '../../design_system/tokens/radius.dart';
import '../../design_system/tokens/spacing.dart';
import '../../models/pilot_loop_analytics.dart';
import '../../services/providers.dart';

enum _PilotSurface { widget, voice, notification, calendar, import }

enum _UsefulnessChoice { high, some, notYet }

enum _AnnoyanceChoice { calm, fine, tooMuch }

enum _TimingChoice { early, right, late, notUsing }

class PilotFeedbackScreen extends ConsumerStatefulWidget {
  const PilotFeedbackScreen({super.key});

  @override
  ConsumerState<PilotFeedbackScreen> createState() =>
      _PilotFeedbackScreenState();
}

class _PilotFeedbackScreenState extends ConsumerState<PilotFeedbackScreen> {
  _PilotSurface _surface = _PilotSurface.widget;
  _UsefulnessChoice _usefulness = _UsefulnessChoice.some;
  _AnnoyanceChoice _annoyance = _AnnoyanceChoice.fine;
  _TimingChoice _timing = _TimingChoice.right;
  bool _submitting = false;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;

    return MaybesitterScaffold(
      appBar: MaybesitterAppBar(
        title: l10n.pilotFeedbackTitle,
        subtitle: l10n.pilotFeedbackSubtitle,
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _FeedbackSection<_PilotSurface>(
              title: l10n.pilotFeedbackSurfaceTitle,
              value: _surface,
              options: {
                _PilotSurface.widget: l10n.pilotFeedbackSurfaceWidget,
                _PilotSurface.voice: l10n.pilotFeedbackSurfaceVoice,
                _PilotSurface.notification:
                    l10n.pilotFeedbackSurfaceNotification,
                _PilotSurface.calendar: l10n.pilotFeedbackSurfaceCalendar,
                _PilotSurface.import: l10n.pilotFeedbackSurfaceImport,
              },
              onChanged: (value) => setState(() => _surface = value),
            ),
            _FeedbackSection<_UsefulnessChoice>(
              title: l10n.pilotFeedbackUsefulnessTitle,
              value: _usefulness,
              options: {
                _UsefulnessChoice.high: l10n.pilotFeedbackUsefulnessHigh,
                _UsefulnessChoice.some: l10n.pilotFeedbackUsefulnessSome,
                _UsefulnessChoice.notYet: l10n.pilotFeedbackUsefulnessNotYet,
              },
              onChanged: (value) => setState(() => _usefulness = value),
            ),
            _FeedbackSection<_AnnoyanceChoice>(
              title: l10n.pilotFeedbackAnnoyanceTitle,
              value: _annoyance,
              options: {
                _AnnoyanceChoice.calm: l10n.pilotFeedbackAnnoyanceCalm,
                _AnnoyanceChoice.fine: l10n.pilotFeedbackAnnoyanceFine,
                _AnnoyanceChoice.tooMuch: l10n.pilotFeedbackAnnoyanceTooMuch,
              },
              onChanged: (value) => setState(() => _annoyance = value),
            ),
            _FeedbackSection<_TimingChoice>(
              title: l10n.pilotFeedbackTimingTitle,
              value: _timing,
              options: {
                _TimingChoice.early: l10n.pilotFeedbackTimingEarly,
                _TimingChoice.right: l10n.pilotFeedbackTimingRight,
                _TimingChoice.late: l10n.pilotFeedbackTimingLate,
                _TimingChoice.notUsing: l10n.pilotFeedbackTimingNotUsing,
              },
              onChanged: (value) => setState(() => _timing = value),
            ),
            const SizedBox(height: AppSpacing.lg),
            PrimaryButton(
              label: l10n.pilotFeedbackSubmitAction,
              icon: Icons.send_rounded,
              isLoading: _submitting,
              onPressed: _submitting ? null : _submit,
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _submit() async {
    setState(() => _submitting = true);
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ref
          .read(pilotLoopAnalyticsServiceProvider)
          .record(
            PilotLoopAnalyticsEvent.pilotFeedbackSubmitted(
              feedbackSurface: switch (_surface) {
                _PilotSurface.widget => 'widget',
                _PilotSurface.voice => 'voice',
                _PilotSurface.notification => 'notification',
                _PilotSurface.calendar => 'calendar',
                _PilotSurface.import => 'import',
              },
              usefulness: switch (_usefulness) {
                _UsefulnessChoice.high => 'high',
                _UsefulnessChoice.some => 'some',
                _UsefulnessChoice.notYet => 'not_yet',
              },
              annoyance: switch (_annoyance) {
                _AnnoyanceChoice.calm => 'calm',
                _AnnoyanceChoice.fine => 'fine',
                _AnnoyanceChoice.tooMuch => 'too_much',
              },
              timing: switch (_timing) {
                _TimingChoice.early => 'early',
                _TimingChoice.right => 'right',
                _TimingChoice.late => 'late',
                _TimingChoice.notUsing => 'not_using',
              },
              flags: ref.read(pilotPresenceFeatureFlagsProvider),
            ),
          );
      if (!mounted) return;
      messenger.showSnackBar(
        SnackBar(content: Text(context.l10n.pilotFeedbackSavedMessage)),
      );
    } catch (_) {
      // Without this the throw escaped and the button simply reset: the user
      // was told neither that it worked nor that it did not, and would have
      // had no reason to try again.
      if (!mounted) return;
      messenger.showSnackBar(
        SnackBar(content: Text(context.l10n.pilotFeedbackFailedMessage)),
      );
    } finally {
      if (mounted) {
        setState(() => _submitting = false);
      }
    }
  }
}

class _FeedbackSection<T> extends StatelessWidget {
  final String title;
  final T value;
  final Map<T, String> options;
  final ValueChanged<T> onChanged;

  const _FeedbackSection({
    required this.title,
    required this.value,
    required this.options,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;

    return Container(
      margin: const EdgeInsets.only(bottom: AppSpacing.md),
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: colors.surface,
        borderRadius: AppRadius.card,
        border: Border.all(color: colors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: context.text.cardTitle),
          const SizedBox(height: AppSpacing.md),
          MaybesitterSegmentedControl<T>(
            selectedValue: value,
            options: options,
            onSelected: onChanged,
          ),
        ],
      ),
    );
  }
}
