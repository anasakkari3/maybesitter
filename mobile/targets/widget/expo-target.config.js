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
  colors: {
    $widgetBackground: { light: '#FFFFFF', dark: '#1A2023' },
    textPrimary: { light: '#14181B', dark: '#ECEFF1' },
    textMuted: { light: '#5F6B70', dark: '#9AA6AB' },
    brand: { light: '#1F7A8C', dark: '#6FC3D6' },
    onBrand: { light: '#FFFFFF', dark: '#101416' },
    must: { light: '#8A6A2E', dark: '#D9B06B' },
  },
});
