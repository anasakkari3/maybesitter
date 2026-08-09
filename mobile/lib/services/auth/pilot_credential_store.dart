import 'package:flutter_secure_storage/flutter_secure_storage.dart';

abstract class PilotCredentialStore {
  Future<String?> readToken();
  Future<void> writeToken(String token);
  Future<void> deleteToken();
}

class SecurePilotCredentialStore implements PilotCredentialStore {
  static const tokenKey = 'maybesitter.v03.pilotToken';

  final FlutterSecureStorage storage;

  const SecurePilotCredentialStore({
    this.storage = const FlutterSecureStorage(),
  });

  @override
  Future<String?> readToken() => storage.read(key: tokenKey);

  @override
  Future<void> writeToken(String token) =>
      storage.write(key: tokenKey, value: token);

  @override
  Future<void> deleteToken() => storage.delete(key: tokenKey);
}

class InMemoryPilotCredentialStore implements PilotCredentialStore {
  String? _token;

  InMemoryPilotCredentialStore([this._token]);

  @override
  Future<String?> readToken() async => _token;

  @override
  Future<void> writeToken(String token) async {
    _token = token;
  }

  @override
  Future<void> deleteToken() async {
    _token = null;
  }
}
