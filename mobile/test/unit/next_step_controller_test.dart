import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/features/next_step/next_step_controller.dart';
import 'package:maybesitter_mobile/models/next_step.dart';
import 'package:maybesitter_mobile/services/api/api_client.dart';
import 'package:maybesitter_mobile/services/contracts/next_step_service.dart';

void main() {
  group('NextStepNotifier idempotency', () {
    test('same logical action retry reuses its idempotency key', () async {
      final service = _RecordingNextStepService(failFirstDecision: true);
      final notifier = NextStepNotifier(service: service);

      await notifier.load(locale: 'en');
      await notifier.decide(NextStepDecision.accept, locale: 'en');
      await notifier.decide(NextStepDecision.accept, locale: 'en');

      expect(service.keys, hasLength(2));
      expect(service.keys.first, service.keys.last);
    });

    test('a different deliberate decision gets a new idempotency key', () async {
      final service = _RecordingNextStepService(failFirstDecision: true);
      final notifier = NextStepNotifier(service: service);

      await notifier.load(locale: 'en');
      await notifier.decide(NextStepDecision.accept, locale: 'en');
      await notifier.decide(NextStepDecision.dismiss, locale: 'en');

      expect(service.keys, hasLength(2));
      expect(service.keys.first, isNot(service.keys.last));
    });
  });
}

class _RecordingNextStepService implements NextStepService {
  final bool failFirstDecision;
  final List<String> keys = [];

  bool _failed = false;

  _RecordingNextStepService({this.failFirstDecision = false});

  @override
  Future<NextStepResult> getNextStep({required String locale}) async {
    return const NextStepAvailable(_proposal);
  }

  @override
  Future<NextStepDecisionOutcome> recordDecision({
    required NextStepRecommendation recommendation,
    required NextStepDecision decision,
    required String idempotencyKey,
    required String locale,
    String? editedTitle,
  }) async {
    keys.add(idempotencyKey);
    if (failFirstDecision && !_failed) {
      _failed = true;
      throw const NetworkException('offline');
    }
    return NextStepDecisionOutcome(
      proposalId: recommendation.proposalId,
      decision: decision,
      editedTitle: editedTitle,
      decidedAt: DateTime.utc(2026, 8, 9),
    );
  }
}

const _proposal = NextStepRecommendation(
  proposalId: 'proposal-7',
  state: NextStepState.ready,
  locale: 'en',
  primaryStep: NextStepPrimaryStep(
    commitmentId: 'c-1',
    title: 'Call Maya',
  ),
  availableActions: [
    NextStepDecision.accept,
    NextStepDecision.dismiss,
  ],
);
