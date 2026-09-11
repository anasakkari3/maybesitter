import '../../models/calendar_import.dart';

abstract interface class CalendarImportService {
  Future<CalendarImportSnapshot> getSnapshot();

  Future<CalendarImportSnapshot> connect();

  Future<CalendarImportSnapshot> refresh();

  Future<CalendarImportSnapshot> disconnect();

  Future<CalendarImportSnapshot> deleteImportedData();
}
