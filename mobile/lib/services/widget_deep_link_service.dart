import 'package:flutter/services.dart';
import '../features/capture/capture_flow_launch.dart';

typedef RouteNavigator = void Function(String location);

class WidgetDeepLinkService {
  static const _defaultChannel = MethodChannel(
    'com.maybesitter.mobile/deep_links',
  );

  final MethodChannel channel;

  const WidgetDeepLinkService({this.channel = _defaultChannel});

  Future<void> start(RouteNavigator navigate) async {
    channel.setMethodCallHandler((call) async {
      if (call.method != 'link') return;
      final location = routeForUri(
        Uri.tryParse(call.arguments as String? ?? ''),
      );
      if (location != null) navigate(location);
    });

    try {
      final initialLink = await channel.invokeMethod<String>('getInitialLink');
      final location = routeForUri(Uri.tryParse(initialLink ?? ''));
      if (location != null) navigate(location);
    } on MissingPluginException {
      return;
    } on PlatformException {
      return;
    }
  }

  Future<void> dispose() async {
    channel.setMethodCallHandler(null);
  }

  static String? routeForUri(Uri? uri) {
    if (uri == null || uri.scheme != 'maybesitter') return null;
    final segments = [if (uri.host.isNotEmpty) uri.host, ...uri.pathSegments];
    if (segments.isEmpty) return '/today';

    switch (segments.first) {
      case 'capture':
        return CaptureFlowLaunch.locationFromExternalUri(uri);
      case 'today':
      case 'next':
        return '/today';
      case 'commitments':
      case 'item':
        if (segments.length < 2 || segments[1].isEmpty) return '/today';
        return '/commitments/${Uri.encodeComponent(segments[1])}';
      default:
        return null;
    }
  }
}
