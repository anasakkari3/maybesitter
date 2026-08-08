import '../../models/commitment.dart';

enum NotificationPermissionState { granted, denied, notDetermined }

abstract interface class NotificationService {
  Future<NotificationPermissionState> permissionState();
  Future<NotificationPermissionState> requestPermission();
  Future<void> scheduleFor(Commitment commitment);
  Future<void> cancelFor(String commitmentId);
}
