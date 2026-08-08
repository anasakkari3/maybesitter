import 'dart:async';
import '../contracts/connectivity_service.dart';

class MockConnectivityService implements ConnectivityService {
  ConnectionStatus _status = ConnectionStatus.online;
  final _controller = StreamController<ConnectionStatus>.broadcast();

  void setStatus(ConnectionStatus status) {
    _status = status;
    _controller.add(_status);
  }

  @override
  Future<ConnectionStatus> checkStatus() async {
    return _status;
  }

  @override
  Stream<ConnectionStatus> observe() {
    return _controller.stream;
  }
}
