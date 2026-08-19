import 'dart:async';
import '../../models/activity_event.dart';
import '../../models/commitment.dart';
import '../contracts/activity_repository.dart';
import '../contracts/commitment_repository.dart';
import 'commitment_state_store.dart';

class InMemoryCommitmentRepository implements CommitmentRepository {
  final List<Commitment> _commitments = [];
  final _controller = StreamController<List<Commitment>>.broadcast();

  /// Where a completion or a postpone is recorded so Activity can show it.
  ///
  /// Optional because the repository is usable without one, but the app always
  /// supplies it: without it the two actions a person takes most often left no
  /// trace at all, and Activity stayed on "No Activity Yet" no matter what
  /// they did.
  final ActivityRepository? activityRepository;

  /// Where changes survive a relaunch. Null keeps the old in-memory-only
  /// behaviour, which is what most tests want.
  final CommitmentStateStore? stateStore;

  /// Completes once seeded data and any restored changes are both in place.
  ///
  /// Restoring is asynchronous and construction is not, so a caller that reads
  /// immediately would otherwise race the restore and see the seed.
  late final Future<void> ready;

  InMemoryCommitmentRepository({this.activityRepository, this.stateStore}) {
    _seedInitialData();
    ready = _restore();
  }

  /// Lay saved changes over the seed.
  Future<void> _restore() async {
    final store = stateStore;
    if (store == null) return;

    // Storage failing is not the app failing. `SharedPreferences` needs a
    // platform binding that a plain unit test does not have, and on a device it
    // can be unavailable or corrupt. Saved changes are a convenience laid over
    // the seed, so losing them costs the user their edits and nothing else —
    // whereas letting this throw takes down construction of the repository the
    // whole app reads from.
    Map<String, CommitmentStateChange> changes;
    try {
      changes = await store.load();
    } catch (_) {
      return;
    }
    if (changes.isEmpty) return;

    var restored = false;
    for (var i = 0; i < _commitments.length; i++) {
      final change = changes[_commitments[i].id];
      if (change == null) continue;
      _commitments[i] = _commitments[i].copyWith(
        status: change.status,
        scheduledDate: change.scheduledDate,
        completedAt: change.completedAt,
      );
      restored = true;
    }
    if (restored) _notify();
  }

  Future<void> _persist() async {
    final store = stateStore;
    if (store == null) return;
    final changes = <String, CommitmentStateChange>{};
    for (final commitment in _commitments) {
      // Only what a person changed. A pending commitment with no completion is
      // the seed as shipped and needs no row.
      if (commitment.status == CommitmentStatus.pending &&
          commitment.completedAt == null) {
        continue;
      }
      changes[commitment.id] = CommitmentStateChange(
        status: commitment.status,
        scheduledDate: commitment.scheduledDate,
        completedAt: commitment.completedAt,
      );
    }
    // Same reasoning as `_restore`: a failed write must not turn a completed
    // commitment into a thrown exception in front of the user.
    try {
      await store.save(changes);
    } catch (_) {
      // Left unsaved deliberately; the in-memory state the user is looking at
      // is already correct for this session.
    }
  }

  Future<void> _log(ActivityEventType type, Commitment commitment, String description) async {
    final activity = activityRepository;
    if (activity == null) return;
    await activity.logEvent(
      ActivityEvent(
        id: 'act-${type.name}-${commitment.id}-${DateTime.now().microsecondsSinceEpoch}',
        type: type,
        title: type.defaultTitle,
        description: description,
        timestamp: DateTime.now(),
      ),
    );
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
      await _persist();
      await _log(
        ActivityEventType.commitmentCompleted,
        _commitments[idx],
        'Completed "${_commitments[idx].title}".',
      );
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
      await _persist();
      await _log(
        ActivityEventType.commitmentPostponed,
        _commitments[idx],
        'Postponed "${_commitments[idx].title}".',
      );
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
