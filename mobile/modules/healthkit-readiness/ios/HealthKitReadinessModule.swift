import ExpoModulesCore
import HealthKit

public class HealthKitReadinessModule: Module {
  private let store = HKHealthStore()
  private let iso8601 = ISO8601DateFormatter()
  // JavaScript's `toISOString()` always writes milliseconds (".000Z"), which
  // the default formatter rejects. Closure CL2b (D5): every read threw
  // InvalidHealthWindowException before a sample was asked for. Both forms
  // are accepted now; output keeps the whole-second form above.
  private let iso8601Fractional: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }()

  public func definition() -> ModuleDefinition {
    Name("HealthKitReadiness")

    AsyncFunction("isAvailable") { () -> Bool in
      HKHealthStore.isHealthDataAvailable()
    }

    AsyncFunction("authorization") { (read: [String]) async throws -> [String: Any] in
      try await self.authorizationSnapshot(read: read)
    }

    AsyncFunction("requestAuthorization") { (read: [String]) async throws -> [String: Any] in
      let types = try self.objectTypes(read)
      try await self.requestAuthorization(types)
      return self.snapshot(state: "limited", checkedAt: Date())
    }

    AsyncFunction("readSamples") { (window: [String: String]) async throws -> [String: Any] in
      guard
        let startValue = window["windowStart"],
        let endValue = window["windowEnd"],
        let start = self.instant(startValue),
        let end = self.instant(endValue),
        start < end
      else {
        throw InvalidHealthWindowException()
      }

      async let sleep = self.readSleep(start: start, end: end)
      async let restingHeartRate = self.readLatestQuantity(
        identifier: .restingHeartRate,
        unit: HKUnit.count().unitDivided(by: .minute()),
        start: start,
        end: end
      )
      async let hrv = self.readLatestQuantity(
        identifier: .heartRateVariabilitySDNN,
        unit: .secondUnit(with: .milli),
        start: start,
        end: end
      )
      async let steps = self.readCumulativeQuantity(identifier: .stepCount, unit: .count(), start: start, end: end)

      var result: [String: Any] = [:]
      let sleepValue = try await sleep
      if let value = sleepValue { result["sleep"] = value }

      let heartRate = try await restingHeartRate
      let variability = try await hrv
      if heartRate != nil || variability != nil {
        let observedAt = [heartRate?.date, variability?.date].compactMap { $0 }.max() ?? end
        var heart: [String: Any] = ["observedAt": self.iso8601.string(from: observedAt)]
        if let heartRate = heartRate { heart["restingHeartRate"] = heartRate.value }
        if let variability = variability { heart["hrvMilliseconds"] = variability.value }
        result["heart"] = heart
      }

      let stepValue = try await steps
      if let value = stepValue {
        result["activity"] = [
          "observedAt": self.iso8601.string(from: value.date),
          "stepCount": value.value,
        ]
      }
      return result
    }

    AsyncFunction("clearLocalConnection") { () -> Void in
      // HealthKit has no app-level read-token to erase. The app drops its own
      // connection state; permission revocation remains an iOS Settings action.
    }
  }

  private func authorizationSnapshot(read: [String]) async throws -> [String: Any] {
    guard HKHealthStore.isHealthDataAvailable() else {
      return snapshot(state: "unavailable", checkedAt: Date())
    }
    let types = try objectTypes(read)
    let status = try await requestStatus(types)
    switch status {
    case .shouldRequest:
      return snapshot(state: "not_determined", checkedAt: Date())
    case .unnecessary:
      // HealthKit intentionally does not reveal whether individual read types
      // were denied. Reads return no samples for denied types, so this is
      // represented as limited instead of claiming every permission is granted.
      return snapshot(state: "limited", checkedAt: Date())
    case .unknown:
      return snapshot(state: "error", checkedAt: Date())
    @unknown default:
      return snapshot(state: "error", checkedAt: Date())
    }
  }

  private func instant(_ value: String) -> Date? {
    iso8601.date(from: value) ?? iso8601Fractional.date(from: value)
  }

  private func snapshot(state: String, checkedAt: Date) -> [String: Any] {
    [
      "state": state,
      "granted": [],
      "denied": [],
      "checkedAt": iso8601.string(from: checkedAt),
    ]
  }

  private func objectTypes(_ names: [String]) throws -> Set<HKObjectType> {
    var result = Set<HKObjectType>()
    for name in names {
      switch name {
      case "sleep_analysis":
        guard let type = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) else { continue }
        result.insert(type)
      case "resting_heart_rate":
        guard let type = HKObjectType.quantityType(forIdentifier: .restingHeartRate) else { continue }
        result.insert(type)
      case "heart_rate_variability_sdnn":
        guard let type = HKObjectType.quantityType(forIdentifier: .heartRateVariabilitySDNN) else { continue }
        result.insert(type)
      case "step_count":
        guard let type = HKObjectType.quantityType(forIdentifier: .stepCount) else { continue }
        result.insert(type)
      default:
        throw UnsupportedHealthPermissionException(name)
      }
    }
    return result
  }

  private func requestStatus(_ types: Set<HKObjectType>) async throws -> HKAuthorizationRequestStatus {
    try await withCheckedThrowingContinuation { continuation in
      store.getRequestStatusForAuthorization(toShare: [], read: types) { status, error in
        if let error = error { continuation.resume(throwing: error) }
        else { continuation.resume(returning: status) }
      }
    }
  }

  private func requestAuthorization(_ types: Set<HKObjectType>) async throws {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      store.requestAuthorization(toShare: [], read: types) { success, error in
        if let error = error { continuation.resume(throwing: error) }
        else if success { continuation.resume(returning: ()) }
        else { continuation.resume(throwing: HealthAuthorizationFailedException()) }
      }
    }
  }

  private func predicate(start: Date, end: Date) -> NSPredicate {
    HKQuery.predicateForSamples(withStart: start, end: end, options: [.strictStartDate, .strictEndDate])
  }

  private func readSleep(start: Date, end: Date) async throws -> [String: Any]? {
    guard let type = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) else { return nil }
    let samples: [HKCategorySample] = try await readSamples(type: type, start: start, end: end)
    let asleep = samples.filter { sample in
      switch sample.value {
      case HKCategoryValueSleepAnalysis.asleepCore.rawValue,
           HKCategoryValueSleepAnalysis.asleepDeep.rawValue,
           HKCategoryValueSleepAnalysis.asleepREM.rawValue,
           HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue:
        return true
      default:
        return false
      }
    }
    guard !asleep.isEmpty else { return nil }
    let sleepStart = asleep.map(\.startDate).min() ?? start
    let sleepEnd = asleep.map(\.endDate).max() ?? end
    let minutes = asleep.reduce(0.0) { $0 + $1.endDate.timeIntervalSince($1.startDate) } / 60.0
    return [
      "observedAt": iso8601.string(from: sleepEnd),
      "sleepStart": iso8601.string(from: sleepStart),
      "sleepEnd": iso8601.string(from: sleepEnd),
      "totalSleepMinutes": minutes,
    ]
  }

  private func readSamples<T: HKSample>(type: HKSampleType, start: Date, end: Date) async throws -> [T] {
    try await withCheckedThrowingContinuation { continuation in
      let sort = NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: false)
      let query = HKSampleQuery(
        sampleType: type,
        predicate: predicate(start: start, end: end),
        limit: HKObjectQueryNoLimit,
        sortDescriptors: [sort]
      ) { _, samples, error in
        if let error = error, !isHealthNoData(error) { continuation.resume(throwing: error) }
        else { continuation.resume(returning: (samples as? [T]) ?? []) }
      }
      store.execute(query)
    }
  }

  private func readLatestQuantity(
    identifier: HKQuantityTypeIdentifier,
    unit: HKUnit,
    start: Date,
    end: Date
  ) async throws -> (value: Double, date: Date)? {
    guard let type = HKObjectType.quantityType(forIdentifier: identifier) else { return nil }
    let samples: [HKQuantitySample] = try await readSamples(type: type, start: start, end: end)
    guard let sample = samples.first else { return nil }
    return (sample.quantity.doubleValue(for: unit), sample.endDate)
  }

  private func readCumulativeQuantity(
    identifier: HKQuantityTypeIdentifier,
    unit: HKUnit,
    start: Date,
    end: Date
  ) async throws -> (value: Double, date: Date)? {
    guard let type = HKObjectType.quantityType(forIdentifier: identifier) else { return nil }
    return try await withCheckedThrowingContinuation { continuation in
      let query = HKStatisticsQuery(
        quantityType: type,
        quantitySamplePredicate: predicate(start: start, end: end),
        options: .cumulativeSum
      ) { _, statistics, error in
        // A statistics query over a window with no samples does not return
        // nil: it fails with `errorNoData`. That is "no steps", not an error.
        if let error = error, !isHealthNoData(error) { continuation.resume(throwing: error) }
        else if let sum = statistics?.sumQuantity() {
          continuation.resume(returning: (sum.doubleValue(for: unit), end))
        } else {
          continuation.resume(returning: nil)
        }
      }
      store.execute(query)
    }
  }
}

/// HealthKit's "nothing recorded in this window". An empty Health is an
/// answer — no data yet — not a failed read (closure CL2b, D5). A free
/// function so the query callbacks capture nothing.
private func isHealthNoData(_ error: Error) -> Bool {
  (error as? HKError)?.code == .errorNoData
}

private class InvalidHealthWindowException: Exception {
  override var reason: String { "HealthKit sample window must contain valid increasing ISO-8601 instants." }
}

private class UnsupportedHealthPermissionException: GenericException<String> {
  override var reason: String { "Unsupported HealthKit read permission: \(param)" }
}

private class HealthAuthorizationFailedException: Exception {
  override var reason: String { "HealthKit authorization did not complete." }
}
