import 'package:flutter/foundation.dart';

@immutable
class ApiErrorDto {
  final String error;

  const ApiErrorDto({required this.error});

  factory ApiErrorDto.fromJson(Map<String, dynamic> json) {
    return ApiErrorDto(
      error: json['error'] as String? ?? 'Unknown error occurred',
    );
  }

  Map<String, dynamic> toJson() => {'error': error};
}
