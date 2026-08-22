# Build configurations

Flutter reads these with `--dart-define-from-file`, available in the 3.44
toolchain this project pins.

## `pilot.json`

The closed-pilot build. Two of these defines are load-bearing and are the
reason this file is checked in rather than typed from memory:

- `REQUIRE_PILOT_ACCESS_GATE` — without it `PilotBootstrapGate` lets everyone
  straight into the app. A pilot build that omits it ships **with no access
  control at all**, and nothing about the running app looks wrong.
- `ENABLE_SAFE_COMMITMENT_PATCH` — without it the commitment PATCH path is
  refused, so editing a title or a time is silently unavailable against a
  deployed backend.

`API_BASE_URL` is deliberately absent: it is environment-specific and belongs
on the build command, not in the repository.

    flutter build ios --release \
      --dart-define-from-file=config/pilot.json \
      --dart-define=API_BASE_URL=https://<the deployed backend>

`pilot_build_config_test.dart` fails if either load-bearing define is removed
or set to anything but `true`.
