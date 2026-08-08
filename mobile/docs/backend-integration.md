# Backend Integration Boundary & Proposed Contracts

> [!IMPORTANT]
> This mobile application uses local mock implementations (`MockCaptureService`, `InMemoryCommitmentRepository`, `MockActivityRepository`, `MockNotificationService`, `MockConnectivityService`). No backend or AI model code resides inside `mobile/`.

## Proposed Contracts Awaiting Backend Alignment

### 1. `CaptureService`
```dart
abstract interface class CaptureService {
  Future<CaptureResult> capture(CaptureRequest request);
}
```
**Request Payload**:
```json
{
  "rawInput": "Tomorrow I will go to the doctor and then work.",
  "capturedAt": "2026-07-27T10:00:00.000Z",
  "clientLocale": "en_US"
}
```
**Proposed Response Payload**:
```json
{
  "requestId": "cap-123456",
  "status": "needsConfirmation",
  "confidence": "high",
  "analysisNote": "The AI scanned for dates, times, and specific actions in your plan.",
  "extractedCommitments": [
    {
      "id": "c-1",
      "title": "Go to the doctor",
      "scheduledDate": "2026-07-28T09:00:00.000Z",
      "startTime": "09:00 AM",
      "endTime": "11:00 AM",
      "location": "General Clinic",
      "priority": "must"
    },
    {
      "id": "c-2",
      "title": "Work afterward",
      "scheduledDate": "2026-07-28T11:30:00.000Z",
      "startTime": "11:30 AM",
      "endTime": "05:00 PM",
      "priority": "should"
    }
  ]
}
```

### 2. `CommitmentRepository`
```dart
abstract interface class CommitmentRepository {
  Future<List<Commitment>> getToday();
  Future<List<Commitment>> getUpcoming();
  Future<Commitment?> getById(String id);
  Future<void> saveAll(List<Commitment> commitments);
  Future<void> update(Commitment commitment);
  Future<void> complete(String id);
  Future<void> postpone(String id, DateTime newDateTime);
  Future<void> cancel(String id);
  Future<void> delete(String id);
  Stream<List<Commitment>> watchCommitments();
}
```

## Integration Replacement Steps
When connecting to the real backend in Phase 2:
1. Implement `ApiCaptureService` extending `CaptureService` using `http`.
2. Implement `ApiCommitmentRepository` extending `CommitmentRepository`.
3. Override Riverpod providers in `lib/services/providers.dart`:
```dart
final captureServiceProvider = Provider<CaptureService>((ref) => ApiCaptureService());
final commitmentRepositoryProvider = Provider<CommitmentRepository>((ref) => ApiCommitmentRepository());
```
