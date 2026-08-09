# Claude Handoff Specification — Mobile OS-Backed Secure Credential Storage

**Lanes**: Claude (Flutter Mobile Client owner) $\leftrightarrow$ Operational Infra Lane  
**Date**: August 9, 2026  
**Status**: `SPECIFIED — AWAITING CLAUDE FLUTTER INTEGRATION`  

---

## 1. Objective

Plain text `SharedPreferences` (or `NSUserDefaults`) is insecure for pilot authentication credentials. The Flutter client must store pilot tokens using OS-backed hardware-encrypted storage.

---

## 2. Platform Requirements

* **iOS**: Apple Keychain Services (`kSecClassGenericPassword` with `kSecAttrAccessibleAfterFirstUnlock`).
* **Android**: Android KeyStore-backed `EncryptedSharedPreferences` (AES-256 GCM).

---

## 3. Recommended Implementation (Flutter)

Use `flutter_secure_storage` or custom platform channels:

```dart
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class PilotCredentialStore {
  static const _storage = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
    iOptions: IOSOptions(accessibility: KeychainAccessibility.first_unlock),
  );
  
  static const _keyToken = 'maybesitter_pilot_participant_token';

  Future<void> saveToken(String token) async {
    await _storage.write(key: _keyToken, value: token);
  }

  Future<String?> readToken() async {
    return await _storage.read(key: _keyToken);
  }

  Future<void> clearToken() async {
    await _storage.delete(key: _keyToken);
  }
}
```

---

## 4. API Client Integration

Attach the stored token to every HTTP request sent to `/api/mobile/**`:

```dart
final token = await PilotCredentialStore().readToken();
if (token != null) {
  headers['Authorization'] = 'Bearer $token';
}
```
