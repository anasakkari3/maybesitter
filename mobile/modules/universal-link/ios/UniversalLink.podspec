Pod::Spec.new do |s|
  s.name           = 'UniversalLink'
  s.version        = '1.0.0'
  s.summary        = 'Opens an https link only if an installed app claims it (closure CL2b, #21).'
  s.description    = 'UIApplication.open with universalLinksOnly, resolving whether an app opened the link.'
  s.license        = 'UNLICENSED'
  s.author         = 'MaybeSitter'
  s.homepage       = 'https://github.com/anasakkari3/maybesitter'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
