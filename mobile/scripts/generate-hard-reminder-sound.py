# Generates mobile/assets/sounds/maybesitter_hard.wav (UC-3.12a, #197): a calm, alarm-like chime.
# Usage: python3 scripts/generate-hard-reminder-sound.py assets/sounds/maybesitter_hard.wav
# Three rising two-note bell phrases (A5 -> E6), soft attack, exponential decay,
# a quiet octave partial. 6 seconds, 22.05 kHz, 16-bit mono PCM. Deterministic.
import math, struct, wave, sys
RATE = 22050
DURATION = 6.0
n = int(RATE * DURATION)
samples = [0.0] * n
def bell(start, freq, length=1.1, amp=0.42):
    s0 = int(start * RATE)
    for i in range(int(length * RATE)):
        k = s0 + i
        if k >= n: break
        t = i / RATE
        attack = min(1.0, t / 0.012)
        env = attack * math.exp(-t * 3.2)
        v = math.sin(2 * math.pi * freq * t) + 0.28 * math.sin(2 * math.pi * freq * 2 * t) * math.exp(-t * 6)
        samples[k] += amp * env * v
for phrase in range(3):
    base = phrase * 1.8
    bell(base + 0.0, 880.0)
    bell(base + 0.32, 1318.5)
peak = max(abs(x) for x in samples)
scale = 0.8 / peak
# 20 ms fade out at the very end so nothing clicks.
fade = int(0.02 * RATE)
for i in range(fade):
    samples[n - 1 - i] *= i / fade
out = wave.open(sys.argv[1], 'wb')
out.setnchannels(1); out.setsampwidth(2); out.setframerate(RATE)
out.writeframes(b''.join(struct.pack('<h', int(max(-1, min(1, x * scale)) * 32767)) for x in samples))
out.close()
