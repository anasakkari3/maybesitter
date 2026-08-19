import '../contracts/notification_service.dart';

class MockNotificationService implements NotificationService {
  NotificationPermissionState _state;
  final NotificationPermissionState? requestedPermissionState;
  final Map<String, ScheduledNotificationRequest> _requestsByCommitmentId = {};
  final List<String> cancelledCommitmentIds = [];
  int requestPermissionCallCount = 0;

  MockNotificationService({
    NotificationPermissionState initialPermissionState =
        NotificationPermissionState.granted,
    this.requestedPermissionState,
  }) : _state = initialPermissionState;

  List<ScheduledNotificationRequest> get scheduledRequests =>
      _requestsByCommitmentId.values.toList(growable: false);

  ScheduledNotificationRequest? requestFor(String commitmentId) =>
      _requestsByCommitmentId[commitmentId];

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
    _requestsByCommitmentId[request.commitmentId] = request;
  }

  @override
  Future<void> cancelFor(String commitmentId) async {
    cancelledCommitmentIds.add(commitmentId);
    _requestsByCommitmentId.remove(commitmentId);
  }
}
