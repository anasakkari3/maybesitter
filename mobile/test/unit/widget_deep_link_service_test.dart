import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/services/widget_deep_link_service.dart';

void main() {
  group('WidgetDeepLinkService', () {
    test('maps widget URLs to app routes', () {
      expect(
        WidgetDeepLinkService.routeForUri(Uri.parse('maybesitter://capture')),
        '/capture',
      );
      expect(
        WidgetDeepLinkService.routeForUri(
          Uri.parse('maybesitter://capture?source=widget&input=voice'),
        ),
        '/capture?source=widget&input=voice',
      );
      expect(
        WidgetDeepLinkService.routeForUri(Uri.parse('maybesitter://today')),
        '/today',
      );
      expect(
        WidgetDeepLinkService.routeForUri(
          Uri.parse('maybesitter://commitments/abc-123'),
        ),
        '/commitments/abc-123',
      );
      expect(
        WidgetDeepLinkService.routeForUri(Uri.parse('maybesitter://next')),
        '/today',
      );
    });

    test('rejects non-MaybeSitter URLs', () {
      expect(
        WidgetDeepLinkService.routeForUri(Uri.parse('https://example.com')),
        isNull,
      );
    });
  });
}
