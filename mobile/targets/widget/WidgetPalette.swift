import SwiftUI

/// The widget's colours: the app's own, value for value.
///
/// `src/theme/tokens.ts` is the source (Stitch redesign, 2026-10-02): a warm
/// paper light scheme, a navy dark scheme, coral for the action, amber for
/// what needs attention, green for what is confirmed. A Jest test
/// (`iosWidgetDesign.test.ts`) reads this file and holds every hex below to
/// that file, and holds every text pair to WCAG AA, so the widget cannot drift
/// back to a look the app no longer has.
///
/// Colours live here and not in an asset catalog on purpose: one place to
/// read, one place the test reads, and nothing for a prebuild to forget to
/// generate. The scheme comes from the widget's own environment, so the home
/// screen's light/dark switch re-colours it without a timeline reload.
struct WidgetPalette {
  let background: UInt32
  let surface: UInt32
  let surfaceAlt: UInt32
  let textPrimary: UInt32
  let textMuted: UInt32
  let brand: UInt32
  let brandContainer: UInt32
  let brandContainerOpacity: Double
  let onBrand: UInt32
  let must: UInt32
  let success: UInt32
  let successContainer: UInt32
  let successContainerOpacity: Double
  /// `false` in WidgetKit's accented and vibrant modes, where the system paints
  /// every pixel of a view in one colour and keeps only its transparency. A solid
  /// fill would then become a solid block hiding the text on it, so fills go flat
  /// and translucent and the text keeps its own contrast.
  var fullColor: Bool = true

  static let light = WidgetPalette(
    background: 0xF7F5F1,
    surface: 0xFFFFFF,
    surfaceAlt: 0xF0EDE7,
    textPrimary: 0x1A1F2B,
    textMuted: 0x5B6375,
    brand: 0xC2394A,
    brandContainer: 0xFBE3E6,
    brandContainerOpacity: 1,
    onBrand: 0xFFFFFF,
    must: 0x7A5200,
    success: 0x1E6B45,
    successContainer: 0xE2F5EA,
    successContainerOpacity: 1
  )

  static let dark = WidgetPalette(
    background: 0x0E1526,
    surface: 0x172036,
    surfaceAlt: 0x1F2A44,
    textPrimary: 0xF3F5FA,
    textMuted: 0xA9B2C7,
    brand: 0xFF6B6B,
    brandContainer: 0xFF6B6B,
    brandContainerOpacity: 0.15,
    onBrand: 0x0E1526,
    must: 0xF5B547,
    success: 0x4CC38A,
    successContainer: 0x4CC38A,
    successContainerOpacity: 0.15
  )

  static func of(_ scheme: ColorScheme, fullColor: Bool = true) -> WidgetPalette {
    var palette = scheme == .dark ? dark : light
    palette.fullColor = fullColor
    return palette
  }

  /// A soft fill behind text or an icon: the colour itself in full colour, a
  /// faint wash of the foreground otherwise.
  private func fill(_ color: Color) -> Color {
    fullColor ? color : Color.primary.opacity(0.12)
  }

  private static func color(_ hex: UInt32, _ opacity: Double = 1) -> Color {
    Color(
      .sRGB,
      red: Double((hex >> 16) & 0xFF) / 255,
      green: Double((hex >> 8) & 0xFF) / 255,
      blue: Double(hex & 0xFF) / 255,
      opacity: opacity
    )
  }

  var bg: Color { Self.color(background) }
  var card: Color { fill(Self.color(surface)) }
  var ink: Color { Self.color(textPrimary) }
  var muted: Color { Self.color(textMuted) }
  var accent: Color { Self.color(brand) }
  var accentSoft: Color { fill(Self.color(brandContainer, brandContainerOpacity)) }
  var onAccent: Color { Self.color(onBrand) }
  var attention: Color { Self.color(must) }
  var done: Color { Self.color(success) }
  var doneSoft: Color { fill(Self.color(successContainer, successContainerOpacity)) }

  /// The app's importance colours (`priorityTagKind` in `src/ui/chrome.tsx`):
  /// «لازم» coral, «مهم» amber, «حلو» green, and quiet grey when the step's
  /// importance is not known.
  func importance(_ priority: String?) -> Color {
    switch priority {
    case "must": return accent
    case "should": return attention
    case "nice": return done
    default: return muted
    }
  }
}
