import '../../models/feedback_history.dart';

/// Reads the behaviour record and corrects it.
///
/// Two failures are kept apart on purpose. [FeedbackHistoryUnavailableException]
/// means the record is not connected in this build; an empty [FeedbackHistory]
/// means it is connected and holds nothing. Collapsing them would let a screen
/// tell the user "we learned nothing about you" when the truth is "we cannot
/// see what we learned about you", which is the more alarming of the two.
abstract class FeedbackHistoryService {
  Future<FeedbackHistory> getHistory();

  /// Tells the server to stop learning from one observed moment.
  ///
  /// Returns the row as it now stands, so the caller renders what the record
  /// actually says rather than what it assumed the call would do.
  Future<FeedbackHistoryRow> revoke(String eventId);
}

/// The behaviour record is not wired up in this build.
class FeedbackHistoryUnavailableException implements Exception {
  const FeedbackHistoryUnavailableException();

  @override
  String toString() => 'FeedbackHistoryUnavailableException';
}
