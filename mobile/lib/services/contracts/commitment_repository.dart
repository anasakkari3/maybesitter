import '../../models/commitment.dart';

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
