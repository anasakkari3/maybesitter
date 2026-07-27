import 'package:flutter/foundation.dart';

@immutable
abstract class Failure {
  final String message;
  final String? code;

  const Failure(this.message, {this.code});
}

class NetworkFailure extends Failure {
  const NetworkFailure([super.message = 'Network connectivity unavailable'])
    : super(code: 'NETWORK_ERROR');
}

class ExtractionFailure extends Failure {
  const ExtractionFailure([super.message = 'Could not extract commitments'])
    : super(code: 'EXTRACTION_ERROR');
}

class StorageFailure extends Failure {
  const StorageFailure([super.message = 'Failed to persist local data'])
    : super(code: 'STORAGE_ERROR');
}

class ValidationFailure extends Failure {
  const ValidationFailure([super.message = 'Invalid input parameters'])
    : super(code: 'VALIDATION_ERROR');
}
