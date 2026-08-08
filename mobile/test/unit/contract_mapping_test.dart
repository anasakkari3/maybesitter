import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/models/capture_result.dart';
import 'package:maybesitter_mobile/models/commitment.dart';
import 'package:maybesitter_mobile/services/api/dtos/activity_dtos.dart';
import 'package:maybesitter_mobile/services/api/dtos/api_error_dto.dart';
import 'package:maybesitter_mobile/services/api/dtos/commitment_dtos.dart';
import 'package:maybesitter_mobile/services/api/dtos/proposal_dtos.dart';
import 'package:maybesitter_mobile/services/api/mappers/commitment_mapper.dart';
import 'package:maybesitter_mobile/services/api/mappers/proposal_mapper.dart';

void main() {
  group('Backend Contract DTO & Mapping Tests', () {
    test('Parses CaptureProposalResponseDto with proposed items', () {
      final json = {
        'proposalId': '550e8400-e29b-41d4-a716-446655440000',
        'status': 'proposed',
        'items': [
          {
            'itemId': 'item-1',
            'title': 'Doctor appointment',
            'resolvedTime': '2026-07-29T09:00:00.000Z',
            'needsClarification': false,
          },
          {
            'itemId': 'item-2',
            'title': 'Work afterward',
            'resolvedTime': '2026-07-29T11:30:00.000Z',
            'needsClarification': false,
          },
        ],
      };

      final dto = CaptureProposalResponseDto.fromJson(json);
      expect(dto.proposalId, equals('550e8400-e29b-41d4-a716-446655440000'));
      expect(dto.status, equals(ProposalStatusDto.proposed));
      expect(dto.items.length, equals(2));
      expect(dto.items[0].itemId, equals('item-1'));

      final domainResult = ProposalMapper.mapToDomain(
        dto: dto,
        rawInput: 'Doctor and work tomorrow',
      );
      expect(domainResult.status, equals(CaptureStatus.needsConfirmation));
      expect(domainResult.extractedCommitments.length, equals(2));
      expect(
        domainResult.extractedCommitments[0].title,
        equals('Doctor appointment'),
      );
      expect(
        domainResult.extractedCommitments[1].title,
        equals('Work afterward'),
      );
    });

    test('Safely handles unknown ProposalStatus enum values', () {
      final json = {
        'proposalId': 'prop-unk',
        'status': 'future_experimental_status',
        'items': [],
      };

      final dto = CaptureProposalResponseDto.fromJson(json);
      expect(dto.status, equals(ProposalStatusDto.unknown));

      final domainResult = ProposalMapper.mapToDomain(
        dto: dto,
        rawInput: 'Test input',
      );
      expect(domainResult.status, equals(CaptureStatus.extractionFailed));
    });

    test('Parses unsupported_request status', () {
      final json = {
        'proposalId': 'prop-unsupported',
        'status': 'unsupported_request',
        'items': [],
      };

      final dto = CaptureProposalResponseDto.fromJson(json);
      expect(dto.status, equals(ProposalStatusDto.unsupportedRequest));

      final domainResult = ProposalMapper.mapToDomain(
        dto: dto,
        rawInput: 'What is the weather today?',
      );
      expect(domainResult.status, equals(CaptureStatus.unsupportedRequest));
    });

    test(
      'Parses ConfirmProposalResponseDto with persisted and failed items',
      () {
        final json = {
          'success': true,
          'persisted': [
            {
              'itemId': 'item-1',
              'commitmentId': 'cid-1',
              'title': 'Doctor appointment',
              'resolvedTime': '2026-07-29T09:00:00.000Z',
            },
          ],
          'failed': [],
        };

        final dto = ConfirmProposalResponseDto.fromJson(json);
        expect(dto.success, isTrue);
        expect(dto.persisted.length, equals(1));
        expect(dto.persisted[0].commitmentId, equals('cid-1'));
        expect(dto.failed, isEmpty);
      },
    );

    test(
      'Parses SoftDeleteResponseDto cleanly without claiming hard removal',
      () {
        final json = {
          'success': true,
          'id': 'cid-100',
          'deleted': false,
          'softDeleted': true,
          'status': 'dropped',
        };

        final dto = SoftDeleteResponseDto.fromJson(json);
        expect(dto.success, isTrue);
        expect(dto.id, equals('cid-100'));
        expect(dto.deleted, isFalse);
        expect(dto.softDeleted, isTrue);
        expect(dto.status, equals('dropped'));
      },
    );

    test('Maps BackendCommitmentDto to Flutter Commitment domain model', () {
      final json = {
        'id': 'backend-c1',
        'kind': 'task',
        'title': 'Pediatric Checkup',
        'description': 'Bring immunization records',
        'person': 'Leo',
        'status': 'active',
        'priority': {
          'level': 'high',
          'source': 'user_explicit',
          'pressureAllowed': true,
          'pressureLevel': 'gentle',
        },
        'timeSpec': {
          'kind': 'scheduled_event',
          'dueAt': '2026-07-28T10:00:00.000Z',
          'remindAt': '2026-07-28T09:30:00.000Z',
          'timezone': 'Asia/Jerusalem',
        },
        'currentAckState': 'seen',
        'postponedUntil': null,
        'createdAt': '2026-07-27T12:00:00.000Z',
        'updatedAt': '2026-07-27T12:00:00.000Z',
      };

      final dto = BackendCommitmentDto.fromJson(json);
      final domain = CommitmentMapper.mapToDomain(dto);

      expect(domain.id, equals('backend-c1'));
      expect(domain.title, equals('Pediatric Checkup'));
      expect(domain.description, equals('Bring immunization records'));
      expect(domain.priority, equals(CommitmentPriority.must));
      expect(domain.status, equals(CommitmentStatus.pending));
      expect(domain.category, contains('Leo'));
    });

    test('Workstream 1: Missing date maps to null (does not become today)', () {
      final json = {
        'id': 'c-nodate',
        'kind': 'task',
        'title': 'Buy coffee beans',
        'status': 'active',
        'priority': {'level': 'normal'},
        'timeSpec': {'kind': 'unscheduled', 'dueAt': null, 'remindAt': null},
        'createdAt': '2026-07-27T12:00:00.000Z',
        'updatedAt': '2026-07-27T12:00:00.000Z',
      };

      final dto = BackendCommitmentDto.fromJson(json);
      final domain = CommitmentMapper.mapToDomain(dto);

      expect(domain.scheduledDate, isNull);
      expect(domain.hasInvalidDate, isFalse);
    });

    test(
      'Workstream 1: Invalid date maps to null and sets hasInvalidDate flag',
      () {
        final json = {
          'id': 'c-invalid-date',
          'kind': 'task',
          'title': 'Call plumber',
          'status': 'active',
          'priority': {'level': 'normal'},
          'timeSpec': {
            'kind': 'scheduled_event',
            'dueAt': 'invalid-date-string',
          },
          'createdAt': '2026-07-27T12:00:00.000Z',
          'updatedAt': '2026-07-27T12:00:00.000Z',
        };

        final dto = BackendCommitmentDto.fromJson(json);
        final domain = CommitmentMapper.mapToDomain(dto);

        expect(domain.scheduledDate, isNull);
        expect(domain.hasInvalidDate, isTrue);
      },
    );

    test(
      'Workstream 1: Unknown status maps to CommitmentStatus.unknown (not pending)',
      () {
        final json = {
          'id': 'c-unknown-status',
          'kind': 'task',
          'title': 'Future state item',
          'status': 'future_status_code',
          'priority': {'level': 'normal'},
          'timeSpec': {'kind': 'unscheduled'},
          'createdAt': '2026-07-27T12:00:00.000Z',
          'updatedAt': '2026-07-27T12:00:00.000Z',
        };

        final dto = BackendCommitmentDto.fromJson(json);
        final domain = CommitmentMapper.mapToDomain(dto);

        expect(domain.status, equals(CommitmentStatus.unknown));
        expect(domain.status, isNot(equals(CommitmentStatus.pending)));
      },
    );

    test(
      'Workstream 1: Item with needsClarification maps scheduledDate to null',
      () {
        final json = {
          'proposalId': 'prop-clarify',
          'status': 'needs_clarification',
          'items': [
            {
              'itemId': 'item-ambiguous',
              'title': 'Work tomorrow',
              'resolvedTime': '2026-07-29T09:00:00.000Z',
              'needsClarification': true,
            },
          ],
        };

        final dto = CaptureProposalResponseDto.fromJson(json);
        final domainResult = ProposalMapper.mapToDomain(
          dto: dto,
          rawInput: 'Work tomorrow maybe',
        );

        expect(domainResult.extractedCommitments.first.scheduledDate, isNull);
        expect(
          domainResult.extractedCommitments.first.needsClarification,
          isTrue,
        );
      },
    );

    test('Parses ApiErrorDto common error envelope', () {
      final json = {'error': 'Invalid proposalId or proposal expired'};
      final dto = ApiErrorDto.fromJson(json);
      expect(dto.error, equals('Invalid proposalId or proposal expired'));
    });

    test('Parses ActivityListResponseDto with reminder attempts', () {
      final json = {
        'activity': [
          {
            'id': 'att-1',
            'itemId': 'item-1',
            'type': 'reminder',
            'channel': 'push',
            'status': 'sent',
            'idempotencyKey': 'idemp-1',
            'scheduledFor': '2026-07-28T09:30:00.000Z',
            'sentAt': '2026-07-28T09:30:01.000Z',
          },
        ],
      };

      final dto = ActivityListResponseDto.fromJson(json);
      expect(dto.activity.length, equals(1));
      expect(dto.activity[0].id, equals('att-1'));
      expect(dto.activity[0].type, equals('reminder'));
    });
  });
}
