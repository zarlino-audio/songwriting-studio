"""
Feature extraction — the DSP that turns a beat into a Beat Profile (spec §5).

Everything here is numpy/scipy on a 22.05 kHz mono signal:

  tempo + beat grid   spectral-flux onset envelope -> autocorrelation -> comb scoring
  downbeats           bass-energy phase selection over beats
  key                 harmonic-weighted chroma vs Krumhansl-Schmuckler profiles
  chords              triad template matching per beat + run-length smoothing
  sections            per-bar features -> self-similarity -> checkerboard novelty peaks
  energy              per-bar RMS, normalised to 0..1
  loudness            ITU-R BS.1770 K-weighting + gating (approximate implementation)
  waveform            min/max peaks for the editor's timeline

These are estimates and say so in `warnings`; the artist can correct every field.
"""

from __future__ import annotations

import math
from datetime import datetime, timezone

import numpy as np
from scipy.signal import lfilter

from .io import Audio

ENGINE = "zarlino-analysis"
ENGINE_VERSION = "0.1.0"

FRAME = 2048
HOP = 512
CHROMA_LOW_HZ = 65.0
CHROMA_HIGH_HZ = 2100.0
WAVEFORM_BUCKETS = 900

PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Krumhansl-Kessler key profiles
MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


# ---------------------------------------------------------------------------
# Frames / spectra
# ---------------------------------------------------------------------------
def stft_magnitude(mono: np.ndarray, frame: int = FRAME, hop: int = HOP) -> tuple[np.ndarray, np.ndarray]:
    """Return (magnitude spectrogram, frequencies) with a Hann window."""
    if mono.size < frame:
        mono = np.pad(mono, (0, frame - mono.size))

    n_frames = 1 + (mono.size - frame) // hop
    window = np.hanning(frame).astype(np.float32)
    # Strided framing without copying the whole signal repeatedly.
    frames = np.lib.stride_tricks.sliding_window_view(mono, frame)[::hop][:n_frames]
    spectrum = np.fft.rfft(frames * window, axis=1)
    magnitude = np.abs(spectrum).astype(np.float32)
    freqs = np.fft.rfftfreq(frame, d=1.0 / 22050.0).astype(np.float32)
    return magnitude, freqs


def frame_times(n_frames: int, hop: int = HOP, sr: int = 22050) -> np.ndarray:
    return (np.arange(n_frames) * hop + (FRAME / 2.0)) / sr


# ---------------------------------------------------------------------------
# Onsets, tempo, beats
# ---------------------------------------------------------------------------
def onset_envelope(magnitude: np.ndarray) -> np.ndarray:
    """Half-wave rectified log-magnitude spectral flux, mean-removed."""
    log_spec = np.log1p(magnitude * 100.0)
    flux = np.diff(log_spec, axis=0)
    flux = np.maximum(flux, 0.0).sum(axis=1)
    flux = np.concatenate([[0.0], flux])
    if flux.size > 8:
        kernel = np.ones(3, dtype=np.float32) / 3.0
        flux = np.convolve(flux, kernel, mode="same")
    return flux - float(np.mean(flux))


def estimate_tempo(onset: np.ndarray, sr: int = 22050, hop: int = HOP, min_bpm: float = 55.0, max_bpm: float = 190.0) -> tuple[float, float, float]:
    """Autocorrelation tempo estimate with comb scoring.

    Returns (bpm, confidence, beat_period_seconds).
    """
    if onset.size < 32:
        return 120.0, 0.1, 0.5

    env = onset.astype(np.float64)
    env = env - env.mean()
    frame_rate = sr / hop

    n = int(2 ** math.ceil(math.log2(env.size * 2)))
    spectrum = np.fft.rfft(env, n=n)
    autocorr = np.fft.irfft(spectrum * np.conj(spectrum), n=n)[: env.size]
    if autocorr[0] != 0:
        autocorr = autocorr / autocorr[0]

    lag_min = int(frame_rate * 60.0 / max_bpm)
    lag_max = min(int(frame_rate * 60.0 / min_bpm), autocorr.size - 1)
    if lag_max <= lag_min:
        return 120.0, 0.1, 0.5

    lags = np.arange(lag_min, lag_max + 1)
    scores = np.zeros_like(lags, dtype=np.float64)
    for index, lag in enumerate(lags):
        score = 0.0
        weight_sum = 0.0
        weight = 1.0
        for multiple in range(1, 5):
            harmonic_lag = lag * multiple
            if harmonic_lag >= autocorr.size:
                break
            score += weight * float(autocorr[harmonic_lag])
            weight_sum += weight
            weight *= 0.5
        scores[index] = score / max(weight_sum, 1e-9)

    best = int(np.argmax(scores))
    best_lag = float(lags[best])
    peak = float(scores[best])
    mean_score = float(np.mean(scores))
    std_score = float(np.std(scores)) + 1e-9
    confidence = float(np.clip((peak - mean_score) / (3.0 * std_score), 0.05, 0.99))

    bpm = 60.0 * frame_rate / best_lag
    # Prefer the conventional range: fold half/double tempo into 70..180.
    while bpm < 70.0:
        bpm *= 2.0
    while bpm > 180.0:
        bpm /= 2.0
    period = 60.0 / bpm
    return float(round(bpm, 2)), confidence, period


def beat_grid(onset: np.ndarray, period_frames: float, sr: int = 22050, hop: int = HOP) -> np.ndarray:
    """Choose the phase that best explains the onset envelope, then refine."""
    if onset.size < 8 or period_frames <= 1:
        return np.array([])

    env = np.maximum(onset, 0.0)
    best_phase = 0.0
    best_score = -1.0
    # 40 phase candidates across one beat period is plenty at this resolution.
    for phase in np.linspace(0, period_frames, 40, endpoint=False):
        positions = np.arange(phase, env.size - 1, period_frames)
        idx = positions.astype(int)
        idx = idx[(idx >= 0) & (idx < env.size)]
        if idx.size < 4:
            continue
        score = float(np.sum(env[idx]))
        if score > best_score:
            best_score = score
            best_phase = float(phase)

    beats: list[float] = []
    tolerance = max(2, int(period_frames * 0.18))
    for beat_index in range(int(1e6)):
        expected = best_phase + beat_index * period_frames
        if expected > env.size - 1:
            break
        lo = max(0, int(expected - tolerance))
        hi = min(env.size, int(expected + tolerance) + 1)
        if hi <= lo:
            beats.append(expected)
            continue
        local = env[lo:hi]
        offset = int(np.argmax(local))
        beats.append(float(lo + offset))

    return np.array(beats) * hop / sr


def downbeats_from_bass(low_energy: np.ndarray, beat_times: np.ndarray, n_frames: int, hop: int = HOP, sr: int = 22050, beats_per_bar: int = 4) -> np.ndarray:
    """Pick the bar phase whose beat carries the most low-frequency energy."""
    if beat_times.size < beats_per_bar * 2:
        return beat_times[::beats_per_bar]

    env = low_energy
    if env.size < n_frames:
        env = np.pad(env, (0, n_frames - env.size))

    beat_idx = np.clip((beat_times * sr / hop).astype(int), 0, env.size - 1)
    best_phase = 0
    best_score = -1.0
    for phase in range(beats_per_bar):
        positions = beat_idx[phase::beats_per_bar]
        if positions.size == 0:
            continue
        score = float(np.mean(env[positions]))
        if score > best_score:
            best_score = score
            best_phase = phase
    return beat_times[best_phase::beats_per_bar]


# ---------------------------------------------------------------------------
# Chroma, key, chords
# ---------------------------------------------------------------------------
def chromagram(magnitude: np.ndarray, freqs: np.ndarray) -> np.ndarray:
    """Harmonic-folded chroma per frame, L2-normalised per frame.

    Each spectral bin contributes to the pitch class of its *fundamental*, not
    just its own frequency: a bin at the 3rd harmonic of X votes for X. This is
    what keeps a chord with strong upper harmonics from being misread as a
    different triad.
    """
    mask = (freqs >= CHROMA_LOW_HZ) & (freqs <= CHROMA_HIGH_HZ)
    selected = magnitude[:, mask]
    selected_freqs = freqs[mask]
    if selected.size == 0:
        return np.zeros((magnitude.shape[0], 12), dtype=np.float32)

    # Compress dynamics so quiet upper harmonics still contribute.
    energy = np.log1p(selected * 50.0)
    with np.errstate(divide="ignore", invalid="ignore"):
        midi = 69.0 + 12.0 * np.log2(np.maximum(selected_freqs, 1e-6) / 440.0)

    chroma = np.zeros((magnitude.shape[0], 12), dtype=np.float32)
    # Harmonics 1..5 with a decaying weight; 2 and 4 are octaves (same class).
    # NB: pitch is logarithmic — the fundamental of a bin at h×f is
    # midi(f) - 12*log2(h), NOT midi(f)/h.
    harmonic_weights = {1: 1.0, 2: 0.5, 3: 0.35, 4: 0.2, 5: 0.12}
    for harmonic, weight in harmonic_weights.items():
        fundamental_midi = midi - 12.0 * math.log2(harmonic)
        pitch_class = np.mod(np.round(fundamental_midi).astype(int), 12)
        for pc in range(12):
            bins = pitch_class == pc
            if np.any(bins):
                chroma[:, pc] += (energy[:, bins] * weight).sum(axis=1)

    norms = np.linalg.norm(chroma, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return chroma / norms


def estimate_key(chroma: np.ndarray) -> tuple[str, float, str]:
    """Krumhansl-Schmuckler correlation over 24 keys."""
    if chroma.size == 0:
        return "unknown", 0.0, ""
    profile = chroma.mean(axis=0)
    if float(np.sum(np.abs(profile))) == 0:
        return "unknown", 0.0, ""

    best = (-2.0, 0, "major")
    scores: list[float] = []
    for tonic in range(12):
        for mode, reference in (("major", MAJOR_PROFILE), ("minor", MINOR_PROFILE)):
            rotated = np.roll(reference, tonic)
            score = float(np.corrcoef(profile, rotated)[0, 1])
            scores.append(score)
            if score > best[0]:
                best = (score, tonic, mode)

    score, tonic, mode = best
    # Confidence from the margin over the runner-up.
    ordered = sorted(scores, reverse=True)
    margin = ordered[0] - ordered[1] if len(ordered) > 1 else 0.0
    confidence = float(np.clip(0.35 + margin * 2.5, 0.1, 0.98))
    scale = "major" if mode == "major" else "natural minor"
    return f"{PITCH_CLASSES[tonic]} {mode}", confidence, scale


TRIADS: list[tuple[str, tuple[int, int, int], str]] = [
    ("", (0, 4, 7), "major"),
    ("m", (0, 3, 7), "minor"),
    ("dim", (0, 3, 6), "dim"),
    ("sus4", (0, 5, 7), "sus"),
]


def detect_chords(chroma: np.ndarray, times: np.ndarray, beat_times: np.ndarray) -> list[dict]:
    """Per-beat triad template matching, smoothed and run-length encoded."""
    if chroma.shape[0] == 0 or beat_times.size < 2:
        return []

    # Beat-synchronous chroma (mean of the frames inside each beat).
    indices = np.clip(np.searchsorted(times, beat_times[:-1]), 0, chroma.shape[0] - 1)
    next_indices = np.clip(np.searchsorted(times, beat_times[1:]), 1, chroma.shape[0])
    beat_chroma = []
    for start, end in zip(indices, next_indices):
        if end <= start:
            end = min(start + 1, chroma.shape[0])
        beat_chroma.append(chroma[start:end].mean(axis=0))
    matrix = np.vstack(beat_chroma)

    labels: list[str] = []
    confidences: list[float] = []
    for row in matrix:
        best = (-1.0, "N.C.")
        candidates: list[float] = []
        for tonic in range(12):
            for suffix, intervals, kind in TRIADS:
                template = np.zeros(12, dtype=np.float32)
                for interval in intervals:
                    template[(tonic + interval) % 12] = 1.0
                template /= np.linalg.norm(template)
                score = float(np.dot(row, template))
                # Root support: a triad whose root is silent is almost never the
                # intended chord (this is what stops a lone A note winning Dsus4).
                score += 0.12 * float(row[tonic])
                if kind == "sus":
                    score -= 0.02
                candidates.append(score)
                if score > best[0]:
                    best = (score, f"{PITCH_CLASSES[tonic]}{suffix}")
        ordered = sorted(candidates, reverse=True)
        margin = ordered[0] - ordered[1] if len(ordered) > 1 else 0.0
        labels.append(best[1])
        confidences.append(float(np.clip(0.3 + margin * 2.0, 0.1, 0.95)))

    # Median-style smoothing over 3 beats removes single-beat flapping.
    smoothed = labels[:]
    for index in range(1, len(labels) - 1):
        if labels[index - 1] == labels[index + 1] != labels[index]:
            smoothed[index] = labels[index - 1]

    events: list[dict] = []
    for index, label in enumerate(smoothed):
        start = float(beat_times[index])
        end = float(beat_times[index + 1]) if index + 1 < beat_times.size else start + 0.5
        if events and events[-1]["chord"] == label:
            events[-1]["end"] = end
            events[-1]["confidence"] = float(np.mean([events[-1]["confidence"], confidences[index]]))
        else:
            events.append({"chord": label, "start": start, "end": end, "confidence": confidences[index]})
    return events


def harmonic_tension(chroma: np.ndarray, times: np.ndarray, bar_times: np.ndarray) -> list[float]:
    """Rough tension curve: spectral dissonance proxy per bar (0..1)."""
    if chroma.shape[0] == 0 or bar_times.size < 2:
        return []
    tension: list[float] = []
    for start, end in zip(bar_times[:-1], bar_times[1:]):
        lo = int(np.searchsorted(times, start))
        hi = int(np.searchsorted(times, end))
        if hi <= lo:
            tension.append(0.0)
            continue
        block = chroma[lo:hi].mean(axis=0)
        # Tension rises with the number of simultaneously active pitch classes
        # and with how evenly they are distributed (no clear tonal centre).
        active = float(np.count_nonzero(block > 0.25))
        entropy = 0.0
        distribution = block / max(float(np.sum(block)), 1e-9)
        for value in distribution:
            if value > 0:
                entropy -= float(value) * math.log(float(value))
        tension.append(float(np.clip(0.6 * (active / 12.0) + 0.4 * (entropy / math.log(12)), 0, 1)))
    return tension


# ---------------------------------------------------------------------------
# Loudness / dynamics
# ---------------------------------------------------------------------------
def _biquad_coeffs(kind: str, f0: float, q: float, sr: float, gain_db: float = 0.0) -> tuple[np.ndarray, np.ndarray]:
    """Bilinear-transform biquad design (used for the BS.1770 K-weighting filters)."""
    w0 = 2.0 * math.pi * f0 / sr
    cos_w0 = math.cos(w0)
    sin_w0 = math.sin(w0)
    alpha = sin_w0 / (2.0 * q)

    if kind == "highpass":
        b = np.array([(1 + cos_w0) / 2, -(1 + cos_w0), (1 + cos_w0) / 2])
        a = np.array([1 + alpha, -2 * cos_w0, 1 - alpha])
    elif kind == "highshelf":
        amplitude = 10 ** (gain_db / 40.0)
        beta = 2 * math.sqrt(amplitude) * alpha
        b = np.array(
            [
                amplitude * ((amplitude + 1) + (amplitude - 1) * cos_w0 + beta),
                -2 * amplitude * ((amplitude - 1) + (amplitude + 1) * cos_w0),
                amplitude * ((amplitude + 1) + (amplitude - 1) * cos_w0 - beta),
            ]
        )
        a = np.array(
            [
                (amplitude + 1) - (amplitude - 1) * cos_w0 + beta,
                2 * ((amplitude - 1) - (amplitude + 1) * cos_w0),
                (amplitude + 1) - (amplitude - 1) * cos_w0 - beta,
            ]
        )
    else:  # pragma: no cover - only the two kinds above are used
        raise ValueError(f"Unsupported filter kind: {kind}")

    return b / a[0], a / a[0]


def integrated_lufs(stereo: np.ndarray, sr: int) -> float:
    """Approximate integrated loudness (ITU-R BS.1770 gating, K-weighting)."""
    if stereo.size == 0:
        return -70.0

    shelf_b, shelf_a = _biquad_coeffs("highshelf", 1681.97, 0.7072, sr, gain_db=3.999)
    rlb_b, rlb_a = _biquad_coeffs("highpass", 38.0, 0.5, sr)

    filtered = np.empty_like(stereo, dtype=np.float64)
    for index in range(stereo.shape[0]):
        channel = lfilter(shelf_b, shelf_a, stereo[index].astype(np.float64))
        filtered[index] = lfilter(rlb_b, rlb_a, channel)

    block = max(int(0.4 * sr), 1)
    step = max(block // 4, 1)
    n_blocks = max((filtered.shape[1] - block) // step + 1, 1)

    loudness: list[float] = []
    for index in range(n_blocks):
        start = index * step
        segment = filtered[:, start : start + block]
        if segment.shape[1] == 0:
            continue
        mean_square = float(np.mean(np.sum(segment**2, axis=0)))
        if mean_square <= 0:
            continue
        loudness.append(-0.691 + 10.0 * math.log10(mean_square))

    if not loudness:
        return -70.0

    values = np.array(loudness)
    # Absolute gate at -70 LUFS, then relative gate 10 LU below the ungated mean.
    gated = values[values > -70.0]
    if gated.size == 0:
        return -70.0
    relative_threshold = float(np.mean(gated)) - 10.0
    gated = gated[gated > relative_threshold]
    if gated.size == 0:
        return float(round(float(np.mean(values)), 2))
    return float(round(float(-0.691 + 10.0 * math.log10(np.mean(10 ** ((gated + 0.691) / 10.0)))), 2))


def dynamic_range_db(mono: np.ndarray, sr: int) -> float:
    block = max(int(0.3 * sr), 1)
    n_blocks = max(mono.size // block, 1)
    rms_values = []
    for index in range(n_blocks):
        segment = mono[index * block : (index + 1) * block]
        rms = float(np.sqrt(np.mean(segment**2)))
        if rms > 1e-6:
            rms_values.append(20 * math.log10(rms))
    if len(rms_values) < 4:
        return 0.0
    values = np.array(rms_values)
    return float(round(float(np.percentile(values, 95) - np.percentile(values, 10)), 2))


# ---------------------------------------------------------------------------
# Energy, sections, waveform
# ---------------------------------------------------------------------------
def bar_times_from_beats(downbeats: np.ndarray, duration: float) -> np.ndarray:
    if downbeats.size >= 2:
        times = list(downbeats)
        if times[-1] < duration:
            times.append(duration)
        return np.array(times)
    if downbeats.size == 1:
        return np.array([float(downbeats[0]), duration])
    return np.array([0.0, duration])


def bar_energy(mono: np.ndarray, bar_starts: np.ndarray, sr: int) -> np.ndarray:
    energies = []
    for index in range(len(bar_starts) - 1):
        start = int(max(bar_starts[index], 0) * sr)
        end = int(max(bar_starts[index + 1], 0) * sr)
        if end <= start:
            energies.append(0.0)
            continue
        segment = mono[start:end]
        energies.append(float(np.sqrt(np.mean(segment**2))) if segment.size else 0.0)
    values = np.array(energies)
    if values.size == 0:
        return values
    # Normalise against a high percentile so one loud drop does not flatten the curve.
    ceiling = float(np.percentile(values, 97)) or float(np.max(values)) or 1.0
    normalised = np.clip(values / ceiling, 0.0, 1.0)
    if normalised.size >= 3:
        kernel = np.array([0.25, 0.5, 0.25])
        normalised = np.convolve(normalised, kernel, mode="same")
    return normalised


def bar_features(chroma: np.ndarray, times: np.ndarray, magnitude: np.ndarray, freqs: np.ndarray, bar_starts: np.ndarray, energy: np.ndarray) -> np.ndarray:
    """Per-bar feature matrix used for the self-similarity section analysis."""
    band_edges = [(0, 120), (120, 400), (400, 1200), (1200, 4000), (4000, 11025)]
    rows: list[np.ndarray] = []
    for index in range(len(bar_starts) - 1):
        lo = int(np.searchsorted(times, bar_starts[index]))
        hi = int(np.searchsorted(times, bar_starts[index + 1]))
        if hi <= lo:
            hi = min(lo + 1, times.size)
        chroma_block = chroma[lo:hi].mean(axis=0) if hi > lo else np.zeros(12)
        spectrum_block = magnitude[lo:hi].mean(axis=0) if hi > lo else np.zeros(magnitude.shape[1])
        bands = []
        for low, high in band_edges:
            mask = (freqs >= low) & (freqs < high)
            bands.append(float(np.log1p(spectrum_block[mask].sum())) if np.any(mask) else 0.0)
        bands_array = np.array(bands)
        if float(np.sum(bands_array)) > 0:
            bands_array = bands_array / float(np.sum(bands_array))
        rows.append(np.concatenate([chroma_block, bands_array, [float(energy[index]) if index < energy.size else 0.0]]))
    matrix = np.vstack(rows) if rows else np.zeros((1, 18))
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return matrix / norms


def detect_sections(features: np.ndarray, energy: np.ndarray, bar_starts: np.ndarray, bpm_confidence: float) -> list[dict]:
    """Self-similarity + checkerboard novelty segmentation."""
    n_bars = features.shape[0]
    if n_bars < 8:
        return [
            {
                "type": "instrumental",
                "start": float(bar_starts[0]),
                "end": float(bar_starts[-1]) if len(bar_starts) else 0.0,
                "energy": float(np.mean(energy)) if energy.size else 0.5,
                "confidence": 0.2,
                "bars": [0, n_bars],
            }
        ]

    similarity = features @ features.T
    size = max(2, min(8, n_bars // 4))
    kernel = np.zeros((2 * size, 2 * size), dtype=np.float32)
    for i in range(2 * size):
        for j in range(2 * size):
            sign = 1.0 if (i < size) == (j < size) else -1.0
            kernel[i, j] = sign
    novelty = np.zeros(n_bars, dtype=np.float32)
    for index in range(n_bars):
        lo = index - size
        hi = index + size
        window = np.zeros((2 * size, 2 * size), dtype=np.float32)
        for i in range(2 * size):
            for j in range(2 * size):
                source_i, source_j = lo + i, lo + j
                if 0 <= source_i < n_bars and 0 <= source_j < n_bars:
                    window[i, j] = similarity[source_i, source_j]
        novelty[index] = float(np.sum(window * kernel))

    novelty = novelty - float(np.mean(novelty))
    std = float(np.std(novelty)) or 1.0
    novelty = novelty / std

    min_gap = max(4, n_bars // 12)
    boundaries = [0]
    for index in range(1, n_bars - 1):
        if novelty[index] < 0.8:
            continue
        if novelty[index] < novelty[index - 1] or novelty[index] < novelty[index + 1]:
            continue
        if index - boundaries[-1] < min_gap:
            continue
        boundaries.append(index)
    if n_bars - boundaries[-1] < min_gap and len(boundaries) > 1:
        boundaries.pop()
    boundaries.append(n_bars)

    raw_segments = [
        {
            "bar_start": boundaries[i],
            "bar_end": boundaries[i + 1],
            "energy": float(np.mean(energy[boundaries[i] : boundaries[i + 1]])) if energy.size else 0.5,
        }
        for i in range(len(boundaries) - 1)
    ]

    # Heuristic labelling: structure the listener would recognise, never forced.
    overall = float(np.mean(energy)) if energy.size else 0.5
    energies = [segment["energy"] for segment in raw_segments]
    median = float(np.median(energies)) if energies else overall
    loudest = max(range(len(raw_segments)), key=lambda i: raw_segments[i]["energy"]) if raw_segments else 0

    for index, segment in enumerate(raw_segments):
        if index == 0 and segment["energy"] <= median and segment["bar_end"] - segment["bar_start"] >= 4:
            segment["type"] = "intro"
        elif index == len(raw_segments) - 1 and segment["energy"] <= median:
            segment["type"] = "outro"
        elif index == loudest and len(raw_segments) > 2:
            segment["type"] = "chorus"
        elif index > 0 and segment["energy"] > raw_segments[index - 1]["energy"] and segment["bar_end"] - segment["bar_start"] <= 8:
            segment["type"] = "pre-chorus"
        elif segment["energy"] >= median:
            segment["type"] = "chorus"
        else:
            segment["type"] = "verse"

    # Two adjacent identical labels: keep them separate but numbered for the artist.
    sections: list[dict] = []
    counts: dict[str, int] = {}
    for index, segment in enumerate(raw_segments):
        kind = segment["type"]
        counts[kind] = counts.get(kind, 0) + 1
        confidence = float(np.clip(0.25 + 0.45 * bpm_confidence, 0.2, 0.75))
        sections.append(
            {
                "type": kind,
                "label": f"{kind.capitalize()} {counts[kind]}" if counts[kind] > 1 or kind in ("verse", "chorus") else kind.capitalize(),
                "start": float(bar_starts[segment["bar_start"]]),
                "end": float(bar_starts[segment["bar_end"]]),
                "energy": float(np.clip(segment["energy"], 0, 1)),
                "confidence": confidence,
                "bars": [int(segment["bar_start"]), int(segment["bar_end"])],
                "_index": index,
            }
        )
    for section in sections:
        section.pop("_index", None)
    return sections


def waveform_peaks(mono: np.ndarray, buckets: int = WAVEFORM_BUCKETS) -> list[dict]:
    if mono.size == 0:
        return []
    buckets = max(1, min(buckets, mono.size))
    edges = np.linspace(0, mono.size, buckets + 1).astype(int)
    peaks: list[dict] = []
    for index in range(buckets):
        start, end = edges[index], edges[index + 1]
        if end <= start:
            peaks.append({"min": 0.0, "max": 0.0})
            continue
        segment = mono[start:end]
        peaks.append({"min": round(float(np.min(segment)), 4), "max": round(float(np.max(segment)), 4)})
    return peaks


def silence_regions(mono: np.ndarray, sr: int, threshold_db: float = -50.0, min_seconds: float = 0.4) -> list[dict]:
    if mono.size == 0:
        return []
    block = max(int(0.1 * sr), 1)
    n_blocks = mono.size // block
    if n_blocks < 2:
        return []
    reshaped = mono[: n_blocks * block].reshape(n_blocks, block)
    rms = np.sqrt(np.mean(reshaped**2, axis=1))
    threshold = 10 ** (threshold_db / 20.0)
    quiet = rms < threshold

    regions: list[dict] = []
    start_index: int | None = None
    for index, is_quiet in enumerate(quiet):
        if is_quiet and start_index is None:
            start_index = index
        elif not is_quiet and start_index is not None:
            if (index - start_index) * 0.1 >= min_seconds:
                regions.append({"start": round(start_index * 0.1, 3), "end": round(index * 0.1, 3)})
            start_index = None
    if start_index is not None and (len(quiet) - start_index) * 0.1 >= min_seconds:
        regions.append({"start": round(start_index * 0.1, 3), "end": round(len(quiet) * 0.1, 3)})
    return regions


def rhythm_stats(onset: np.ndarray, beat_times: np.ndarray, bpm: float, sr: int = 22050, hop: int = HOP) -> dict:
    frame_rate = sr / hop
    peaks = np.where((onset[1:-1] > onset[:-2]) & (onset[1:-1] >= onset[2:]) & (onset[1:-1] > 0.35 * float(np.std(onset) + 1e-9)))[0] + 1
    onsets_per_second = float(peaks.size / max(onset.size / frame_rate, 1e-9))

    if beat_times.size >= 2:
        period = np.median(np.diff(beat_times))
    else:
        period = 60.0 / max(bpm, 1.0)

    # Syncopation: share of onset energy that does not sit near a beat.
    onset_times = peaks / frame_rate
    grid = np.arange(0.0, max(float(onset_times[-1]) if onset_times.size else 0.0, 1.0), period / 2.0)
    off_beat = 0
    for time in onset_times:
        if grid.size == 0:
            break
        nearest_beat_distance = float(np.min(np.abs(grid[::2] - time)))
        nearest_half_distance = float(np.min(np.abs(grid[1::2] - time)))
        if nearest_half_distance < nearest_beat_distance:
            off_beat += 1
    syncopation = float(np.clip(off_beat / max(onset_times.size, 1), 0.0, 1.0))

    # Swing: how uneven alternating inter-onset intervals are.
    swing = 0.0
    if onset_times.size >= 4:
        intervals = np.diff(onset_times)
        pairs = intervals[: (intervals.size // 2) * 2].reshape(-1, 2)
        if pairs.size:
            ratios = pairs[:, 1] / np.maximum(pairs[:, 0], 1e-6)
            ratios = ratios[(ratios > 0.2) & (ratios < 5.0)]
            if ratios.size:
                swing = float(np.clip(np.abs(np.median(ratios) - 1.0), 0.0, 0.6))

    density = float(np.clip(onsets_per_second / 6.0, 0.0, 1.0))
    complexity = float(np.clip(0.5 * density + 0.5 * syncopation, 0.0, 1.0))
    groove = "straight" if swing < 0.08 else ("swung" if swing < 0.25 else "heavily swung")
    return {
        "density": density,
        "syncopation": syncopation,
        "swing": swing,
        "groove": groove,
        "transient_density": round(onsets_per_second, 2),
        "complexity": complexity,
    }


def mood_tags(bpm: float, key: str, energy: float, density: float, syncopation: float) -> list[str]:
    minor = "minor" in key
    moods: list[str] = []
    if minor and energy < 0.5:
        moods.append("melancholic")
    if minor and energy >= 0.5:
        moods.extend(["tense", "confident"])
    if not minor and energy >= 0.65:
        moods.extend(["celebratory", "uplifting"])
    if not minor and energy < 0.5:
        moods.append("warm")
    if syncopation >= 0.5:
        moods.append("loose")
    if density >= 0.7:
        moods.append("aggressive")
    if density < 0.5 and energy < 0.55:
        moods.append("late-night")
    if bpm >= 120 and energy >= 0.6:
        moods.append("high-energy")
    if not moods:
        moods.append("steady")
    seen: list[str] = []
    for mood in moods:
        if mood not in seen:
            seen.append(mood)
    return seen[:4]


def analyse(audio: Audio, beats_per_bar: int = 4) -> dict:
    mono = audio.mono
    sr = audio.analysis_rate
    warnings: list[str] = []

    magnitude, freqs = stft_magnitude(mono)
    times = frame_times(magnitude.shape[0])
    onset = onset_envelope(magnitude)

    bpm, bpm_confidence, period = estimate_tempo(onset)
    if bpm_confidence < 0.2:
        warnings.append("Tempo confidence is low — the beat may be free-time or heavily syncopated.")

    beat_times = beat_grid(onset, period * sr / HOP)
    low_mask = (freqs >= 30) & (freqs <= 160)
    low_energy = magnitude[:, low_mask].sum(axis=1) if np.any(low_mask) else np.zeros(magnitude.shape[0], dtype=np.float32)
    downbeats = downbeats_from_bass(low_energy, beat_times, magnitude.shape[0], beats_per_bar=beats_per_bar)

    chroma = chromagram(magnitude, freqs)
    key, key_confidence, scale = estimate_key(chroma)
    if key_confidence < 0.3:
        warnings.append("Key confidence is low — check the detected key before relying on it.")

    chords = detect_chords(chroma, times, beat_times)
    progression: list[str] = []
    for event in chords:
        if not progression or progression[-1] != event["chord"]:
            progression.append(event["chord"])

    duration = float(mono.size / sr)
    bars = bar_times_from_beats(downbeats, duration)
    energy_curve = bar_energy(mono, bars, sr)
    tension = harmonic_tension(chroma, times, bars)
    features = bar_features(chroma, times, magnitude, freqs, bars, energy_curve)
    sections = detect_sections(features, energy_curve, bars, bpm_confidence)

    by_section: dict[str, float] = {}
    for section in sections:
        kind = str(section["type"])
        by_section[kind] = float(round(section["energy"], 3)) if kind not in by_section else by_section[kind]

    peak = float(np.max(np.abs(mono))) if mono.size else 0.0
    lufs = integrated_lufs(audio.stereo, sr)
    rhythm = rhythm_stats(onset, beat_times, bpm)
    overall_energy = float(np.mean(energy_curve)) if energy_curve.size else 0.5

    if audio.duration < 8:
        warnings.append("Beat is shorter than 8 seconds — analysis confidence is limited.")

    return {
        "version": 1,
        "engine": ENGINE,
        "engine_version": ENGINE_VERSION,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "bpm": float(round(bpm, 2)),
        "bpm_confidence": float(round(bpm_confidence, 3)),
        "key": key,
        "key_confidence": float(round(key_confidence, 3)),
        "scale": scale,
        "time_signature": f"{beats_per_bar}/4",
        "duration_seconds": float(round(duration, 3)),
        "energy": {
            "overall": float(round(overall_energy, 3)),
            "curve": [float(round(float(value), 3)) for value in energy_curve],
            "by_section": by_section,
        },
        "mood": mood_tags(bpm, key, overall_energy, rhythm["density"], rhythm["syncopation"]),
        "rhythm": {
            **rhythm,
            "beat_grid": [float(round(float(value), 3)) for value in beat_times],
            "downbeats": [float(round(float(value), 3)) for value in downbeats],
            "beats_per_bar": beats_per_bar,
            "bar_count": max(len(bars) - 1, 0),
        },
        "harmony": {
            "chords": chords,
            "progression": progression,
            "harmonic_tension": [float(round(float(value), 3)) for value in tension],
        },
        "sections": sections,
        "technical": {
            "sample_rate": int(audio.sample_rate),
            "channels": int(audio.channels),
            "lufs": lufs,
            "peak_db": float(round(20.0 * math.log10(max(peak, 1e-6)), 2)),
            "dynamic_range_db": dynamic_range_db(mono, sr),
            "waveform": waveform_peaks(mono),
            "silence_regions": silence_regions(mono, sr),
        },
        "warnings": warnings,
    }
