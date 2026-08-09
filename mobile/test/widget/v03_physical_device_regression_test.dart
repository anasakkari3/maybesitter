import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/config/app_config.dart';
import 'package:maybesitter_mobile/features/capture/capture_controller.dart';
import 'package:maybesitter_mobile/features/today/today_screen.dart';
import 'package:maybesitter_mobile/l10n/generated/app_localizations.dart';
import 'package:maybesitter_mobile/models/capture_result.dart';
import 'package:maybesitter_mobile/models/commitment.dart';
import 'package:maybesitter_mobile/services/api/dtos/proposal_dtos.dart';
import 'package:maybesitter_mobile/services/contracts/capture_service.dart';
import 'package:maybesitter_mobile/services/contracts/commitment_repository.dart';
import 'package:maybesitter_mobile/services/providers.dart';

class _RefreshingCommitmentRepository implements CommitmentRepository {
  final _controller = StreamController<List<Commitment>>.broadcast();
  final List<Commitment> _commitments = [];

  void persist(Commitment commitment) {
    _commitments.removeWhere((candidate) => candidate.id == commitment.id);
    _commitments.add(commitment);
  }

  @override
  Future<List<Commitment>> getToday() async {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    return _commitments.where((commitment) {
      final scheduledDate = commitment.scheduledDate;
      if (scheduledDate == null) return false;
      final commitmentDate = DateTime(
        scheduledDate.year,
        scheduledDate.month,
        scheduledDate.day,
      );
      return commitmentDate.isAtSameMomentAs(today);
    }).toList();
  }

  @override
  Future<List<Commitment>> getUpcoming() async {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    return _commitments.where((commitment) {
      final scheduledDate = commitment.scheduledDate;
      if (scheduledDate == null) return false;
      final commitmentDate = DateTime(
        scheduledDate.year,
        scheduledDate.month,
        scheduledDate.day,
      );
      return commitmentDate.isAfter(today);
    }).toList();
  }

  @override
  Future<Commitment?> getById(String id) async {
    for (final commitment in _commitments) {
      if (commitment.id == id) return commitment;
    }
    return null;
  }

  @override
  Future<void> saveAll(List<Commitment> commitments) async {
    for (final commitment in commitments) {
      persist(commitment);
    }
    _controller.add(List.unmodifiable(_commitments));
  }

  @override
  Future<void> update(Commitment commitment) async {
    persist(commitment);
    _controller.add(List.unmodifiable(_commitments));
  }

  @override
  Future<void> complete(String id) async {}

  @override
  Future<void> postpone(String id, DateTime newDateTime) async {}

  @override
  Future<void> cancel(String id) async {}

  @override
  Future<void> delete(String id) async {
    _commitments.removeWhere((commitment) => commitment.id == id);
    _controller.add(List.unmodifiable(_commitments));
  }

  @override
  Stream<List<Commitment>> watchCommitments() {
    return _controller.stream;
  }

  void dispose() {
    _controller.close();
  }
}

class _PersistingCaptureService implements CaptureService {
  final _RefreshingCommitmentRepository repository;

  _PersistingCaptureService(this.repository);

  @override
  Future<CaptureResult> capture(CaptureRequest request) async {
    return CaptureResult(
      requestId: 'req-call-maya',
      proposalId: 'prop-call-maya',
      rawInput: request.rawInput,
      status: CaptureStatus.needsConfirmation,
      extractedCommitments: [
        Commitment(
          id: 'item-call-maya',
          title: 'Call Maya',
          scheduledDate: DateTime.now(),
          startTime: '08:30 PM',
          priority: CommitmentPriority.should,
        ),
      ],
    );
  }

  @override
  Future<ConfirmProposalResponseDto> confirmProposal({
    required String proposalId,
    required String scopeId,
    required List<String> itemIds,
    DateTime? referenceTime,
  }) async {
    final today = DateTime.now();
    repository.persist(
      Commitment(
        id: 'commitment-call-maya',
        title: 'Call Maya',
        scheduledDate: DateTime(today.year, today.month, today.day, 20, 30),
        startTime: '08:30 PM',
        priority: CommitmentPriority.should,
      ),
    );
    return const ConfirmProposalResponseDto(
      success: true,
      persisted: [
        PersistedProposalItemDto(
          itemId: 'item-call-maya',
          commitmentId: 'commitment-call-maya',
          title: 'Call Maya',
        ),
      ],
      failed: [],
    );
  }
}

Widget _app(Widget home) {
  return MaterialApp(
    debugShowCheckedModeBanner: false,
    supportedLocales: AppLocalizations.supportedLocales,
    localizationsDelegates: const [
      AppLocalizations.delegate,
      GlobalMaterialLocalizations.delegate,
      GlobalWidgetsLocalizations.delegate,
      GlobalCupertinoLocalizations.delegate,
    ],
    home: home,
  );
}

void main() {
  testWidgets(
    'Physical regression: Today refreshes from backend after capture confirmation',
    (tester) async {
      tester.view.physicalSize = const Size(1200, 3600);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      final repository = _RefreshingCommitmentRepository();
      addTearDown(repository.dispose);
      final container = ProviderContainer(
        overrides: [
          appConfigProvider.overrideWith(
            (ref) => const AppConfig(apiMode: ApiMode.localBackend),
          ),
          commitmentRepositoryProvider.overrideWithValue(repository),
          captureServiceProvider.overrideWithValue(
            _PersistingCaptureService(repository),
          ),
        ],
      );
      addTearDown(container.dispose);

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: _app(const TodayScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Call Maya'), findsNothing);

      final notifier = container.read(captureControllerProvider.notifier);
      await notifier.submitIntent('remind me to call maya today at 8:30 pm');
      await notifier.confirmSave();
      await container.read(commitmentsStreamProvider.future);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      expect(find.text('Call Maya'), findsOneWidget);
      expect(container.read(todayCommitmentsProvider), hasLength(1));
      expect(container.read(upcomingCommitmentsProvider), isEmpty);
    },
  );
}
