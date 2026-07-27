import '../../models/capture_result.dart';

abstract interface class CaptureService {
  Future<CaptureResult> capture(CaptureRequest request);
}
