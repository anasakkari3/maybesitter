import SwiftUI
import WidgetKit

/// The widget extension's entry point (UC-3.R1, #203).
///
/// One widget. The Apple Watch complication, interactive buttons and Live
/// Activities are out of scope for v1 (#203 "Out of scope").
@main
struct MaybeSitterWidgets: WidgetBundle {
  var body: some Widget {
    NextStepWidget()
  }
}
