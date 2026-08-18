import '../../models/feedback_history.dart';
import '../contracts/feedback_history_service.dart';
import 'api_client.dart';

/// Talks to `/api/mobile/feedback`. The scope is derived from the bearer token
/// server-side; the client never names whose history it wants.
class ApiFeedbackHistoryService implements FeedbackHistoryService {
  static const historyPath = '/api/mobile/feedback/history';

  final ApiClient apiClient;

  const ApiFeedbackHistoryService({required this.apiClient});

  static String revokePath(String eventId) =>
      '/api/mobile/feedback/${Uri.encodeComponent(eventId)}/revoke';

  @override
  Future<FeedbackHistory> getHistory() async {
    try {
      return FeedbackHistory.fromJson(await apiClient.get(historyPath));
    } on ServerException catch (error) {
      // 503 is the server saying the record is not connected. Anything else is
      // a real failure and stays a failure.
      if (error.statusCode == 503) throw const FeedbackHistoryUnavailableException();
      rethrow;
    }
  }

  @override
  Future<FeedbackHistoryRow> revoke(String eventId) async {
    try {
      final json = await apiClient.post(revokePath(eventId), const {});
      final row = json['row'];
      if (row is! Map) {
        // A success shape we cannot read is not a success we can report.
        throw const ServerException('revoke response did not contain a row');
      }
      return FeedbackHistoryRow.fromJson(row.cast<String, dynamic>());
    } on ServerException catch (error) {
      if (error.statusCode == 503) throw const FeedbackHistoryUnavailableException();
      rethrow;
    }
  }
}
