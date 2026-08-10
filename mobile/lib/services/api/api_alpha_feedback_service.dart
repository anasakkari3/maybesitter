import 'api_client.dart';

/// Alpha feedback flag service.
///
/// Sends an explicit dogfood flag for a recommendation. Server derives the
/// participant id from the bearer token; the client never sends participant
/// ids. Endpoint is disabled (403 feature_disabled) unless
/// MAYBESITTER_ALPHA_FEEDBACK_ENABLED=true.
class ApiAlphaFeedbackService {
  static const flagPath = '/api/mobile/alpha/feedback';

  final ApiClient apiClient;

  const ApiAlphaFeedbackService({required this.apiClient});

  /// Categories mirror the backend contract
  /// (src/contracts/v1/feedbackFlagContracts.ts).
  static const categories = <String>[
    'recommendation_wrong',
    'misunderstood_me',
    'not_useful',
    'invasive',
    'technical_problem',
  ];

  Future<bool> flag({
    required String proposalId,
    required String category,
    String? note,
  }) async {
    try {
      final json = await apiClient.post(
        flagPath,
        {
          'proposalId': proposalId,
          'category': category,
          if (note != null && note.trim().isNotEmpty) 'note': note.trim(),
        },
      );
      return (json['flagId'] ?? '') is String && (json['flagId'] as String).isNotEmpty;
    } on ForbiddenException {
      // Feature disabled or out of pilot — silently treat as not recorded.
      return false;
    }
  }
}
