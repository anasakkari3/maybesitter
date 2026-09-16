import ExpoModulesCore

/// The iOS half of `exact-alarm` (UC-3.12a, #197).
///
/// iOS has no user-revocable exact-alarm permission: a `UNCalendarNotificationTrigger`
/// fires at its date. So the answer is always yes, and there is no settings page
/// to open — the function exists so JavaScript calls one API on both platforms.
public class ExactAlarmModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExactAlarm")

    Function("canScheduleExactAlarms") { () -> Bool in
      return true
    }

    Function("openExactAlarmSettings") { () -> Bool in
      return false
    }
  }
}
