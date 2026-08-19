import '../contracts/notification_service.dart';

class MockNotificationService implements NotificationService {
  NotificationPermissionState _state;
  final NotificationPermissionState? requestedPermissionState;
  // Keyed by notification id, the way a real platform keys pending requests.
  // A commitment owns several -- a soft stage and an escalation -- so keying
  // by commitment would silently collapse a sequence into its last stage.
  final Map<String, ScheduledNotificationRequest> _requestsByNotificationId = {};
  final List<String> cancelledCommitmentIds = [];
  int requestPermissionCallCount = 0;

  MockNotificationService({
    NotificationPermissionState initialPermissionState =
        NotificationPermissionState.granted,
    this.requestedPermissionState,
  }) : _state = initialPermissionState;

  List<ScheduledNotificationRequest> get scheduledRequests =>
      _requestsByNotificationId.values.toList(growable: false);

  List<ScheduledNotificationRequest> requestsFor(String commitmentId) =>
      _requestsByNotificationId.values
          .where((request) => request.commitmentId == commitmentId)
          .toList(growable: false);

  ScheduledNotificationRequest? requestFor(String commitmentId) =>
      requestsFor(commitmentId).firstOrNull;

  @override
  Future<NotificationPermissionState> permissionState() async {
    return _state;
  }

  @override
  Future<NotificationPermissionState> requestPermission() async {
    requestPermissionCallCount += 1;
    _state = requestedPermissionState ?? NotificationPermissionState.granted;
    return _state;
  }

  @override
  Future<void> schedule(ScheduledNotificationRequest request) async {
    _requestsByNotificationId[request.notificationId] = request;
  }

  @override
  Future<void> cancelFor(String commitmentId) async {
    cancelledCommitmentIds.add(commitmentId);
    _requestsByNotificationId.removeWhere(
      (_, request) => request.commitmentId == commitmentId,
    );
  }
}
