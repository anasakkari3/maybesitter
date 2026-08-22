import 'package:go_router/go_router.dart';

enum CaptureLaunchSource {
  app,
  widget;

  static CaptureLaunchSource fromName(String? name) {
    return switch (name) {
      'widget' => CaptureLaunchSource.widget,
      _ => CaptureLaunchSource.app,
    };
  }
}

enum CaptureLaunchInput {
  typed,
  spoken;

  static CaptureLaunchInput fromName(String? name) {
    return switch (name) {
      'voice' || 'spoken' => CaptureLaunchInput.spoken,
      _ => CaptureLaunchInput.typed,
    };
  }
}

class CaptureFlowLaunch {
  static const routePath = '/capture';

  final CaptureLaunchSource source;
  final CaptureLaunchInput input;

  const CaptureFlowLaunch({
    this.source = CaptureLaunchSource.app,
    this.input = CaptureLaunchInput.typed,
  });

  bool get shouldStartSpokenPrompt => input == CaptureLaunchInput.spoken;

  static String location({
    CaptureLaunchSource source = CaptureLaunchSource.app,
    CaptureLaunchInput input = CaptureLaunchInput.typed,
  }) {
    final queryParameters = {
      if (source != CaptureLaunchSource.app) 'source': source.name,
      if (input != CaptureLaunchInput.typed) 'input': 'voice',
    };
    return Uri(
      path: routePath,
      queryParameters: queryParameters.isEmpty ? null : queryParameters,
    ).toString();
  }

  static String? locationFromExternalUri(Uri? uri) {
    if (uri == null || uri.scheme != 'maybesitter') return null;
    final segments = [if (uri.host.isNotEmpty) uri.host, ...uri.pathSegments];
    if (segments.isEmpty || segments.first != 'capture') return null;
    return location(
      source: CaptureLaunchSource.fromName(uri.queryParameters['source']),
      input: CaptureLaunchInput.fromName(uri.queryParameters['input']),
    );
  }

  factory CaptureFlowLaunch.fromRouteState(GoRouterState state) {
    final query = state.uri.queryParameters;
    return CaptureFlowLaunch(
      source: CaptureLaunchSource.fromName(query['source']),
      input: CaptureLaunchInput.fromName(query['input']),
    );
  }
}
