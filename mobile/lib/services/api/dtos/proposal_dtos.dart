import 'package:flutter/foundation.dart';

enum ProposalStatusDto {
  proposed,
  needsClarification,
  noCommitment,
  unsupportedRequest,
  extractionFailed,
  unknown;

  static ProposalStatusDto fromJsonString(String value) {
    switch (value) {
      case 'proposed':
        return ProposalStatusDto.proposed;
      case 'needs_clarification':
        return ProposalStatusDto.needsClarification;
      case 'no_commitment':
        return ProposalStatusDto.noCommitment;
      case 'unsupported_request':
        return ProposalStatusDto.unsupportedRequest;
      case 'extraction_failed':
        return ProposalStatusDto.extractionFailed;
      default:
        return ProposalStatusDto.unknown;
    }
  }

  String toJsonString() {
    switch (this) {
      case ProposalStatusDto.proposed:
        return 'proposed';
      case ProposalStatusDto.needsClarification:
        return 'needs_clarification';
      case ProposalStatusDto.noCommitment:
        return 'no_commitment';
      case ProposalStatusDto.unsupportedRequest:
        return 'unsupported_request';
      case ProposalStatusDto.extractionFailed:
        return 'extraction_failed';
      case ProposalStatusDto.unknown:
        return 'unknown';
    }
  }
}

@immutable
class ProposedItemViewDto {
  final String itemId;
  final String title;
  final String? resolvedTime;
  final String? priorityLevel;
  final bool needsClarification;

  const ProposedItemViewDto({
    required this.itemId,
    required this.title,
    this.resolvedTime,
    this.priorityLevel,
    this.needsClarification = false,
  });

  factory ProposedItemViewDto.fromJson(Map<String, dynamic> json) {
    return ProposedItemViewDto(
      itemId: json['itemId'] as String? ?? '',
      title: json['title'] as String? ?? '',
      resolvedTime: json['resolvedTime'] as String?,
      priorityLevel: _priorityLevelFromJson(json['priority']),
      needsClarification: json['needsClarification'] as bool? ?? false,
    );
  }

  static String? _priorityLevelFromJson(Object? value) {
    if (value is String) return value;
    if (value is Map<String, dynamic>) return value['level'] as String?;
    return null;
  }

  Map<String, dynamic> toJson() => {
    'itemId': itemId,
    'title': title,
    'resolvedTime': resolvedTime,
    if (priorityLevel != null) 'priority': {'level': priorityLevel},
    'needsClarification': needsClarification,
  };
}

@immutable
class CaptureProposalResponseDto {
  final String proposalId;
  final ProposalStatusDto status;
  final List<ProposedItemViewDto> items;

  const CaptureProposalResponseDto({
    required this.proposalId,
    required this.status,
    required this.items,
  });

  factory CaptureProposalResponseDto.fromJson(Map<String, dynamic> json) {
    final statusStr = json['status'] as String? ?? '';
    final rawItems = json['items'] as List<dynamic>? ?? [];

    return CaptureProposalResponseDto(
      proposalId: json['proposalId'] as String? ?? '',
      status: ProposalStatusDto.fromJsonString(statusStr),
      items: rawItems
          .map((e) => ProposedItemViewDto.fromJson(e as Map<String, dynamic>))
          .toList(),
    );
  }

  Map<String, dynamic> toJson() => {
    'proposalId': proposalId,
    'status': status.toJsonString(),
    'items': items.map((e) => e.toJson()).toList(),
  };
}

@immutable
class ConfirmProposalRequestDto {
  final String proposalId;
  final String scopeId;
  final List<String> itemIds;
  final String? referenceTime;

  const ConfirmProposalRequestDto({
    required this.proposalId,
    this.scopeId = 'default',
    required this.itemIds,
    this.referenceTime,
  });

  Map<String, dynamic> toJson() => {
    'proposalId': proposalId,
    'scopeId': scopeId,
    'itemIds': itemIds,
    if (referenceTime != null) 'referenceTime': referenceTime,
  };
}

@immutable
class PersistedProposalItemDto {
  final String itemId;
  final String commitmentId;
  final String title;
  final String? resolvedTime;

  const PersistedProposalItemDto({
    required this.itemId,
    required this.commitmentId,
    required this.title,
    this.resolvedTime,
  });

  factory PersistedProposalItemDto.fromJson(Map<String, dynamic> json) {
    return PersistedProposalItemDto(
      itemId: json['itemId'] as String? ?? '',
      commitmentId: json['commitmentId'] as String? ?? '',
      title: json['title'] as String? ?? '',
      resolvedTime: json['resolvedTime'] as String?,
    );
  }

  Map<String, dynamic> toJson() => {
    'itemId': itemId,
    'commitmentId': commitmentId,
    'title': title,
    'resolvedTime': resolvedTime,
  };
}

@immutable
class FailedProposalItemDto {
  final String itemId;
  final String reason;

  const FailedProposalItemDto({required this.itemId, required this.reason});

  factory FailedProposalItemDto.fromJson(Map<String, dynamic> json) {
    return FailedProposalItemDto(
      itemId: json['itemId'] as String? ?? '',
      reason: json['reason'] as String? ?? 'unknown',
    );
  }

  Map<String, dynamic> toJson() => {'itemId': itemId, 'reason': reason};
}

@immutable
class ConfirmProposalResponseDto {
  final bool success;
  final List<PersistedProposalItemDto> persisted;
  final List<FailedProposalItemDto> failed;

  const ConfirmProposalResponseDto({
    required this.success,
    required this.persisted,
    required this.failed,
  });

  factory ConfirmProposalResponseDto.fromJson(Map<String, dynamic> json) {
    final rawPersisted = json['persisted'] as List<dynamic>? ?? [];
    final rawFailed = json['failed'] as List<dynamic>? ?? [];

    return ConfirmProposalResponseDto(
      success: json['success'] as bool? ?? false,
      persisted: rawPersisted
          .map(
            (e) => PersistedProposalItemDto.fromJson(e as Map<String, dynamic>),
          )
          .toList(),
      failed: rawFailed
          .map((e) => FailedProposalItemDto.fromJson(e as Map<String, dynamic>))
          .toList(),
    );
  }

  Map<String, dynamic> toJson() => {
    'success': success,
    'persisted': persisted.map((e) => e.toJson()).toList(),
    'failed': failed.map((e) => e.toJson()).toList(),
  };
}
