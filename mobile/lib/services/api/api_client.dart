import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'dtos/api_error_dto.dart';

abstract class ApiException implements Exception {
  final String message;
  final int statusCode;

  const ApiException(this.message, {this.statusCode = 500});

  @override
  String toString() => 'ApiException($statusCode): $message';
}

class NetworkException extends ApiException {
  const NetworkException(super.message, {super.statusCode = 0});
}

class ValidationException extends ApiException {
  const ValidationException(super.message, {super.statusCode = 400});
}

class NotFoundException extends ApiException {
  const NotFoundException(super.message, {super.statusCode = 404});
}

/// Pilot exposure was refused. The decoded body is carried through because the
/// closed-pilot endpoints return a machine-readable `reason` alongside the
/// message, and the participant is owed the specific explanation rather than a
/// generic failure.
class ForbiddenException extends ApiException {
  final Map<String, dynamic> body;

  const ForbiddenException(
    super.message, {
    this.body = const {},
    super.statusCode = 403,
  });

  String? get reason => body['reason'] as String?;
}

/// The server's canonical state moved on — a decision was posted against a
/// proposal that is no longer current.
class ConflictException extends ApiException {
  const ConflictException(super.message, {super.statusCode = 409});
}

class ServerException extends ApiException {
  const ServerException(super.message, {super.statusCode = 500});
}

class ApiClient {
  final String baseUrl;
  final http.Client _client;

  ApiClient({required this.baseUrl, http.Client? client})
    : _client = client ?? http.Client();

  Uri _buildUri(String path, [Map<String, String>? queryParameters]) {
    final cleanedBase = baseUrl.endsWith('/')
        ? baseUrl.substring(0, baseUrl.length - 1)
        : baseUrl;
    final cleanedPath = path.startsWith('/') ? path : '/$path';
    return Uri.parse(
      '$cleanedBase$cleanedPath',
    ).replace(queryParameters: queryParameters);
  }

  Future<Map<String, dynamic>> post(
    String path,
    Map<String, dynamic> body,
  ) async {
    final uri = _buildUri(path);
    try {
      final response = await _client
          .post(
            uri,
            headers: {'Content-Type': 'application/json'},
            body: jsonEncode(body),
          )
          .timeout(const Duration(seconds: 10));

      return _handleResponse(response);
    } catch (e) {
      if (e is ApiException) rethrow;
      if (kDebugMode) {
        debugPrint('[ApiClient] POST $path error: $e');
      }
      throw NetworkException('Unable to connect to backend server: $e');
    }
  }

  Future<Map<String, dynamic>> get(
    String path, {
    Map<String, String>? queryParameters,
  }) async {
    final uri = _buildUri(path, queryParameters);
    try {
      final response = await _client
          .get(uri, headers: {'Accept': 'application/json'})
          .timeout(const Duration(seconds: 10));

      return _handleResponse(response);
    } catch (e) {
      if (e is ApiException) rethrow;
      if (kDebugMode) {
        debugPrint('[ApiClient] GET $path error: $e');
      }
      throw NetworkException('Unable to connect to backend server: $e');
    }
  }

  Future<Map<String, dynamic>> patch(
    String path,
    Map<String, dynamic> body,
  ) async {
    final uri = _buildUri(path);
    try {
      final response = await _client
          .patch(
            uri,
            headers: {'Content-Type': 'application/json'},
            body: jsonEncode(body),
          )
          .timeout(const Duration(seconds: 10));

      return _handleResponse(response);
    } catch (e) {
      if (e is ApiException) rethrow;
      if (kDebugMode) {
        debugPrint('[ApiClient] PATCH $path error: $e');
      }
      throw NetworkException('Unable to connect to backend server: $e');
    }
  }

  Future<Map<String, dynamic>> delete(String path) async {
    final uri = _buildUri(path);
    try {
      final response = await _client
          .delete(uri, headers: {'Accept': 'application/json'})
          .timeout(const Duration(seconds: 10));

      return _handleResponse(response);
    } catch (e) {
      if (e is ApiException) rethrow;
      if (kDebugMode) {
        debugPrint('[ApiClient] DELETE $path error: $e');
      }
      throw NetworkException('Unable to connect to backend server: $e');
    }
  }

  Map<String, dynamic> _handleResponse(http.Response response) {
    dynamic jsonBody;
    try {
      jsonBody = jsonDecode(response.body);
    } catch (_) {
      jsonBody = null;
    }

    if (response.statusCode >= 200 && response.statusCode < 300) {
      if (jsonBody is Map<String, dynamic>) {
        return jsonBody;
      }
      return {'success': true};
    }

    String errorMsg = 'HTTP ${response.statusCode} Error';
    if (jsonBody is Map<String, dynamic>) {
      final apiError = ApiErrorDto.fromJson(jsonBody);
      errorMsg = apiError.error;
    }

    switch (response.statusCode) {
      case 400:
        throw ValidationException(errorMsg, statusCode: 400);
      case 403:
        throw ForbiddenException(
          errorMsg,
          body: jsonBody is Map<String, dynamic> ? jsonBody : const {},
        );
      case 404:
        throw NotFoundException(errorMsg, statusCode: 404);
      case 409:
        throw ConflictException(errorMsg, statusCode: 409);
      case 503:
        throw ServerException(errorMsg, statusCode: 503);
      default:
        throw ServerException(errorMsg, statusCode: response.statusCode);
    }
  }
}
