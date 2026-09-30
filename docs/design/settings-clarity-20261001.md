# Settings clarity pass — staging

The old Settings index showed 21 detailed rows, a profile shortcut, several long descriptions, and the account email twice. Important destinations were mixed with implementation categories: integrations, calendar, and sources appeared as peers; reminders and the morning plan opened the same screen.

The index now shows five short destinations. The existing settings screens and controls stay in place.

| Index category | Destinations |
| --- | --- |
| Your day | My MaybeSitter, routine, weekly fixed time, energy, life sections, financial context |
| Sources & connections | Integrations, AI context import, calendar, available sources, background activity |
| Alerts & home screen | Reminders and morning plan, widget, places |
| Memory & privacy | Personalization, what it knows, trust, activity |
| App & account | Language and appearance, account, about |

Each category opens a short page with a back button. The index shows a notification warning only when the phone blocks notifications. Detailed descriptions and values are shown beside the setting they explain, not repeated on the index. The morning plan remains inside its existing reminders screen, so the two former rows become one named destination.

This changes navigation depth from one to two taps for many settings. It reduces the initial choice count from 22 to five, keeps every existing destination reachable, and preserves the current coral palette, RTL behavior, touch targets, and Arabic, English, and Hebrew copy.

## Staging review

On 2026-10-01, the Android staging build was opened on `emulator-5556` with a disposable account. The Arabic index showed all five categories in the viewport. I opened Your day and Sources & connections, checked their row labels and back navigation, and confirmed the App & account page opened from the index. The Android screenshots are in `outputs/maybesitter-settings-staging-20261001/` at the workspace root. The mobile navigation and localization tests cover all destination routes, the notification permission warning, and RTL rendering.
