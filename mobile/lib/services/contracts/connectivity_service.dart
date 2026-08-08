enum ConnectionStatus {
  online,
  offline;

  bool get isOnline => this == ConnectionStatus.online;
}

abstract interface class ConnectivityService {
  Future<ConnectionStatus> checkStatus();
  Stream<ConnectionStatus> observe();
}
