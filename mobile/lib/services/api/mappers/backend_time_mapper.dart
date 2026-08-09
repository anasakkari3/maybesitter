import 'package:intl/intl.dart';

class BackendTimeMapper {
  static DateTime parseAbsoluteIsoToLocal(String value) {
    return DateTime.parse(value).toLocal();
  }

  static String formatLocalClock(DateTime value) {
    return DateFormat('hh:mm a').format(value);
  }
}
