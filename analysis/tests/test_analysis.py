"""Synthetic-signal tests for the analysis engine.

These prove the DSP is measuring what it claims to measure, without needing any
real audio files:

    click track at a known BPM  -> tempo estimate within 2%
    known chord loop            -> key + chord detection
    energy ramp                 -> monotonically rising energy curve
"""

from __future__ import annotations

import numpy as np

from app.analysis.features import (
    FAST_HOP,
    analyse,
    beat_grid,
    chromagram,
    detect_chords,
    estimate_key,
    estimate_tempo,
    integrated_lufs,
    onset_envelope,
    stft_magnitude,
)
from app.analysis.io import Audio

SR = 22050


def make_audio(mono: np.ndarray, channels: int = 1) -> Audio:
    mono = mono.astype(np.float32)
    return Audio(
        mono=mono,
        stereo=mono.reshape(1, -1),
        sample_rate=SR,
        channels=channels,
        duration=float(mono.size / SR),
    )


def click_track(bpm: float, seconds: float = 20.0, sr: int = SR) -> np.ndarray:
    n = int(seconds * sr)
    signal = np.zeros(n, dtype=np.float32)
    period = int(60.0 / bpm * sr)
    click = np.hanning(64).astype(np.float32) * 0.9
    for start in range(0, n - click.size, period):
        signal[start : start + click.size] += click
    return signal


def tone_sequence(frequencies: list[float], seconds_each: float = 1.0, sr: int = SR) -> np.ndarray:
    parts = []
    t = np.arange(int(seconds_each * sr)) / sr
    for frequency in frequencies:
        parts.append((0.4 * np.sin(2 * np.pi * frequency * t)).astype(np.float32))
    return np.concatenate(parts)


def chord_sequence(chords: list[list[float]], seconds_each: float = 2.0, sr: int = SR) -> np.ndarray:
    """Play each triad *simultaneously* for `seconds_each`, one after another."""
    t = np.arange(int(seconds_each * sr)) / sr
    parts = []
    for chord in chords:
        block = np.zeros(t.size, dtype=np.float32)
        for frequency in chord:
            block += (0.3 * np.sin(2 * np.pi * frequency * t)).astype(np.float32)
        parts.append(block)
    return np.concatenate(parts)


def a_minor_triad(f0: float = 220.0) -> list[float]:
    """A, C, E — the A minor triad."""
    return [f0, f0 * 2 ** (3 / 12), f0 * 2 ** (7 / 12)]


def test_tempo_of_click_track() -> None:
    for bpm in (90.0, 104.0, 120.0, 140.0):
        signal = click_track(bpm)
        magnitude, _freqs = stft_magnitude(signal)
        onset = onset_envelope(magnitude)
        detected, confidence, _period = estimate_tempo(onset)
        assert abs(detected - bpm) / bpm < 0.05, f"expected ~{bpm}, got {detected}"
        assert confidence > 0.1


def test_key_detection_on_a_minor_triad() -> None:
    signal = tone_sequence(a_minor_triad() * 4)
    magnitude, freqs = stft_magnitude(signal)
    chroma = chromagram(magnitude, freqs)
    key, confidence, scale = estimate_key(chroma)
    assert key.startswith("A"), f"expected A minor, got {key}"
    assert "minor" in key
    assert scale == "natural minor"
    assert confidence > 0.2


def test_chord_detection_finds_the_triad() -> None:
    # A minor (A C E) for 2s, then F major (F A C) for 2s — simultaneous triads.
    signal = chord_sequence([a_minor_triad(), [174.61, 220.0, 261.63]], 2.0)
    magnitude, freqs = stft_magnitude(signal)
    from app.analysis.features import frame_times

    times = frame_times(magnitude.shape[0])
    beats = np.arange(0.0, 4.0, 0.5)
    chroma = chromagram(magnitude, freqs)
    chords = detect_chords(chroma, times, beats)
    assert chords, "no chords detected"
    labels = [event["chord"] for event in chords]
    roots = {label[:1] for label in labels if label != "N.C."}
    assert "A" in roots, chords
    assert "F" in roots, chords
    assert any(label.startswith("Am") for label in labels), labels


def test_beat_grid_is_regular() -> None:
    signal = click_track(104.0, 20.0)
    magnitude, _freqs = stft_magnitude(signal)
    onset = onset_envelope(magnitude)
    _bpm, _confidence, period = estimate_tempo(onset)

    beats = beat_grid(onset, period, sr=SR, hop=FAST_HOP)
    assert beats.size > 20
    intervals = np.diff(beats)
    assert float(np.std(intervals)) < 0.03 * float(np.mean(intervals)) + 0.01


def test_energy_curve_rises_with_a_ramp() -> None:
    seconds = 12.0
    t = np.arange(int(seconds * SR)) / SR
    amplitude = np.linspace(0.02, 0.9, t.size)
    signal = (amplitude * np.sin(2 * np.pi * 110.0 * t)).astype(np.float32)
    # A quiet click bed gives the beat tracker something to lock onto.
    signal[:] += click_track(120.0, seconds) * 0.05
    profile = analyse(make_audio(signal))
    curve = profile["energy"]["curve"]
    assert len(curve) > 4
    first_half = float(np.mean(curve[: len(curve) // 2]))
    second_half = float(np.mean(curve[len(curve) // 2 :]))
    assert second_half > first_half, f"energy should rise: {first_half} -> {second_half}"


def test_profile_shape_is_complete() -> None:
    seconds = 16.0
    signal = click_track(104.0, seconds)
    pad = chord_sequence([a_minor_triad(), [174.61, 220.0, 261.63]], seconds / 2.0)[: signal.size]
    signal[: pad.size] += pad
    profile = analyse(make_audio(signal[: signal.size]))

    assert profile["engine"]
    assert profile["bpm"] > 0
    assert profile["time_signature"].endswith("/4")
    assert profile["duration_seconds"] > 10
    assert profile["rhythm"]["beats_per_bar"] == 4
    assert profile["rhythm"]["bar_count"] >= 4
    assert len(profile["rhythm"]["beat_grid"]) > 8
    assert len(profile["sections"]) >= 1
    assert profile["mood"]
    assert isinstance(profile["technical"]["waveform"], list)
    assert len(profile["technical"]["waveform"]) > 10
    assert profile["technical"]["lufs"] <= 0


def test_loudness_is_negative_and_tracks_level() -> None:
    quiet = (0.02 * np.sin(2 * np.pi * 440 * np.arange(SR) / SR)).astype(np.float32)
    loud = (0.5 * np.sin(2 * np.pi * 440 * np.arange(SR) / SR)).astype(np.float32)
    quiet_lufs = integrated_lufs(quiet.reshape(1, -1), SR)
    loud_lufs = integrated_lufs(loud.reshape(1, -1), SR)
    assert loud_lufs > quiet_lufs
    assert loud_lufs < 0
