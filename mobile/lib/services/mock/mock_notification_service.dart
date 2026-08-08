import '../../models/commitment.dart';
import '../contracts/notification_service.dart';

class MockNotificationService implements NotificationService {
  NotificationPermissionState _state = NotificationPermissionState.granted;

  @override
  Future<NotificationPermissionState> permissionState() async {
    return _state;
  }

  @override
  Future<NotificationPermissionState> requestPermission() async {
    _state = NotificationPermissionState.granted;
    return _state;
  }

  @override
  Future<void> scheduleFor(Commitment commitment) async {
    // Mock scheduling logic
  }

  @override
  Future<void> cancelFor(String commitmentId) async {
    // Mock cancellation logic
  }
}
