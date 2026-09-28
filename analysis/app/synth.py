"""Synthetic beats with known ground truth.

Shared by the probe (``python -m app.probe``) and the test suite: one generator,
so a change in one place cannot quietly make the other's numbers meaningless.

The renderer is deliberately simple but *not* trivial — it puts an untuned kick
(55 Hz, i.e. A1, on beats 1 and 3), a snare, hats, a root bass and pad chords in
the mix, which is exactly the combination that used to flip a minor beat to its
relative major.
"""

from __future__ import annotations

import numpy as np

from .analysis.io import Audio

SR = 22050

NOTE = {
    "C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5, "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11,
}

CHORDS: dict[str, list[int]] = {
    "Fm": [5, 8, 0],      # F Ab C
    "F": [5, 9, 0],       # F A C
    "Am": [9, 0, 4],      # A C E
    "Cm": [0, 3, 7],      # C Eb G
    "C": [0, 4, 7],       # C E G
    "Bb": [10, 2, 5],     # Bb D F
    "A#": [10, 2, 5],     # Bb D F
    "D#": [3, 7, 10],     # Eb G Bb
    "G#": [8, 0, 3],      # Ab C Eb
    "G": [7, 11, 2],      # G B D
    "Gm": [7, 10, 2],     # G Bb D
    "Dm": [2, 5, 9],      # D F A
    "E": [4, 8, 11],      # E G# B
}

KICK_HZ = 55.0  # A1 — deliberately *not* the key of most test beats


def frequency(pitch_class: int, octave: int = 3) -> float:
    midi = 12 * (octave + 1) + pitch_class
    return float(440.0 * 2 ** ((midi - 69) / 12.0))


def make_audio(mono: np.ndarray, channels: int = 1) -> Audio:
    mono = mono.astype(np.float32)
    return Audio(
        mono=mono,
        stereo=mono.reshape(1, -1),
        sample_rate=SR,
        channels=channels,
        duration=float(mono.size / SR),
    )


def render(
    bpm: float,
    progression: list[str],
    root: str,
    bars: int = 16,
    hat_pattern: bool = True,
    kick_hz: float = KICK_HZ,
) -> Audio:
    """A simple but realistic beat: kick on 1 and 3, snare on 2 and 4, hats, a root bass and pad chords."""
    beat_seconds = 60.0 / bpm
    bar_seconds = beat_seconds * 4
    total = int(bar_seconds * bars * SR) + SR
    signal = np.zeros(total, dtype=np.float32)

    def add(start_seconds: float, duration: float, freqs: list[float], amplitude: float, decay: float) -> None:
        start = int(start_seconds * SR)
        length = int(duration * SR)
        if start >= total or length <= 0:
            return
        t = np.arange(length) / SR
        envelope = np.exp(-decay * t)
        block = np.zeros(length, dtype=np.float32)
        for f in freqs:
            block += (amplitude * np.sin(2 * np.pi * f * t)).astype(np.float32)
        end = min(start + length, total)
        signal[start:end] += block[: end - start]

    def add_click(start_seconds: float, frequency_hz: float, amplitude: float, decay: float) -> None:
        add(start_seconds, 0.09, [frequency_hz], amplitude, decay)

    for bar in range(bars):
        bar_start = bar * bar_seconds
        chord = CHORDS[progression[bar % len(progression)]]
        # Kick on beats 1 and 3
        for beat in (0, 2):
            add_click(bar_start + beat * beat_seconds, kick_hz, 0.55, 12.0)
        # Snare on beats 2 and 4
        for beat in (1, 3):
            add(bar_start + beat * beat_seconds, 0.12, [180.0], 0.16, 25.0)
        if hat_pattern:
            for eighth in range(8):
                add_click(bar_start + eighth * beat_seconds / 2, 7000.0, 0.05, 60.0)
        # Bass: the chord root, one note per beat
        for beat in range(4):
            add(bar_start + beat * beat_seconds, beat_seconds * 0.85, [frequency(NOTE[root], 2)], 0.5, 3.0)
        # Pad chord
        for pitch_class in chord:
            add(bar_start, bar_seconds * 0.95, [frequency(pitch_class, 3)], 0.12, 1.2)

    mono = signal / max(float(np.max(np.abs(signal))), 1e-9) * 0.8
    return make_audio(mono, channels=1)
