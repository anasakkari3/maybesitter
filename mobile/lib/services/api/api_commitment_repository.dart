import 'dart:async';
import '../../models/commitment.dart';
import '../contracts/commitment_repository.dart';
import 'api_client.dart';
import 'dtos/commitment_dtos.dart';
import 'mappers/commitment_mapper.dart';

class ApiCommitmentRepository implements CommitmentRepository {
  final ApiClient apiClient;
  final StreamController<List<Commitment>> _streamController =
      StreamController<List<Commitment>>.broadcast();

  ApiCommitmentRepository({required this.apiClient});

  @override
  Future<List<Commitment>> getToday() async {
    final json = await apiClient.get('/api/mobile/commitments/today');
    final dto = CommitmentListResponseDto.fromJson(json);
    final domainList = dto.items.map(CommitmentMapper.mapToDomain).toList();
    _streamController.add(domainList);
    return domainList;
  }

  @override
  Future<List<Commitment>> getUpcoming() async {
    final json = await apiClient.get('/api/mobile/commitments/upcoming');
    final dto = CommitmentListResponseDto.fromJson(json);
    return dto.items.map(CommitmentMapper.mapToDomain).toList();
  }

  @override
  Future<Commitment?> getById(String id) async {
    try {
      final json = await apiClient.get('/api/mobile/commitments/$id');
      final dto = BackendCommitmentDto.fromJson(json);
      return CommitmentMapper.mapToDomain(dto);
    } on NotFoundException {
      return null;
    }
  }

  @override
  Future<void> saveAll(List<Commitment> commitments) async {
    // The canonical backend contract relies on proposal/item confirmation trust model
    // rather than client-driven saveAll.
    throw UnsupportedError(
      'ApiCommitmentRepository does not support saveAll. '
      'Use ApiCaptureService.confirmProposal for real backend persistence.',
    );
  }

  @override
  Future<void> update(Commitment commitment) async {
    // Data-Integrity Guard: Commitment PATCH endpoint is disabled in real API mode
    // to protect users from timezone offset shifts and UTC overwrites.
    throw UnsupportedError(
      'Commitment PATCH is disabled in real backend mode to protect scheduled time integrity.',
    );
  }

  @override
  Future<void> complete(String id) async {
    final req = const CommitmentActionRequestDto(action: 'complete');
    await apiClient.post('/api/mobile/commitments/$id/actions', req.toJson());
    await getToday();
  }

  @override
  Future<void> postpone(String id, DateTime newDateTime) async {
    final req = CommitmentActionRequestDto(
      action: 'postpone',
      postponedUntil: newDateTime.toIso8601String(),
    );
    await apiClient.post('/api/mobile/commitments/$id/actions', req.toJson());
    await getToday();
  }

  @override
  Future<void> cancel(String id) async {
    final req = const CommitmentActionRequestDto(action: 'cancel');
    await apiClient.post('/api/mobile/commitments/$id/actions', req.toJson());
    await getToday();
  }

  @override
  Future<void> delete(String id) async {
    final responseJson = await apiClient.delete('/api/mobile/commitments/$id');
    final softDeleteDto = SoftDeleteResponseDto.fromJson(responseJson);
    if (!softDeleteDto.success) {
      throw ServerException('Failed to soft-delete commitment $id');
    }
    await getToday();
  }

  @override
  Stream<List<Commitment>> watchCommitments() {
    // Immediately trigger a fetch when listened to
    getToday().catchError((_) => <Commitment>[]);
    return _streamController.stream;
  }
}
