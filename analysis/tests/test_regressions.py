"""Regression tests for real-beat failures.

Every test here encodes a bug that actually reached a listener, so they are the
tests that matter most:

* a 5:4 subharmonic reported instead of the pulse (95 BPM beat read as 76),
* a minor beat reported as its relative major (F minor read as F major),
* an untuned kick voting on the key (a 55 Hz kick is A, whatever the bass plays),
* a tempo that is right at the start of the file and drifts by the end.

Ground truth comes from `app.synth`, the same generator the probe uses.
"""

from __future__ import annotations

import numpy as np
import pytest

from app.analysis.features import (
    analyse,
    bass_root_histogram,
    chromagram,
    estimate_key,
    stft_magnitude,
    sustained_mask,
)
from app.synth import render

# The beat that exposed the key bug: F minor, 94 BPM, chords Fm/Eb/Bb/Cm over an
# A1 (55 Hz) kick. Reported as "F major" before the chroma and root analysis were
# rebuilt.
FM_94 = (94.0, ["Fm", "D#", "A#", "Cm"], "F")
CM_76 = (76.0, ["Cm", "G#", "A#"], "C")


@pytest.mark.parametrize(
    "bpm,progression,root,expected",
    [
        (*FM_94, "F minor"),
        (*CM_76, "C minor"),
        (104.0, ["Am", "F", "C", "G"], "A", "A minor"),
        (140.0, ["Dm", "A#", "F", "C"], "D", "D minor"),
    ],
)
def test_minor_progressions_are_not_reported_as_relative_majors(
    bpm: float, progression: list[str], root: str, expected: str
) -> None:
    profile = analyse(render(bpm, progression, root))
    assert profile["key"] == expected, profile["key"]
    assert "minor" in profile["key"]


def test_major_progressions_stay_major() -> None:
    profile = analyse(render(94.0, ["F", "A#", "C"], "F"))
    assert profile["key"] == "F major", profile["key"]


def test_tempo_is_the_pulse_not_a_fifth_subharmonic() -> None:
    """A 95 BPM beat used to be reported as 76 BPM (a 5:4 subharmonic) with a jittery grid."""
    profile = analyse(render(95.0, ["Fm", "D#", "A#", "Cm"], "F"))
    assert abs(profile["bpm"] - 95.0) <= 1.0, profile["bpm"]

    grid = np.array(profile["rhythm"]["beat_grid"], dtype=float)
    intervals = np.diff(grid)
    assert float(np.std(intervals)) < 0.05 * float(np.mean(intervals))


@pytest.mark.parametrize("bpm", [94.0, 104.0, 140.0])
def test_tempo_is_accurate_to_half_a_bpm(bpm: float) -> None:
    profile = analyse(render(bpm, ["Am", "F", "C", "G"], "A"))
    assert abs(profile["bpm"] - bpm) <= 0.5, f"expected {bpm}, got {profile['bpm']}"


def test_beat_grid_does_not_drift_over_the_file() -> None:
    """The grid must still line up with the last bar, not just the first."""
    profile = analyse(render(94.0, ["Fm", "D#", "A#", "Cm"], "F", bars=24))
    grid = np.array(profile["rhythm"]["beat_grid"], dtype=float)
    assert grid.size > 60
    implied_bpm = 60.0 * (grid.size - 1) / (grid[-1] - grid[0])
    assert abs(implied_bpm - profile["bpm"]) <= 0.05


def test_untuned_kick_does_not_vote_on_the_key() -> None:
    """The kick is A1 (55 Hz) on a beat whose bass is F — the root histogram must stay on F."""
    audio = render(FM_94[0], FM_94[1], FM_94[2])
    magnitude, freqs = stft_magnitude(audio.mono, 8192, 2048, audio.analysis_rate)
    sustained = sustained_mask(magnitude, freqs, hop=2048, sr=audio.analysis_rate)
    roots = bass_root_histogram(magnitude, freqs, sustained=sustained)
    assert float(roots[5]) > 0.6, f"F should dominate the roots, got {roots.round(3).tolist()}"
    assert float(roots[9]) < 0.15, f"A (the kick's pitch) should be suppressed, got {roots[9]:.3f}"


def test_a_pure_fifth_does_not_suggest_a_major_third() -> None:
    """Odd harmonics fold to the wrong pitch class: never let a fifth imply a third.

    F plus its own fifth (C) must not produce A, which is what told the analyser a
    minor beat was major.
    """
    sr = 22050
    t = np.arange(int(6.0 * sr)) / sr
    signal = (0.4 * np.sin(2 * np.pi * 174.61 * t) + 0.4 * np.sin(2 * np.pi * 261.63 * t)).astype(np.float32)
    magnitude, freqs = stft_magnitude(signal, 8192, 2048, sr)
    chroma = chromagram(magnitude, freqs)
    profile = chroma.mean(axis=0)
    assert profile.size == 12
    f_energy = float(profile[5])
    a_energy = float(profile[9])
    assert a_energy < 0.25 * f_energy, f"A should not appear over F+C: F={f_energy:.3f} A={a_energy:.3f}"

    # F and C together are genuinely ambiguous, but the answer must be built on one
    # of those two tonics rather than on a phantom pitch class.
    key, _confidence, _scale = estimate_key(chroma)
    assert key.split()[0] in ("F", "C"), key
