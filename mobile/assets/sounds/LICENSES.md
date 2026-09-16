# Notification sounds

## `maybesitter_hard.wav`

The Must reminder's sound (UC-3.12a, #197).

- **Origin:** synthesised for MaybeSitter by `mobile/scripts/generate-hard-reminder-sound.py`
  — three soft two-note bell phrases (A5 → E6), 6 seconds, 22.05 kHz 16-bit mono PCM.
  No recording, sample or third-party sound was used. The script is deterministic;
  running it again produces the same file byte for byte.
- **License:** original work of the MaybeSitter project, dedicated to the public domain
  under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). No attribution is
  required anywhere in the app or the store listing.
- **Platform limits it is inside:** iOS plays a custom notification sound only when it is
  under 30 seconds and linear PCM, µ-law, a-law or IMA4 in a `.wav`, `.aiff` or `.caf`
  container; longer sounds are replaced with the default. Android plays it from `res/raw`
  as the `maybesitter_hard` channel's sound, as alarm audio.
