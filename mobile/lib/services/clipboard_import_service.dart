import 'package:flutter/services.dart';

abstract interface class ClipboardImportService {
  Future<String?> readPlainText();
}

final class SystemClipboardImportService implements ClipboardImportService {
  const SystemClipboardImportService();

  @override
  Future<String?> readPlainText() async {
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    final text = data?.text?.trim();
    if (text == null || text.isEmpty) return null;
    return text;
  }
}
