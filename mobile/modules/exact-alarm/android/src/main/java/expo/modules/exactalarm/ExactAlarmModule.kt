package expo.modules.exactalarm

import android.app.AlarmManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Whether Android will fire a scheduled reminder at its instant (UC-3.12a, #197).
 *
 * `SCHEDULE_EXACT_ALARM` is user-revocable from Android 12 (API 31): Settings →
 * Apps → MaybeSitter → "Alarms & reminders". When it is off,
 * expo-notifications' `ExpoSchedulingDelegate` falls back to
 * `setAndAllowWhileIdle`, which the OS may deliver minutes late. This module
 * only *reports* that and opens the settings page; it never schedules anything.
 */
class ExactAlarmModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExactAlarm")

    Function("canScheduleExactAlarms") {
      canScheduleExactAlarms()
    }

    Function("openExactAlarmSettings") {
      openExactAlarmSettings()
    }
  }

  private fun canScheduleExactAlarms(): Boolean {
    // Before API 31 the permission is granted at install and cannot be revoked.
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
    val context = appContext.reactContext ?: return false
    val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return false
    return alarmManager.canScheduleExactAlarms()
  }

  private fun openExactAlarmSettings(): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return false
    val context = appContext.reactContext ?: return false
    val intent = Intent(
      Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM,
      Uri.parse("package:" + context.packageName),
    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    return try {
      context.startActivity(intent)
      true
    } catch (error: Exception) {
      false
    }
  }
}
