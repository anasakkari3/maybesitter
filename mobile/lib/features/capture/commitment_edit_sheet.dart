import 'package:flutter/material.dart';

import '../../design_system/tokens/spacing.dart';
import '../../l10n/generated/app_localizations.dart';
import '../../models/commitment.dart';

/// Apply an edit to a commitment.
///
/// Kept apart from the sheet so the rules can be tested without pumping a
/// widget: which fields survive an untouched edit, that a blank title is
/// refused rather than saved, and that clearing a date leaves the time alone.
Commitment applyCommitmentEdit(
  Commitment original, {
  String? title,
  DateTime? scheduledDate,
  String? startTime,
  CommitmentPriority? priority,
  bool clearDate = false,
  bool clearTime = false,
}) {
  final trimmed = title?.trim();
  return original.copyWith(
    // A blank title would leave a row with nothing to read. Keep the old one.
    title: (trimmed == null || trimmed.isEmpty) ? original.title : trimmed,
    scheduledDate: clearDate ? null : (scheduledDate ?? original.scheduledDate),
    clearScheduledDate: clearDate,
    startTime: clearTime ? null : (startTime ?? original.startTime),
    clearStartTime: clearTime,
    priority: priority ?? original.priority,
    // The person has just read this and said what it should be.
    needsClarification: false,
  );
}

/// Correct anything the reader got wrong, before it is saved.
///
/// Extraction guesses at the hour, the day and how much something matters.
/// Without a way to correct all three, a misread is permanent: the review
/// screen used to offer a title field alone, and no date or time picker existed
/// anywhere in the app.
class CommitmentEditSheet extends StatefulWidget {
  final Commitment commitment;

  const CommitmentEditSheet({super.key, required this.commitment});

  static Future<Commitment?> show(
    BuildContext context,
    Commitment commitment,
  ) {
    return showModalBottomSheet<Commitment>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (_) => CommitmentEditSheet(commitment: commitment),
    );
  }

  @override
  State<CommitmentEditSheet> createState() => _CommitmentEditSheetState();
}

class _CommitmentEditSheetState extends State<CommitmentEditSheet> {
  late final TextEditingController _title = TextEditingController(
    text: widget.commitment.title,
  );
  late DateTime? _date = widget.commitment.scheduledDate;
  late TimeOfDay? _time = _parseTime(widget.commitment.startTime);
  late CommitmentPriority _priority = widget.commitment.priority;

  @override
  void dispose() {
    _title.dispose();
    super.dispose();
  }

  static TimeOfDay? _parseTime(String? raw) {
    if (raw == null || raw.trim().isEmpty) return null;
    final normalized = raw.trim().toUpperCase();
    final meridiem = RegExp(r'^(\d{1,2}):(\d{2})\s*([AP]M)$').firstMatch(normalized);
    if (meridiem != null) {
      var hour = int.parse(meridiem.group(1)!);
      final minute = int.parse(meridiem.group(2)!);
      if (meridiem.group(3) == 'PM' && hour != 12) hour += 12;
      if (meridiem.group(3) == 'AM' && hour == 12) hour = 0;
      return TimeOfDay(hour: hour, minute: minute);
    }
    final plain = RegExp(r'^(\d{1,2}):(\d{2})$').firstMatch(normalized);
    if (plain == null) return null;
    return TimeOfDay(
      hour: int.parse(plain.group(1)!),
      minute: int.parse(plain.group(2)!),
    );
  }

  String _formatTime(TimeOfDay time) =>
      '${time.hour.toString().padLeft(2, '0')}:'
      '${time.minute.toString().padLeft(2, '0')}';

  String _formatDate(DateTime date) =>
      '${date.year}-${date.month.toString().padLeft(2, '0')}-'
      '${date.day.toString().padLeft(2, '0')}';

  Future<void> _pickDate() async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: _date ?? now,
      firstDate: DateTime(now.year - 1),
      lastDate: DateTime(now.year + 5),
    );
    if (picked != null) setState(() => _date = picked);
  }

  Future<void> _pickTime() async {
    final picked = await showTimePicker(
      context: context,
      initialTime: _time ?? const TimeOfDay(hour: 9, minute: 0),
    );
    if (picked != null) setState(() => _time = picked);
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);

    return Padding(
      padding: EdgeInsets.only(
        left: AppSpacing.lg,
        right: AppSpacing.lg,
        top: AppSpacing.lg,
        bottom: MediaQuery.of(context).viewInsets.bottom + AppSpacing.lg,
      ),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(l10n.editCommitmentTitle, style: theme.textTheme.titleLarge),
            const SizedBox(height: AppSpacing.lg),

            TextField(
              controller: _title,
              decoration: InputDecoration(
                labelText: l10n.commitmentDetailTitle,
                border: const OutlineInputBorder(),
              ),
              textInputAction: TextInputAction.done,
            ),
            const SizedBox(height: AppSpacing.lg),

            Row(
              children: [
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: _pickDate,
                    icon: const Icon(Icons.calendar_today_rounded, size: 18),
                    label: Text(
                      _date == null
                          ? l10n.editCommitmentNoDate
                          : _formatDate(_date!),
                    ),
                  ),
                ),
                const SizedBox(width: AppSpacing.sm),
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: _pickTime,
                    icon: const Icon(Icons.schedule_rounded, size: 18),
                    label: Text(
                      _time == null
                          ? l10n.editCommitmentNoTime
                          : _formatTime(_time!),
                    ),
                  ),
                ),
              ],
            ),

            // Removing a date the person never gave has to be possible, or an
            // invented deadline can only ever be moved, never withdrawn.
            if (_date != null || _time != null)
              Align(
                alignment: AlignmentDirectional.centerStart,
                child: TextButton(
                  onPressed: () => setState(() {
                    _date = null;
                    _time = null;
                  }),
                  child: Text(l10n.editCommitmentClearWhen),
                ),
              ),
            const SizedBox(height: AppSpacing.md),

            Align(
              alignment: AlignmentDirectional.centerStart,
              child: Text(
                l10n.editCommitmentPriority,
                style: theme.textTheme.labelLarge,
              ),
            ),
            const SizedBox(height: AppSpacing.sm),
            SegmentedButton<CommitmentPriority>(
              segments: [
                ButtonSegment(
                  value: CommitmentPriority.must,
                  label: Text(l10n.priorityMust),
                ),
                ButtonSegment(
                  value: CommitmentPriority.should,
                  label: Text(l10n.priorityShould),
                ),
                ButtonSegment(
                  value: CommitmentPriority.nice,
                  label: Text(l10n.priorityNice),
                ),
              ],
              selected: {_priority},
              onSelectionChanged: (selected) =>
                  setState(() => _priority = selected.first),
            ),
            const SizedBox(height: AppSpacing.xl),

            Row(
              children: [
                Expanded(
                  child: TextButton(
                    onPressed: () => Navigator.pop(context),
                    child: Text(l10n.cancelAction),
                  ),
                ),
                const SizedBox(width: AppSpacing.sm),
                Expanded(
                  child: FilledButton(
                    onPressed: () => Navigator.pop(
                      context,
                      applyCommitmentEdit(
                        widget.commitment,
                        title: _title.text,
                        scheduledDate: _date,
                        startTime: _time == null ? null : _formatTime(_time!),
                        priority: _priority,
                        clearDate: _date == null,
                        clearTime: _time == null,
                      ),
                    ),
                    child: Text(l10n.saveAction),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
