package expo.modules.healthconnectreadiness

import android.content.Context
import android.content.Intent
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.aggregate.AggregateMetric
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.HeartRateVariabilityRmssdRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.request.AggregateRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import expo.modules.kotlin.activityresult.AppContextActivityResultContract
import expo.modules.kotlin.activityresult.AppContextActivityResultLauncher
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.Serializable
import java.time.Duration
import java.time.Instant

class HealthConnectReadinessModule : Module() {
  private lateinit var permissionLauncher: AppContextActivityResultLauncher<HealthPermissionInput, Set<String>>

  override fun definition() = ModuleDefinition {
    Name("HealthConnectReadiness")

    RegisterActivityContracts {
      permissionLauncher = registerForActivityResult(HealthPermissionContract())
    }

    AsyncFunction("isSdkAvailable") {
      sdkAvailable()
    }

    AsyncFunction("authorization") Coroutine { read: List<String> ->
      if (!sdkAvailable()) return@Coroutine authorizationSnapshot(read, emptySet(), false, "unavailable")
      val granted = client().permissionController.getGrantedPermissions()
      authorizationSnapshot(read, granted, false)
    }

    AsyncFunction("requestAuthorization") Coroutine { read: List<String> ->
      if (!sdkAvailable()) return@Coroutine authorizationSnapshot(read, emptySet(), true, "unavailable")
      val requested = permissionNames(read)
      val granted = permissionLauncher.launch(HealthPermissionInput(ArrayList(requested)))
      authorizationSnapshot(read, granted, true)
    }

    AsyncFunction("readRecords") Coroutine { window: Map<String, String> ->
      val start = window["windowStart"]?.let(Instant::parse) ?: throw InvalidHealthWindowException()
      val end = window["windowEnd"]?.let(Instant::parse) ?: throw InvalidHealthWindowException()
      if (!start.isBefore(end)) throw InvalidHealthWindowException()
      readRecords(start, end)
    }

    AsyncFunction("revokeAllPermissions").Coroutine<Unit> {
      if (sdkAvailable()) client().permissionController.revokeAllPermissions()
    }

    AsyncFunction("clearLocalConnection") {
      // The module keeps no local cursor, token or sample cache.
    }
  }

  private fun context(): Context = appContext.reactContext ?: throw MissingReactContextException()

  private fun sdkAvailable(): Boolean =
    HealthConnectClient.getSdkStatus(context()) == HealthConnectClient.SDK_AVAILABLE

  private fun client(): HealthConnectClient = HealthConnectClient.getOrCreate(context())

  private fun permissionFor(name: String): String = when (name) {
    "sleep_session" -> HealthPermission.getReadPermission(SleepSessionRecord::class)
    "resting_heart_rate" -> HealthPermission.getReadPermission(RestingHeartRateRecord::class)
    "heart_rate_variability_rmssd" -> HealthPermission.getReadPermission(HeartRateVariabilityRmssdRecord::class)
    "steps" -> HealthPermission.getReadPermission(StepsRecord::class)
    else -> throw UnsupportedHealthPermissionException(name)
  }

  private fun permissionNames(read: List<String>): Set<String> = read.map(::permissionFor).toSet()

  private fun authorizationSnapshot(
    read: List<String>,
    grantedPermissions: Set<String>,
    requestCompleted: Boolean,
    forcedState: String? = null,
  ): Map<String, Any> {
    val granted = read.filter { grantedPermissions.contains(permissionFor(it)) }
    val denied = read.filterNot { grantedPermissions.contains(permissionFor(it)) }
    val state = forcedState ?: when {
      denied.isEmpty() -> "authorized"
      granted.isNotEmpty() -> "limited"
      requestCompleted -> "denied"
      else -> "not_determined"
    }
    return mapOf(
      "state" to state,
      "granted" to granted,
      "denied" to denied,
      "checkedAt" to Instant.now().toString(),
    )
  }

  private suspend fun readRecords(start: Instant, end: Instant): Map<String, Any> {
    val health = client()
    val filter = TimeRangeFilter.between(start, end)
    val sleeps = health.readRecords(ReadRecordsRequest(SleepSessionRecord::class, filter)).records
    val resting = health.readRecords(ReadRecordsRequest(RestingHeartRateRecord::class, filter)).records
    val variability = health.readRecords(ReadRecordsRequest(HeartRateVariabilityRmssdRecord::class, filter)).records
    val steps = health.aggregate(AggregateRequest(setOf(StepsRecord.COUNT_TOTAL), filter))[StepsRecord.COUNT_TOTAL]

    val result = mutableMapOf<String, Any>()
    if (sleeps.isNotEmpty()) {
      val first = sleeps.minBy { it.startTime }
      val last = sleeps.maxBy { it.endTime }
      val minutes = sleeps.sumOf { Duration.between(it.startTime, it.endTime).toMinutes() }
      result["sleep"] = mapOf(
        "observedAt" to last.endTime.toString(),
        "sleepStart" to first.startTime.toString(),
        "sleepEnd" to last.endTime.toString(),
        "totalSleepMinutes" to minutes,
      )
    }

    val latestResting = resting.maxByOrNull { it.time }
    val latestVariability = variability.maxByOrNull { it.time }
    if (latestResting != null || latestVariability != null) {
      val observedAt = listOfNotNull(latestResting?.time, latestVariability?.time).max()
      val heart = mutableMapOf<String, Any>("observedAt" to observedAt.toString())
      latestResting?.let { heart["restingHeartRate"] = it.beatsPerMinute }
      latestVariability?.let { heart["hrvMilliseconds"] = it.heartRateVariabilityMillis }
      result["heart"] = heart
    }

    if (steps != null) {
      result["steps"] = mapOf(
        "observedAt" to end.toString(),
        "count" to steps,
      )
    }
    return result
  }
}

private data class HealthPermissionInput(val permissions: ArrayList<String>) : Serializable

private class HealthPermissionContract : AppContextActivityResultContract<HealthPermissionInput, Set<String>> {
  private val delegate = PermissionController.createRequestPermissionResultContract()

  override fun createIntent(context: Context, input: HealthPermissionInput): Intent =
    delegate.createIntent(context, input.permissions.toSet())

  override fun parseResult(input: HealthPermissionInput, resultCode: Int, intent: Intent?): Set<String> =
    delegate.parseResult(resultCode, intent)
}

private class InvalidHealthWindowException : Exception("Health Connect window must contain valid increasing ISO-8601 instants.")
private class MissingReactContextException : Exception("Health Connect is unavailable without an Android activity context.")
private class UnsupportedHealthPermissionException(name: String) : Exception("Unsupported Health Connect permission: $name")
