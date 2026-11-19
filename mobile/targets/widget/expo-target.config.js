/**
 * The iOS home-screen and lock-screen widget (UC-3.R1, #203).
 *
 * Generated into the Xcode project at `expo prebuild` by `@bacons/apple-targets`
 * — `ios/` is CNG output and is never committed, so this folder is the only
 * place the widget's source lives.
 *
 * The App Group is named explicitly rather than synced from the main app's
 * entitlements: the widget reads exactly one suite, and a second group added
 * to the app one day must not silently become readable by the extension.
 *
 * 17.0 because `containerBackground(for: .widget)` is iOS 17 API and WidgetKit
 * requires it there. On 16.x the app installs and the widget is simply not
 * offered.
 *
 * No `colors` here on purpose: the widget's palette is `WidgetPalette.swift`,
 * which a test holds to `src/theme/tokens.ts`. A second copy in an asset
 * catalog is how the widget stayed teal after the app moved on.
 *
 * @type {import('@bacons/apple-targets/app.plugin').ConfigFunction}
 */
module.exports = () => ({
  type: 'widget',
  name: 'MaybeSitterWidget',
  displayName: 'MaybeSitter',
  bundleIdentifier: '.widget',
  deploymentTarget: '17.0',
  frameworks: ['SwiftUI', 'WidgetKit'],
  entitlements: {
    'com.apple.security.application-groups': ['group.com.maybesitter.app'],
  },
});
