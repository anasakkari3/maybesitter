import 'dart:async';
import '../../models/commitment.dart';
import '../contracts/commitment_repository.dart';

class InMemoryCommitmentRepository implements CommitmentRepository {
  final List<Commitment> _commitments = [];
  final _controller = StreamController<List<Commitment>>.broadcast();

  InMemoryCommitmentRepository() {
    _seedInitialData();
  }

  void _seedInitialData() {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final tomorrow = today.add(const Duration(days: 1));
    final inTwoDays = today.add(const Duration(days: 2));

    _commitments.addAll([
      Commitment(
        id: 'c-today-1',
        title: 'Pet-Sitter Briefing',
        description: 'Review feeding schedule with Marcus.',
        scheduledDate: today,
        startTime: '10:30 AM',
        endTime: '11:15 AM',
        location: 'Home',
        priority: CommitmentPriority.must,
        status: CommitmentStatus.pending,
        category: 'Pet Care',
      ),
      Commitment(
        id: 'c-today-2',
        title: 'Weekly Meal Prep',
        description: 'Pick up fresh produce and cook dinner portions.',
        scheduledDate: today,
        startTime: '2:15 PM',
        endTime: '3:30 PM',
        priority: CommitmentPriority.should,
        status: CommitmentStatus.pending,
        category: 'Home',
      ),
      Commitment(
        id: 'c-today-3',
        title: 'Evening Park Walk',
        description: 'Take the kids to Central Park playground.',
        scheduledDate: today,
        startTime: '5:00 PM',
        priority: CommitmentPriority.nice,
        status: CommitmentStatus.pending,
        category: 'Family',
      ),
      Commitment(
        id: 'c-today-4',
        title: 'Check water filter',
        description: 'Replaced main kitchen water filter cartridge.',
        scheduledDate: today,
        startTime: '8:12 AM',
        priority: CommitmentPriority.nice,
        status: CommitmentStatus.completed,
        completedAt: today.add(const Duration(hours: 8, minutes: 12)),
        category: 'Maintenance',
      ),
      Commitment(
        id: 'c-up-1',
        title: 'Pediatric Checkup (Leo)',
        description: 'City Medical Center • Dr. Aris',
        scheduledDate: tomorrow,
        startTime: '09:00 AM',
        endTime: '11:30 AM',
        location: 'City Medical Center',
        priority: CommitmentPriority.must,
        status: CommitmentStatus.pending,
        category: 'Health',
      ),
      Commitment(
        id: 'c-up-2',
        title: 'Piano Lesson (Maya)',
        description: 'Home • Instructor Sarah',
        scheduledDate: tomorrow,
        startTime: '02:00 PM',
        endTime: '03:00 PM',
        location: 'Home',
        priority: CommitmentPriority.should,
        status: CommitmentStatus.pending,
        category: 'Education',
      ),
      Commitment(
        id: 'c-up-3',
        title: 'Date Night (No sitter yet)',
        description: 'Reserve restaurant for 7 PM.',
        scheduledDate: inTwoDays,
        startTime: '07:00 PM',
        priority: CommitmentPriority.nice,
        status: CommitmentStatus.pending,
        category: 'Personal',
      ),
    ]);

    _notify();
  }

  void _notify() {
    _controller.add(List.unmodifiable(_commitments));
  }

  @override
  Future<List<Commitment>> getToday() async {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    return _commitments.where((c) {
      if (c.scheduledDate == null) return false;
      final cDate = DateTime(
        c.scheduledDate!.year,
        c.scheduledDate!.month,
        c.scheduledDate!.day,
      );
      return cDate.isAtSameMomentAs(today);
    }).toList();
  }

  @override
  Future<List<Commitment>> getUpcoming() async {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    return _commitments.where((c) {
      if (c.scheduledDate == null) return false;
      final cDate = DateTime(
        c.scheduledDate!.year,
        c.scheduledDate!.month,
        c.scheduledDate!.day,
      );
      return cDate.isAfter(today);
    }).toList();
  }

  @override
  Future<Commitment?> getById(String id) async {
    try {
      return _commitments.firstWhere((c) => c.id == id);
    } catch (_) {
      return null;
    }
  }

  @override
  Future<void> saveAll(List<Commitment> commitments) async {
    for (final c in commitments) {
      final idx = _commitments.indexWhere((existing) => existing.id == c.id);
      if (idx >= 0) {
        _commitments[idx] = c;
      } else {
        _commitments.add(c);
      }
    }
    _notify();
  }

  @override
  Future<void> update(Commitment commitment) async {
    final idx = _commitments.indexWhere((c) => c.id == commitment.id);
    if (idx >= 0) {
      _commitments[idx] = commitment;
      _notify();
    }
  }

  @override
  Future<void> complete(String id) async {
    final idx = _commitments.indexWhere((c) => c.id == id);
    if (idx >= 0) {
      _commitments[idx] = _commitments[idx].copyWith(
        status: CommitmentStatus.completed,
        completedAt: DateTime.now(),
      );
      _notify();
    }
  }

  @override
  Future<void> postpone(String id, DateTime newDateTime) async {
    final idx = _commitments.indexWhere((c) => c.id == id);
    if (idx >= 0) {
      _commitments[idx] = _commitments[idx].copyWith(
        scheduledDate: newDateTime,
        status: CommitmentStatus.postponed,
      );
      _notify();
    }
  }

  @override
  Future<void> cancel(String id) async {
    final idx = _commitments.indexWhere((c) => c.id == id);
    if (idx >= 0) {
      _commitments[idx] = _commitments[idx].copyWith(
        status: CommitmentStatus.cancelled,
      );
      _notify();
    }
  }

  @override
  Future<void> delete(String id) async {
    _commitments.removeWhere((c) => c.id == id);
    _notify();
  }

  @override
  Stream<List<Commitment>> watchCommitments() {
    return _controller.stream;
  }
}
