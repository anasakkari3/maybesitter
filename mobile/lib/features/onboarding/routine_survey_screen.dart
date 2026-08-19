import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/utilities/l10n_extensions.dart';
import '../../design_system/components/maybesitter_app_bar.dart';
import '../../design_system/components/maybesitter_buttons.dart';
import '../../design_system/theme/app_theme.dart';
import '../../design_system/tokens/radius.dart';
import '../../design_system/tokens/spacing.dart';
import '../../models/pilot_presence.dart';
import '../../services/providers.dart';

enum RoutineSurveyMode { onboarding, settings }

class RoutineSurveyScreen extends ConsumerStatefulWidget {
  final RoutineSurveyMode mode;

  const RoutineSurveyScreen({super.key, required this.mode});

  @override
  ConsumerState<RoutineSurveyScreen> createState() =>
      _RoutineSurveyScreenState();
}

class _RoutineSurveyScreenState extends ConsumerState<RoutineSurveyScreen> {
  _SleepChoice _sleep = _SleepChoice.standard;
  _FocusChoice _focus = _FocusChoice.workday;
  _FixedCommitmentChoice _fixed = _FixedCommitmentChoice.none;
  _ReminderChoice _reminder = _ReminderChoice.soft;
  _QuietHoursChoice _quietHours = _QuietHoursChoice.standard;
  bool _seededFromProfile = false;
  bool _isSaving = false;

  @override
  Widget build(BuildContext context) {
    final profile = ref.watch(routineProfileProvider);
    if (!_seededFromProfile && profile != null && !profile.surveySkipped) {
      _seedFromProfile(profile);
      _seededFromProfile = true;
    }

    final l10n = context.l10n;
    final colors = context.colors;
    final isOnboarding = widget.mode == RoutineSurveyMode.onboarding;
    final body = SafeArea(
      child: ListView(
        padding: const EdgeInsets.all(AppSpacing.lg),
        children: [
          if (isOnboarding) ...[
            const SizedBox(height: AppSpacing.xl),
            Icon(Icons.schedule, size: 48, color: colors.brandPrimary),
            const SizedBox(height: AppSpacing.lg),
          ],
          Text(
            l10n.routineSurveyTitle,
            textAlign: isOnboarding ? TextAlign.center : TextAlign.start,
            style: context.text.display,
          ),
          const SizedBox(height: AppSpacing.sm),
          Text(
            l10n.routineSurveySubtitle,
            textAlign: isOnboarding ? TextAlign.center : TextAlign.start,
            style: context.text.body.copyWith(
              color: colors.textSecondary,
              height: 1.4,
            ),
          ),
          const SizedBox(height: AppSpacing.xl),
          _ChoiceSection<_SleepChoice>(
            title: l10n.routineSleepQuestion,
            selected: _sleep,
            options: {
              _SleepChoice.early: l10n.routineSleepEarly,
              _SleepChoice.standard: l10n.routineSleepStandard,
              _SleepChoice.late: l10n.routineSleepLate,
            },
            onSelected: (value) => setState(() => _sleep = value),
          ),
          _ChoiceSection<_FocusChoice>(
            title: l10n.routineFocusQuestion,
            selected: _focus,
            options: {
              _FocusChoice.workday: l10n.routineFocusWorkday,
              _FocusChoice.early: l10n.routineFocusEarly,
              _FocusChoice.afternoon: l10n.routineFocusAfternoon,
              _FocusChoice.none: l10n.routineNoneRegular,
            },
            onSelected: (value) => setState(() => _focus = value),
          ),
          _ChoiceSection<_FixedCommitmentChoice>(
            title: l10n.routineFixedQuestion,
            selected: _fixed,
            options: {
              _FixedCommitmentChoice.none: l10n.routineNoneRegular,
              _FixedCommitmentChoice.morning: l10n.routineFixedMorning,
              _FixedCommitmentChoice.afternoon: l10n.routineFixedAfternoon,
              _FixedCommitmentChoice.evening: l10n.routineFixedEvening,
            },
            onSelected: (value) => setState(() => _fixed = value),
          ),
          _ChoiceSection<_ReminderChoice>(
            title: l10n.routineReminderQuestion,
            selected: _reminder,
            options: {
              _ReminderChoice.soft: l10n.routineReminderSoft,
              _ReminderChoice.followUp: l10n.routineReminderFollowUp,
              _ReminderChoice.strong: l10n.routineReminderStrong,
            },
            onSelected: (value) => setState(() => _reminder = value),
          ),
          _ChoiceSection<_QuietHoursChoice>(
            title: l10n.routineQuietQuestion,
            selected: _quietHours,
            options: {
              _QuietHoursChoice.early: l10n.routineQuietEarly,
              _QuietHoursChoice.standard: l10n.routineQuietStandard,
              _QuietHoursChoice.late: l10n.routineQuietLate,
              _QuietHoursChoice.none: l10n.routineNoneRegular,
            },
            onSelected: (value) => setState(() => _quietHours = value),
          ),
          _ReminderPolicySummary(
            reminderChoice: _reminder,
            quietHoursChoice: _quietHours,
          ),
          const SizedBox(height: AppSpacing.lg),
          PrimaryButton(
            key: const Key('routine-save'),
            label: isOnboarding
                ? l10n.routineCompleteAction
                : l10n.routineSaveAction,
            icon: Icons.check,
            isLoading: _isSaving,
            onPressed: _isSaving ? null : _save,
          ),
          if (isOnboarding) ...[
            const SizedBox(height: AppSpacing.sm),
            TertiaryButton(
              key: const Key('routine-skip'),
              label: l10n.skipAction,
              onPressed: _isSaving ? null : _skip,
            ),
          ],
          const SizedBox(height: AppSpacing.lg),
        ],
      ),
    );

    return Scaffold(
      backgroundColor: colors.background,
      appBar: isOnboarding
          ? null
          : MaybesitterAppBar(
              title: l10n.routineSettingsTitle,
              leading: IconButton(
                icon: const Icon(Icons.arrow_back),
                tooltip: l10n.backAction,
                onPressed: () => Navigator.pop(context),
              ),
            ),
      body: body,
    );
  }

  void _seedFromProfile(UserRoutineProfile profile) {
    _sleep = _SleepChoice.fromWindow(profile.sleepWindow);
    _focus = _FocusChoice.fromWindows(profile.focusWindows);
    _fixed = _FixedCommitmentChoice.fromWindows(profile.fixedCommitmentWindows);
    _reminder = _ReminderChoice.fromIntensity(
      profile.preferredReminderIntensity,
    );
    _quietHours = _QuietHoursChoice.fromWindow(profile.quietHours);
  }

  Future<void> _save() async {
    setState(() => _isSaving = true);
    final router = GoRouter.maybeOf(context);
    final profile = UserRoutineProfile(
      updatedAt: DateTime.now().toUtc(),
      timezone: ref.read(appConfigProvider).timezone,
      sleepWindow: _sleep.window,
      focusWindows: _focus.window == null ? const [] : [_focus.window!],
      fixedCommitmentWindows: _fixed.window == null
          ? const []
          : [_fixed.window!],
      preferredReminderIntensity: _reminder.intensity,
      quietHours: _quietHours.window,
    );
    await ref.read(routineProfileProvider.notifier).saveProfile(profile);
    if (!mounted) return;
    if (widget.mode == RoutineSurveyMode.onboarding) {
      await ref.read(appSettingsProvider.notifier).completeOnboarding();
      if (!mounted) return;
      router?.go('/today');
    } else {
      Navigator.pop(context);
    }
  }

  Future<void> _skip() async {
    setState(() => _isSaving = true);
    final router = GoRouter.maybeOf(context);
    await ref.read(routineProfileProvider.notifier).skipSurvey();
    if (!mounted) return;
    await ref.read(appSettingsProvider.notifier).completeOnboarding();
    if (!mounted) return;
    router?.go('/today');
  }
}

class _ReminderPolicySummary extends StatelessWidget {
  final _ReminderChoice reminderChoice;
  final _QuietHoursChoice quietHoursChoice;

  const _ReminderPolicySummary({
    required this.reminderChoice,
    required this.quietHoursChoice,
  });

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final colors = context.colors;
    final shouldLine = switch (reminderChoice) {
      _ReminderChoice.soft => l10n.routineEscalationShouldSoft,
      _ReminderChoice.followUp || _ReminderChoice.strong =>
        l10n.routineEscalationShouldFollowUp,
    };
    final mustLine = switch (reminderChoice) {
      _ReminderChoice.soft => l10n.routineEscalationMustSoft,
      _ReminderChoice.followUp => l10n.routineEscalationMustFollowUp,
      _ReminderChoice.strong => l10n.routineEscalationMustStrong,
    };

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
          Text(l10n.routineEscalationTitle, style: context.text.cardTitle),
          const SizedBox(height: AppSpacing.sm),
          _PolicyLine(text: l10n.routineEscalationNice),
          _PolicyLine(text: shouldLine),
          _PolicyLine(text: mustLine),
          if (quietHoursChoice != _QuietHoursChoice.none)
            _PolicyLine(text: l10n.routineEscalationQuietHours),
          _PolicyLine(text: l10n.routineEscalationNoFakeCalls),
        ],
      ),
    );
  }
}

class _PolicyLine extends StatelessWidget {
  final String text;

  const _PolicyLine({required this.text});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.xs),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Icon(
              Icons.circle,
              size: 8,
              color: context.colors.brandPrimary,
            ),
          ),
          const SizedBox(width: AppSpacing.sm),
          Expanded(
            child: Text(
              text,
              style: context.text.supporting,
            ),
          ),
        ],
      ),
    );
  }
}

class _ChoiceSection<T> extends StatelessWidget {
  final String title;
  final T selected;
  final Map<T, String> options;
  final ValueChanged<T> onSelected;

  const _ChoiceSection({
    required this.title,
    required this.selected,
    required this.options,
    required this.onSelected,
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
          Wrap(
            spacing: AppSpacing.sm,
            runSpacing: AppSpacing.sm,
            children: options.entries
                .map((entry) {
                  return ChoiceChip(
                    key: Key('routine-option-${entry.key}'),
                    label: Text(entry.value, maxLines: 2),
                    selected: entry.key == selected,
                    onSelected: (_) => onSelected(entry.key),
                  );
                })
                .toList(growable: false),
          ),
        ],
      ),
    );
  }
}

enum _SleepChoice {
  early(RoutineTimeWindow(start: '22:30', end: '06:30')),
  standard(RoutineTimeWindow(start: '23:30', end: '07:30')),
  late(RoutineTimeWindow(start: '00:30', end: '08:30'));

  final RoutineTimeWindow window;

  const _SleepChoice(this.window);

  static _SleepChoice fromWindow(RoutineTimeWindow? window) {
    return _firstMatchingWindow(values, window) ?? _SleepChoice.standard;
  }
}

enum _FocusChoice {
  workday(RoutineTimeWindow(start: '09:00', end: '17:00', label: 'work_study')),
  early(RoutineTimeWindow(start: '08:00', end: '16:00', label: 'work_study')),
  afternoon(
    RoutineTimeWindow(start: '12:00', end: '18:00', label: 'work_study'),
  ),
  none(null);

  final RoutineTimeWindow? window;

  const _FocusChoice(this.window);

  static _FocusChoice fromWindows(List<RoutineTimeWindow> windows) {
    return _firstMatchingWindow(
          values,
          windows.isEmpty ? null : windows.first,
        ) ??
        _FocusChoice.workday;
  }
}

enum _FixedCommitmentChoice {
  none(null),
  morning(
    RoutineTimeWindow(start: '07:00', end: '09:00', label: 'fixed_commitments'),
  ),
  afternoon(
    RoutineTimeWindow(start: '14:00', end: '16:00', label: 'fixed_commitments'),
  ),
  evening(
    RoutineTimeWindow(start: '18:00', end: '20:00', label: 'fixed_commitments'),
  );

  final RoutineTimeWindow? window;

  const _FixedCommitmentChoice(this.window);

  static _FixedCommitmentChoice fromWindows(List<RoutineTimeWindow> windows) {
    return _firstMatchingWindow(
          values,
          windows.isEmpty ? null : windows.first,
        ) ??
        _FixedCommitmentChoice.none;
  }
}

enum _ReminderChoice {
  soft(ReminderIntensity.softAwareness),
  followUp(ReminderIntensity.followUp),
  strong(ReminderIntensity.strongReminder);

  final ReminderIntensity intensity;

  const _ReminderChoice(this.intensity);

  static _ReminderChoice fromIntensity(ReminderIntensity intensity) {
    return values.firstWhere(
      (choice) => choice.intensity == intensity,
      orElse: () => _ReminderChoice.soft,
    );
  }
}

enum _QuietHoursChoice {
  early(RoutineTimeWindow(start: '21:30', end: '06:30')),
  standard(RoutineTimeWindow(start: '22:30', end: '07:30')),
  late(RoutineTimeWindow(start: '23:30', end: '08:30')),
  none(null);

  final RoutineTimeWindow? window;

  const _QuietHoursChoice(this.window);

  static _QuietHoursChoice fromWindow(RoutineTimeWindow? window) {
    return _firstMatchingWindow(values, window) ?? _QuietHoursChoice.standard;
  }
}

T? _firstMatchingWindow<T>(Iterable<T> choices, RoutineTimeWindow? window) {
  if (window == null) return null;
  for (final choice in choices) {
    final choiceWindow = switch (choice) {
      _SleepChoice(:final window) => window,
      _FocusChoice(:final window) => window,
      _FixedCommitmentChoice(:final window) => window,
      _QuietHoursChoice(:final window) => window,
      _ => null,
    };
    if (choiceWindow?.start == window.start &&
        choiceWindow?.end == window.end) {
      return choice;
    }
  }
  return null;
}
