Pod::Spec.new do |s|
  s.name           = 'HealthKitReadiness'
  s.version        = '1.0.0'
  s.summary        = 'Reads the minimum on-device HealthKit signals used by readiness.'
  s.description    = 'Exposes sleep, resting heart rate, HRV and step summaries without persisting raw samples.'
  s.license        = 'UNLICENSED'
  s.author         = 'MaybeSitter'
  s.homepage       = 'https://github.com/anasakkari3/maybesitter'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'HealthKit'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
