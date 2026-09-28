"""
Feature extraction — the DSP that turns a beat into a Beat Profile (spec §5).

Two analysis resolutions, because the two jobs need different trade-offs:

  fast  (2048-sample frames, hop 512)  onsets, tempo, beat grid, rhythm, energy
  fine  (8192-sample frames, hop 2048) chroma, bass chroma, bass roots, key

A 2048-point FFT has ~10.8 Hz bins, which cannot separate Ab (207.7 Hz) from A
(220 Hz) — so a minor pad leaked into the major-third bin and flipped the key to
its relative major. The fine pass has ~2.7 Hz bins and costs very little.

Everything here is an estimate and says so: weak results are recorded in
`warnings`, and the artist can correct every field.
"""

from __future__ import annotations

import math
from datetime import datetime, timezone

import numpy as np
from scipy.signal import lfilter

from .io import Audio

ENGINE = "zarlino-analysis"
ENGINE_VERSION = "0.4.0"

SR_ANALYSIS = 22050
FAST_FRAME = 2048
FAST_HOP = 512
FINE_FRAME = 8192
FINE_HOP = 2048

CHROMA_LOW_HZ = 65.0
CHROMA_HIGH_HZ = 1200.0
BASS_LOW_HZ = 40.0
BASS_HIGH_HZ = 250.0
WAVEFORM_BUCKETS = 900

# Tempo search space and the musical prior (log2-normal around a typical pulse).
TEMPO_MIN = 50.0
TEMPO_MAX = 200.0
TEMPO_PRIOR_CENTRE = 120.0
TEMPO_PRIOR_WIDTH = 0.85  # log2 units: ~ +/-80% at one sigma
TEMPO_RELATIONS = (1.0, 2.0, 0.5, 1.5, 2.0 / 3.0, 1.25, 0.8, 4.0 / 3.0, 0.75)

# Only fundamentals vote on the key.
#
# Odd harmonics shift the pitch class (a 3rd harmonic sounds a fifth above, a 5th
# harmonic a major third above). Folding them without *proving* the fundamental
# exists manufactures notes nobody played: in a beat whose chords were Fm/Eb/Bb/Cm,
# F's 5th harmonic read as A and G's 3rd read as D — which is exactly how a minor
# beat got reported as its relative major. A spectrum bin at frequency f therefore
# votes for the pitch class of f itself, and nothing else.

PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Krumhansl-Kessler key profiles
MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


# ---------------------------------------------------------------------------
# Frames / spectra
# ---------------------------------------------------------------------------
def stft_magnitude(
    mono: np.ndarray,
    frame: int = FAST_FRAME,
    hop: int = FAST_HOP,
    sr: int = SR_ANALYSIS,
) -> tuple[np.ndarray, np.ndarray]:
    """Return (magnitude spectrogram, frequencies) with a Hann window."""
    if mono.size < frame:
        mono = np.pad(mono, (0, frame - mono.size))

    n_frames = 1 + (mono.size - frame) // hop
    window = np.hanning(frame).astype(np.float32)
    frames = np.lib.stride_tricks.sliding_window_view(mono, frame)[::hop][:n_frames]
    spectrum = np.fft.rfft(frames * window, axis=1)
    magnitude = np.abs(spectrum).astype(np.float32)
    freqs = np.fft.rfftfreq(frame, d=1.0 / sr).astype(np.float32)
    return magnitude, freqs


def frame_times(n_frames: int, hop: int = FAST_HOP, frame: int = FAST_FRAME, sr: int = SR_ANALYSIS) -> np.ndarray:
    return (np.arange(n_frames) * hop + (frame / 2.0)) / sr


# ---------------------------------------------------------------------------
# Onsets / tempo
# ---------------------------------------------------------------------------
def _band_flux(magnitude: np.ndarray, freqs: np.ndarray, low: float, high: float, weight: float) -> np.ndarray | None:
    mask = (freqs >= low) & (freqs < high)
    if not np.any(mask):
        return None
    log_band = np.log1p(magnitude[:, mask] * 100.0)
    flux = np.maximum(np.diff(log_band, axis=0), 0.0).sum(axis=1)
    flux = np.concatenate([[0.0], flux])
    deviation = float(np.std(flux))
    if deviation > 0:
        # Per-band normalisation: a bright hat pattern must not hide the kick pulse.
        flux = flux / deviation
    return flux * weight


def onset_envelope(magnitude: np.ndarray, freqs: np.ndarray | None = None) -> np.ndarray:
    """Band-wise onset strength (low: kick, mid: snare/body, high: hats)."""
    if freqs is None:
        freqs = np.fft.rfftfreq(FAST_FRAME, d=1.0 / SR_ANALYSIS).astype(np.float32)

    total: np.ndarray | None = None
    for low, high, weight in ((40.0, 200.0, 1.15), (200.0, 2000.0, 1.0), (2000.0, 8000.0, 0.7)):
        flux = _band_flux(magnitude, freqs, low, high, weight)
        if flux is None:
            continue
        total = flux if total is None else total + flux

    if total is None:  # degenerate spectrum — fall back to broadband flux
        total = np.concatenate([[0.0], np.maximum(np.diff(np.log1p(magnitude * 100.0), axis=0), 0.0).sum(axis=1)])

    if total.size > 8:
        total = np.convolve(total, np.array([0.25, 0.5, 0.25]), mode="same")
    return total - float(np.mean(total))


def _autocorrelation(env: np.ndarray) -> np.ndarray:
    signal = env.astype(np.float64)
    signal = signal - signal.mean()
    n = int(2 ** math.ceil(math.log2(max(signal.size * 2, 4))))
    spectrum = np.fft.rfft(signal, n=n)
    autocorr = np.fft.irfft(spectrum * np.conj(spectrum), n=n)[: signal.size]
    if autocorr[0] != 0:
        autocorr = autocorr / autocorr[0]
    return autocorr


def tempo_candidates(onset: np.ndarray, sr: int = SR_ANALYSIS, hop: int = FAST_HOP) -> list[float]:
    """Candidate tempos: autocorrelation peaks plus their musical relatives."""
    frame_rate = sr / hop
    autocorr = _autocorrelation(onset)
    lag_min = max(int(frame_rate * 60.0 / TEMPO_MAX), 2)
    lag_max = min(int(frame_rate * 60.0 / TEMPO_MIN), autocorr.size - 1)
    if lag_max <= lag_min:
        return [120.0]

    lags = np.arange(lag_min, lag_max + 1)
    values = autocorr[lag_min : lag_max + 1]
    peaks: list[tuple[float, float]] = []
    for index in range(1, values.size - 1):
        if values[index] <= values[index - 1] or values[index] < values[index + 1]:
            continue
        peaks.append((float(values[index]), 60.0 * frame_rate / float(lags[index])))
    if not peaks:
        index = int(np.argmax(values))
        peaks = [(float(values[index]), 60.0 * frame_rate / float(lags[index]))]
    peaks.sort(reverse=True)

    candidates: list[float] = []
    for _strength, bpm in peaks[:16]:
        for factor in TEMPO_RELATIONS:
            scaled = bpm * factor
            if not (TEMPO_MIN <= scaled <= TEMPO_MAX):
                continue
            if any(abs(scaled - existing) < 0.8 for existing in candidates):
                continue
            candidates.append(round(scaled, 4))
    return candidates or [120.0]


def _grid_for(onset: np.ndarray, period_frames: float, phase: float, snap: bool = True) -> np.ndarray:
    """Beat frame indices for a period/phase pair, optionally snapped to onsets.

    Snapping moves each beat to the loudest onset within 18% of a period. It is
    used inside the tempo scoring (where it steers the choice of phase) but not for
    the published grid, which stays on an exact lattice.
    """
    if period_frames < 2 or phase < 0:
        return np.array([], dtype=int)
    last = onset.size - 1
    if phase > last:
        return np.array([], dtype=int)

    count = int(np.floor((last - phase) / period_frames)) + 1
    positions = np.clip(np.rint(phase + period_frames * np.arange(count)).astype(int), 0, last)
    if not snap:
        return positions

    tolerance = max(1, int(period_frames * 0.18))
    offsets = np.arange(-tolerance, tolerance + 1)
    window = positions[:, None] + offsets[None, :]
    valid = (window >= 0) & (window <= last)
    clipped = np.clip(window, 0, last)
    values = np.where(valid, onset[clipped], -np.inf)
    return clipped[np.arange(positions.size), np.argmax(values, axis=1)]


def _best_phase(positive: np.ndarray, period_frames: float, phases: int = 32) -> tuple[float, float]:
    """Phase whose snapped beat lattice carries the most onset strength.

    Snapping matters: without it the objective is nearly flat within +/-half a
    frame, which is enough to let a 5:4 subharmonic (76 BPM for a 95 BPM beat) win.
    Scoring snapped grids keeps the reward tied to real onsets.
    """
    best_salience = -1.0
    best_phase = 0.0
    for phase in np.linspace(0.0, period_frames, phases, endpoint=False):
        beats = _grid_for(positive, period_frames, float(phase))
        if beats.size < 4:
            continue
        salience = float(np.mean(positive[beats]))
        if salience > best_salience:
            best_salience = salience
            best_phase = float(phase)
    return best_salience, best_phase


def score_tempo(onset: np.ndarray, bpm: float, sr: int = SR_ANALYSIS, hop: int = FAST_HOP) -> dict:
    """Score a tempo candidate on onset salience, grid regularity and a prior."""
    frame_rate = sr / hop
    period_frames = 60.0 / bpm * frame_rate
    if period_frames < 2 or onset.size < period_frames * 4:
        return {"score": -1e9, "bpm": bpm, "phase": 0.0, "period_frames": period_frames}

    positive = np.maximum(onset, 0.0)
    spread = float(np.std(positive)) + 1e-9

    salience_raw, phase = _best_phase(positive, period_frames)
    if salience_raw < 0.0:
        return {"score": -1e9, "bpm": bpm, "phase": phase, "period_frames": period_frames}
    salience = salience_raw / spread

    beats = _grid_for(positive, period_frames, phase)
    if beats.size < 4:
        return {"score": -1e9, "bpm": bpm, "phase": phase, "period_frames": period_frames}
    intervals = np.diff(beats) / frame_rate
    mean_interval = float(np.mean(intervals)) or 1e-9
    regularity = float(np.clip(1.0 - (np.std(intervals) / mean_interval), 0.0, 1.0))
    coverage = float(np.clip(float(np.sum(positive[beats])) / (float(np.sum(positive)) + 1e-9) * 3.0, 0.0, 1.0))
    prior = math.exp(-0.5 * (math.log2(bpm / TEMPO_PRIOR_CENTRE) / TEMPO_PRIOR_WIDTH) ** 2)

    score = (salience ** 1.35) * (0.35 + 0.65 * regularity) * (0.7 + 0.3 * coverage) * (prior ** 0.5)
    return {
        "score": score,
        "bpm": bpm,
        "phase": phase,
        "period_frames": period_frames,
        "salience": salience,
        "regularity": regularity,
        "coverage": coverage,
        "prior": prior,
    }


def _interpolated_peaks(onset: np.ndarray, frame_rate: float, relative_threshold: float = 0.2) -> tuple[np.ndarray, np.ndarray]:
    """Onset peak times with sub-frame precision, plus their strengths."""
    positive = np.maximum(onset, 0.0)
    if positive.size < 3 or float(np.max(positive)) <= 0:
        return np.array([]), np.array([])

    interior = (
        np.where(
            (positive[1:-1] > positive[:-2])
            & (positive[1:-1] >= positive[2:])
            & (positive[1:-1] > relative_threshold * float(np.max(positive)))
        )[0]
        + 1
    )
    if interior.size == 0:
        return np.array([]), np.array([])

    y0 = positive[interior - 1].astype(float)
    y1 = positive[interior].astype(float)
    y2 = positive[interior + 1].astype(float)
    denominator = y0 - 2.0 * y1 + y2
    usable = np.abs(denominator) > 1e-12
    offset = np.zeros(interior.size)
    offset[usable] = 0.5 * (y0[usable] - y2[usable]) / denominator[usable]
    times = (interior + np.clip(offset, -0.5, 0.5)) / frame_rate
    return times, y1


def _lattice_alignment(times: np.ndarray, weights: np.ndarray, bpm: float, phases: int = 16, sigma: float = 0.03) -> float:
    """Share of onset mass sitting on a pulse lattice of period 60/bpm (best phase)."""
    period = 60.0 / bpm
    total = float(np.sum(weights)) or 1.0
    best = 0.0
    for index in range(phases):
        phase = period * index / phases
        residual = times - phase - np.round((times - phase) / period) * period
        matched = float(np.sum(weights * np.exp(-0.5 * (residual / sigma) ** 2)))
        if matched > best:
            best = matched
    return best / total


def refine_tempo(onset: np.ndarray, bpm: float, sr: int = SR_ANALYSIS, hop: int = FAST_HOP) -> float:
    """Nail the exact tempo with a pulse-lattice scan around the candidate.

    The candidate search runs on frames (23 ms at the fast hop), so it can only
    place the tempo within about 1%. That matters: a 1% error drifts a whole beat
    over a three-minute file, so the beat grid visibly slips off the kicks later
    on. Measuring how much *interpolated onset mass* lands on a fine pulse lattice
    is sharp to ~0.1% over a long file, so the scan is local (+/-2%) and cheap.

    The lattice is deliberately narrow (sigma 30 ms): an eighth-note lattice would
    score higher simply for having twice as many grid points, so the octave family
    stays whatever `estimate_tempo` chose.
    """
    if bpm <= 0 or onset.size < 32:
        return bpm

    peak_times, weights = _interpolated_peaks(onset, sr / hop)
    if peak_times.size < 8:
        return bpm

    step = 0.05
    candidates = np.arange(bpm * 0.98, bpm * 1.02 + 1e-9, step)
    scores = np.array([_lattice_alignment(peak_times, weights, float(value)) for value in candidates])
    best_index = int(np.argmax(scores))

    delta = 0.0
    if 0 < best_index < scores.size - 1:
        y0, y1, y2 = float(scores[best_index - 1]), float(scores[best_index]), float(scores[best_index + 1])
        denominator = y0 - 2.0 * y1 + y2
        if abs(denominator) > 1e-15:
            delta = float(np.clip(0.5 * (y0 - y2) / denominator, -1.0, 1.0))

    refined = float(candidates[best_index]) + delta * step
    if refined <= 0 or abs(refined - bpm) > 0.03 * bpm:
        return bpm
    return float(round(refined, 2))


def estimate_tempo(
    onset: np.ndarray,
    sr: int = SR_ANALYSIS,
    hop: int = FAST_HOP,
    min_bpm: float = TEMPO_MIN,
    max_bpm: float = TEMPO_MAX,
) -> tuple[float, float, float]:
    """Estimate tempo by scoring every candidate *and its musical relatives*.

    Picking the strongest autocorrelation peak alone happily returns a 5:4
    subharmonic of the real pulse (76 BPM for a 95 BPM beat). Scoring grid
    evidence — salience, regularity, coverage — together with a tempo prior
    resolves that whole class of error.

    Returns (bpm, confidence, period_seconds).
    """
    del min_bpm, max_bpm  # kept for call-site compatibility
    if onset.size < 32:
        return 120.0, 0.1, 0.5

    scored = [score_tempo(onset, bpm, sr=sr, hop=hop) for bpm in tempo_candidates(onset, sr=sr, hop=hop)]
    scored.sort(key=lambda entry: entry["score"], reverse=True)
    if not scored or scored[0]["score"] <= -1e8:
        return 120.0, 0.1, 0.5

    best = scored[0]
    bpm = refine_tempo(onset, float(best["bpm"]), sr=sr, hop=hop)

    runner_up = 0.0
    for entry in scored[1:]:
        ratio = entry["bpm"] / bpm
        if not any(abs(ratio - relation) < 0.03 for relation in TEMPO_RELATIONS):
            runner_up = float(entry["score"])
            break
    margin = (float(best["score"]) - runner_up) / (float(best["score"]) + 1e-9)
    confidence = float(np.clip(0.25 + 0.75 * margin + 0.3 * (float(best["regularity"]) - 0.5), 0.05, 0.99))
    return round(bpm, 2), confidence, 60.0 / bpm


def beat_grid(onset: np.ndarray, period_seconds: float, sr: int = SR_ANALYSIS, hop: int = FAST_HOP) -> np.ndarray:
    """Beat times in seconds for a period, using the best-scoring phase.

    The final grid is built without onset snapping: snapping each beat to the
    loudest nearby onset made the published grid jittery (intervals varying by
    >20%) even when the tempo was right.
    """
    if onset.size < 8 or period_seconds <= 0:
        return np.array([])
    frame_rate = sr / hop
    positive = np.maximum(onset, 0.0)
    scored = score_tempo(positive, 60.0 / period_seconds, sr=sr, hop=hop)
    beats = _grid_for(positive, period_seconds * frame_rate, float(scored.get("phase", 0.0)), snap=False)
    return beats * hop / sr


def downbeats_from_bass(
    low_energy: np.ndarray,
    beat_times: np.ndarray,
    n_frames: int,
    hop: int = FAST_HOP,
    sr: int = SR_ANALYSIS,
    beats_per_bar: int = 4,
) -> np.ndarray:
    """Pick the bar phase whose beats carry the most low-frequency onset energy."""
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
        # Contrast against the rest of the bar: kick patterns weight the downbeat.
        other = np.delete(beat_idx, np.arange(phase, beat_idx.size, beats_per_bar))
        contrast = float(np.mean(env[positions])) - (float(np.mean(env[other])) if other.size else 0.0)
        score = float(np.mean(env[positions])) + contrast
        if score > best_score:
            best_score = score
            best_phase = phase
    return beat_times[best_phase::beats_per_bar]


# ---------------------------------------------------------------------------
# Sustained (kick-free) low content
# ---------------------------------------------------------------------------
def sustained_mask(
    magnitude: np.ndarray,
    freqs: np.ndarray,
    hop: int = FAST_HOP,
    sr: int = SR_ANALYSIS,
    low: float = 40.0,
    high: float = 200.0,
    flux_percentile: float = 88.0,
    guard_ms: float = 50.0,
) -> np.ndarray:
    """Frames that are *not* kick transients.

    A kick thump is loud, low and momentary, and it is often not in the key
    (a 55 Hz thump votes for A against a bass line in F), so it must not vote on
    the key at all.
    """
    n_frames = magnitude.shape[0]
    band_mask = (freqs >= low) & (freqs <= high)
    if not np.any(band_mask) or n_frames < 4:
        return np.ones(n_frames, dtype=bool)

    band = magnitude[:, band_mask]
    log_band = np.log1p(band * 50.0)
    flux = np.concatenate([[0.0], np.maximum(np.diff(log_band, axis=0), 0.0).sum(axis=1)])
    threshold = float(np.percentile(flux, flux_percentile))
    sustained = np.ones(n_frames, dtype=bool)
    guard = max(2, int(round((guard_ms / 1000.0) * sr / hop)))
    for index in np.where(flux >= threshold)[0]:
        sustained[index : min(index + guard, n_frames)] = False
    return sustained


# ---------------------------------------------------------------------------
# Chroma
# ---------------------------------------------------------------------------
def _chroma_from_band(magnitude: np.ndarray, freqs: np.ndarray, low: float, high: float) -> np.ndarray:
    """Pitch-class energy per semitone for one frequency band.

    Bins are weighted by their share of a semitone. Without that, a plain sum
    counts *bins* rather than *notes*: at 2.7 Hz bins, a semitone near 100 Hz
    spans 4 bins but near 2 kHz spans 50, so the hi-hats and snare noise up top
    swamp the tonal content below and every pitch class lands at ~8%. Weighting
    each bin by bin_width/semitone_width makes the chroma a measure of energy
    density per semitone, which is what the key profiles are calibrated against.
    """
    mask = (freqs >= low) & (freqs <= high)
    if not np.any(mask):
        return np.zeros((magnitude.shape[0], 12), dtype=np.float32)

    selected = magnitude[:, mask]
    selected_freqs = freqs[mask]
    with np.errstate(divide="ignore", invalid="ignore"):
        midi = 69.0 + 12.0 * np.log2(np.maximum(selected_freqs, 1e-6) / 440.0)
    pitch_class = np.mod(np.round(midi).astype(int), 12)

    bin_hz = float(freqs[1] - freqs[0]) if freqs.size > 1 else 1.0
    semitone_hz = 440.0 * 2 ** ((midi - 69.0) / 12.0) * (2 ** (1.0 / 12.0) - 1.0)
    density = bin_hz / np.maximum(semitone_hz, 1e-9)

    chroma = np.zeros((magnitude.shape[0], 12), dtype=np.float32)
    for pc in range(12):
        bins = pitch_class == pc
        if np.any(bins):
            chroma[:, pc] = (selected[:, bins] * density[bins]).sum(axis=1)

    norms = np.linalg.norm(chroma, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return chroma / norms


def chromagram(magnitude: np.ndarray, freqs: np.ndarray) -> np.ndarray:
    """Chroma over the tonal range (65-1200 Hz), L2-normalised per frame.

    The ceiling matters: percussion noise lives above ~1.2 kHz and carries no key.
    """
    return _chroma_from_band(magnitude, freqs, CHROMA_LOW_HZ, CHROMA_HIGH_HZ)


def bass_chromagram(magnitude: np.ndarray, freqs: np.ndarray) -> np.ndarray:
    """Chroma from the bass range only."""
    return _chroma_from_band(magnitude, freqs, BASS_LOW_HZ, BASS_HIGH_HZ)


def bass_root_histogram(
    magnitude: np.ndarray,
    freqs: np.ndarray,
    low: float = BASS_LOW_HZ,
    high: float = BASS_HIGH_HZ,
    sustained: np.ndarray | None = None,
) -> np.ndarray:
    """Pitch-class histogram of *sustained* low notes — the tonal-centre cue.

    The naive version (strongest low partial per frame) is dominated by the kick:
    a 55 Hz thump votes for A on every beat regardless of the key, which is how a
    bass line on F read as A-dominant and flipped the mode to major. Kick frames
    are excluded, and a frame only counts when the same pitch class persists into
    a neighbouring frame.
    """
    band_mask = (freqs >= low) & (freqs <= high)
    if not np.any(band_mask):
        return np.zeros(12, dtype=np.float32)

    band = magnitude[:, band_mask]
    band_freqs = freqs[band_mask]
    n_frames = band.shape[0]
    if band.size == 0 or n_frames == 0:
        return np.zeros(12, dtype=np.float32)

    excluded = np.zeros(n_frames, dtype=bool)
    if sustained is not None and sustained.size == n_frames:
        excluded = ~sustained

    strongest = np.argmax(band, axis=1)
    strengths = band[np.arange(n_frames), strongest]
    active_threshold = float(np.percentile(strengths, 40.0)) if strengths.size else 0.0

    pitch_classes = np.full(n_frames, -1, dtype=int)
    for frame in range(n_frames):
        frequency = float(band_freqs[strongest[frame]])
        if frequency <= 0:
            continue
        midi = 69.0 + 12.0 * math.log2(frequency / 440.0)
        pitch_classes[frame] = int(round(midi)) % 12

    histogram = np.zeros(12, dtype=np.float32)
    for frame in range(n_frames):
        if excluded[frame] or pitch_classes[frame] < 0:
            continue
        if float(strengths[frame]) < active_threshold:
            continue
        previous_ok = frame > 0 and pitch_classes[frame - 1] == pitch_classes[frame]
        next_ok = frame + 1 < n_frames and pitch_classes[frame + 1] == pitch_classes[frame]
        if not (previous_ok or next_ok):
            continue
        histogram[pitch_classes[frame]] += float(strengths[frame])

    if float(np.sum(histogram)) > 0:
        histogram = histogram / float(np.sum(histogram))
    return histogram


def loudness_weights(
    mono: np.ndarray,
    n_frames: int,
    hop: int = FINE_HOP,
    frame: int = FINE_FRAME,
) -> np.ndarray:
    """Per-frame RMS — quiet bars should not vote on the key."""
    rms = np.zeros(n_frames, dtype=np.float32)
    limit = min(n_frames, max(0, (mono.size - frame) // hop + 1))
    for index in range(limit):
        segment = mono[index * hop : index * hop + frame]
        if segment.size:
            rms[index] = float(np.sqrt(np.mean(segment**2)))
    return rms


# ---------------------------------------------------------------------------
# Key
# ---------------------------------------------------------------------------
def key_scores(
    chroma: np.ndarray,
    bass_chroma: np.ndarray | None = None,
    bass_roots: np.ndarray | None = None,
) -> list[tuple[float, int, str]]:
    """Score all 24 keys from the pitch content.

    Three views are combined because each is blind in a different way: the full
    chroma carries melody and harmony, the bass chroma carries low-end harmonic
    movement, and the kick-free root histogram carries the actual bass note.
    """
    profile = chroma.mean(axis=0) if chroma.ndim > 1 else chroma
    if float(np.sum(np.abs(profile))) == 0:
        return []

    bass_profile = None
    if bass_chroma is not None and bass_chroma.size:
        candidate = bass_chroma.mean(axis=0) if bass_chroma.ndim > 1 else bass_chroma
        if float(np.sum(np.abs(candidate))) > 0:
            bass_profile = candidate

    roots = None
    if bass_roots is not None and float(np.sum(np.abs(bass_roots))) > 0:
        roots = bass_roots

    results: list[tuple[float, int, str]] = []
    for tonic in range(12):
        for mode, reference in (("major", MAJOR_PROFILE), ("minor", MINOR_PROFILE)):
            rotated = np.roll(reference, tonic)
            score = float(np.corrcoef(profile, rotated)[0, 1])
            if bass_profile is not None:
                score = 0.72 * score + 0.28 * float(np.corrcoef(bass_profile, rotated)[0, 1])
            if roots is not None:
                # The root histogram is not a scale profile: it votes for the
                # tonic degree directly, plus the third that mode implies.
                third = (tonic + 3) % 12 if mode == "minor" else (tonic + 4) % 12
                score += 0.55 * float(roots[tonic]) + 0.35 * float(roots[third])
            results.append((score, tonic, mode))
    results.sort(reverse=True)
    return results


def _relative_pair(a: float, b: float) -> float:
    """Signed relative difference in [-1, 1]: positive when a wins."""
    return (a - b) / (abs(a) + abs(b) + 1e-9)


def estimate_key(
    chroma: np.ndarray,
    bass_chroma: np.ndarray | None = None,
    bass_roots: np.ndarray | None = None,
) -> tuple[str, float, str]:
    """Key + confidence, with the mode decided by aggregating every third signal.

    Relative keys (F major vs F minor, C major vs A minor) score within a few
    thousandths of each other, so no single measure decides it. The mode comes
    from four independent views of the third above the tonic:
      * the key-profile correlation difference,
      * the full chroma (melody + pads),
      * the bass chroma,
      * the sustained, kick-free bass-root histogram.
    """
    results = key_scores(chroma, bass_chroma, bass_roots)
    if not results:
        return "unknown", 0.0, ""

    _, tonic, _ = results[0]

    profile = chroma.mean(axis=0) if chroma.ndim > 1 else chroma
    profile = profile / (float(np.sum(profile)) or 1.0)

    bass_profile = None
    if bass_chroma is not None and bass_chroma.size:
        candidate = bass_chroma.mean(axis=0) if bass_chroma.ndim > 1 else bass_chroma
        bass_profile = candidate / (float(np.sum(candidate)) or 1.0)

    roots = bass_roots if bass_roots is not None and float(np.sum(np.abs(bass_roots))) > 0 else None

    def score_for(mode: str) -> float:
        return next((score for score, t, m in results if t == tonic and m == mode), 0.0)

    minor_corr = score_for("minor")
    major_corr = score_for("major")

    evidence = 0.9 * _relative_pair(minor_corr, major_corr)
    evidence += 1.6 * _relative_pair(float(profile[(tonic + 3) % 12]), float(profile[(tonic + 4) % 12]))
    if bass_profile is not None:
        evidence += 1.2 * _relative_pair(float(bass_profile[(tonic + 3) % 12]), float(bass_profile[(tonic + 4) % 12]))
    if roots is not None:
        evidence += 1.4 * _relative_pair(float(roots[(tonic + 3) % 12]), float(roots[(tonic + 4) % 12]))

    mode = "minor" if evidence > 0 else "major"
    best_score = score_for(mode)

    # Confidence: margin over the strongest key that is not our relative pair,
    # plus how clear the mode evidence was.
    runner_up = 0.0
    for score, other_tonic, other_mode in results[1:]:
        same_relative = (other_tonic - tonic) % 12 in (0, 9, 3) and other_mode != mode
        if not same_relative:
            runner_up = score
            break
    margin = best_score - runner_up
    mode_clarity = abs(evidence) / (1.0 + abs(evidence))
    confidence = float(np.clip(0.3 + margin * 0.9 + 0.25 * mode_clarity, 0.05, 0.95))
    scale = "major" if mode == "major" else "natural minor"
    return f"{PITCH_CLASSES[tonic]} {mode}", confidence, scale


# ---------------------------------------------------------------------------
# Chords
# ---------------------------------------------------------------------------
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
                # intended chord (this stops a lone A note winning Dsus4).
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
    ceiling = float(np.percentile(values, 97)) or float(np.max(values)) or 1.0
    normalised = np.clip(values / ceiling, 0.0, 1.0)
    if normalised.size >= 3:
        normalised = np.convolve(normalised, np.array([0.25, 0.5, 0.25]), mode="same")
    return normalised


def bar_features(
    chroma: np.ndarray,
    times: np.ndarray,
    magnitude: np.ndarray,
    freqs: np.ndarray,
    bar_starts: np.ndarray,
    energy: np.ndarray,
) -> np.ndarray:
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
            band_mask = (freqs >= low) & (freqs < high)
            bands.append(float(np.log1p(spectrum_block[band_mask].sum())) if np.any(band_mask) else 0.0)
        bands_array = np.array(bands)
        if float(np.sum(bands_array)) > 0:
            bands_array = bands_array / float(np.sum(bands_array))
        rows.append(np.concatenate([chroma_block, bands_array, [float(energy[index]) if index < energy.size else 0.0]]))
    matrix = np.vstack(rows) if rows else np.zeros((1, 18))
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return matrix / norms


def _segment_boundaries(features: np.ndarray, novelty_threshold: float = 0.8) -> list[int]:
    n_bars = features.shape[0]
    if n_bars < 8:
        return [0, n_bars]

    similarity = features @ features.T
    size = max(2, min(8, n_bars // 4))
    kernel = np.zeros((2 * size, 2 * size), dtype=np.float32)
    for i in range(2 * size):
        for j in range(2 * size):
            kernel[i, j] = 1.0 if (i < size) == (j < size) else -1.0

    novelty = np.zeros(n_bars, dtype=np.float32)
    for index in range(n_bars):
        lo = index - size
        window = np.zeros((2 * size, 2 * size), dtype=np.float32)
        for i in range(2 * size):
            for j in range(2 * size):
                source_i, source_j = lo + i, lo + j
                if 0 <= source_i < n_bars and 0 <= source_j < n_bars:
                    window[i, j] = similarity[source_i, source_j]
        novelty[index] = float(np.sum(window * kernel))

    novelty = novelty - float(np.mean(novelty))
    deviation = float(np.std(novelty)) or 1.0
    novelty = novelty / deviation

    min_gap = max(4, n_bars // 12)
    boundaries = [0]
    for index in range(1, n_bars - 1):
        if novelty[index] < novelty_threshold:
            continue
        if novelty[index] < novelty[index - 1] or novelty[index] < novelty[index + 1]:
            continue
        if index - boundaries[-1] < min_gap:
            continue
        boundaries.append(index)
    if n_bars - boundaries[-1] < min_gap and len(boundaries) > 1:
        boundaries.pop()
    boundaries.append(n_bars)
    return boundaries


def _cluster_segments(features: np.ndarray, boundaries: list[int], threshold: float = 0.9) -> list[int]:
    """Group segments that sound like each other (chorus repeats, verse repeats)."""
    means: list[np.ndarray] = []
    for index in range(len(boundaries) - 1):
        start, end = boundaries[index], boundaries[index + 1]
        means.append(features[start:end].mean(axis=0))

    labels: list[int] = []
    for mean in means:
        norm = mean / (np.linalg.norm(mean) + 1e-9)
        assigned = -1
        for index, cluster in enumerate(means[: len(labels)]):
            if labels[index] != index:
                continue
            cluster_norm = cluster / (np.linalg.norm(cluster) + 1e-9)
            if float(np.dot(norm, cluster_norm)) >= threshold:
                assigned = labels[index]
                break
        labels.append(assigned if assigned >= 0 else len(labels))
    return labels


def detect_sections(
    features: np.ndarray,
    energy: np.ndarray,
    bar_starts: np.ndarray,
    bpm_confidence: float,
) -> list[dict]:
    """Self-similarity + checkerboard novelty, labelled by repetition structure."""
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

    boundaries = _segment_boundaries(features)
    labels = _cluster_segments(features, boundaries)

    segments: list[dict] = []
    for index in range(len(boundaries) - 1):
        bar_start, bar_end = boundaries[index], boundaries[index + 1]
        segments.append(
            {
                "bar_start": bar_start,
                "bar_end": bar_end,
                "cluster": labels[index],
                "energy": float(np.mean(energy[bar_start:bar_end])) if energy.size else 0.5,
            }
        )

    median_energy = float(np.median([segment["energy"] for segment in segments]))

    cluster_sizes: dict[int, int] = {}
    cluster_energy: dict[int, list[float]] = {}
    for segment in segments:
        cluster_sizes[segment["cluster"]] = cluster_sizes.get(segment["cluster"], 0) + 1
        cluster_energy.setdefault(segment["cluster"], []).append(segment["energy"])

    # The chorus is the most repeated cluster at or above typical energy — not
    # simply "the loudest segment", which mislabels one-off loud bars.
    chorus_cluster: int | None = None
    best_key = (-1.0, -1.0)
    for cluster, size in cluster_sizes.items():
        mean_energy = float(np.mean(cluster_energy[cluster]))
        if mean_energy < median_energy * 0.95:
            continue
        candidate_key = (float(size), mean_energy)
        if candidate_key > best_key:
            best_key = candidate_key
            chorus_cluster = cluster

    for index, segment in enumerate(segments):
        length = segment["bar_end"] - segment["bar_start"]
        if index == 0 and segment["energy"] <= median_energy and length >= 4:
            segment["type"] = "intro"
        elif index == len(segments) - 1 and segment["energy"] < median_energy and length >= 4:
            segment["type"] = "outro"
        elif chorus_cluster is not None and segment["cluster"] == chorus_cluster:
            segment["type"] = "chorus"
        elif index > 0 and segment["energy"] > segments[index - 1]["energy"] + 0.04 and length <= 8:
            segment["type"] = "pre-chorus"
        elif segment["energy"] >= median_energy:
            segment["type"] = "chorus"
        elif length <= 4:
            segment["type"] = "break"
        else:
            segment["type"] = "verse"

    counts: dict[str, int] = {}
    sections: list[dict] = []
    for segment in segments:
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
            }
        )
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


def rhythm_stats(
    onset: np.ndarray,
    beat_times: np.ndarray,
    bpm: float,
    sr: int = SR_ANALYSIS,
    hop: int = FAST_HOP,
) -> dict:
    frame_rate = sr / hop
    peaks = np.where(
        (onset[1:-1] > onset[:-2]) & (onset[1:-1] >= onset[2:]) & (onset[1:-1] > 0.35 * float(np.std(onset) + 1e-9))
    )[0] + 1
    onsets_per_second = float(peaks.size / max(onset.size / frame_rate, 1e-9))

    if beat_times.size >= 2:
        period = float(np.median(np.diff(beat_times)))
    else:
        period = 60.0 / max(bpm, 1.0)

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
    """Full Beat Profile (see docs/ARCHITECTURE.md for the contract)."""
    mono = audio.mono
    sr = audio.analysis_rate
    warnings: list[str] = []

    # --- fast pass: time resolution for onsets, tempo and energy -----------
    fast_magnitude, fast_freqs = stft_magnitude(mono, FAST_FRAME, FAST_HOP, sr)
    fast_times = frame_times(fast_magnitude.shape[0], FAST_HOP, FAST_FRAME, sr)
    onset = onset_envelope(fast_magnitude, fast_freqs)

    bpm, bpm_confidence, period = estimate_tempo(onset, sr=sr, hop=FAST_HOP)
    if bpm_confidence < 0.3:
        warnings.append(
            f"Tempo confidence is low ({bpm_confidence:.2f}) - check the detected {bpm:.1f} BPM "
            "(half/double time is a common mix-up)."
        )
    else:
        # Octave ambiguity is real even at high confidence: a groove with percussion
        # on every beat can be counted at half speed with equal conviction (Afrobeats
        # is notorious for this). Rather than guess, say so and let the artist pick.
        chosen_score = float(score_tempo(onset, bpm, sr=sr, hop=FAST_HOP)["score"])
        for factor, label in ((2.0, "double"), (0.5, "half")):
            alternative = bpm * factor
            if not (TEMPO_MIN <= alternative <= TEMPO_MAX):
                continue
            alternative = refine_tempo(onset, alternative, sr=sr, hop=FAST_HOP)
            alternative_score = float(score_tempo(onset, alternative, sr=sr, hop=FAST_HOP)["score"])
            if alternative_score >= 0.75 * chosen_score:
                warnings.append(
                    f"Tempo could also be counted as {alternative:.1f} BPM (the {label} of {bpm:.1f}) - "
                    "use whichever you would tap."
                )
                break

    beat_times = beat_grid(onset, period, sr=sr, hop=FAST_HOP)
    low_mask = (fast_freqs >= 30) & (fast_freqs <= 160)
    low_energy = (
        fast_magnitude[:, low_mask].sum(axis=1)
        if np.any(low_mask)
        else np.zeros(fast_magnitude.shape[0], dtype=np.float32)
    )
    downbeats = downbeats_from_bass(low_energy, beat_times, fast_magnitude.shape[0], beats_per_bar=beats_per_bar)

    # --- fine pass: frequency resolution for pitch ------------------------
    fine_magnitude, fine_freqs = stft_magnitude(mono, FINE_FRAME, FINE_HOP, sr)
    fine_times = frame_times(fine_magnitude.shape[0], FINE_HOP, FINE_FRAME, sr)
    sustained = sustained_mask(fine_magnitude, fine_freqs, hop=FINE_HOP, sr=sr)

    chroma = chromagram(fine_magnitude, fine_freqs)
    bass_chroma = bass_chromagram(fine_magnitude, fine_freqs)

    # Loudness weighting: quiet intro/breakdown frames should not vote on the key.
    weights = loudness_weights(mono, chroma.shape[0], FINE_HOP, FINE_FRAME)
    if weights.size == chroma.shape[0] and float(np.max(weights)) > 0:
        keep = weights > 0.25 * float(np.median(weights))
        if int(np.count_nonzero(keep)) >= max(8, chroma.shape[0] // 20):
            chroma_weighted = chroma[keep]
        else:
            chroma_weighted = chroma
    else:
        chroma_weighted = chroma

    # Bass evidence comes only from sustained (kick-free) frames.
    if int(np.count_nonzero(sustained)) >= 8:
        bass_weighted = bass_chroma[sustained]
    else:
        bass_weighted = bass_chroma
    bass_roots = bass_root_histogram(fine_magnitude, fine_freqs, sustained=sustained)

    key, key_confidence, scale = estimate_key(chroma_weighted, bass_weighted, bass_roots)
    if key_confidence < 0.35:
        warnings.append(
            f"Key confidence is low ({key_confidence:.2f}) - check {key} (relative major/minor is a common mix-up)."
        )

    chords = detect_chords(chroma, fine_times, beat_times)
    progression: list[str] = []
    for event in chords:
        if not progression or progression[-1] != event["chord"]:
            progression.append(event["chord"])

    duration = float(mono.size / sr)
    bars = bar_times_from_beats(downbeats, duration)
    energy_curve = bar_energy(mono, bars, sr)
    tension = harmonic_tension(chroma, fine_times, bars)
    features = bar_features(chroma, fine_times, fine_magnitude, fine_freqs, bars, energy_curve)
    sections = detect_sections(features, energy_curve, bars, bpm_confidence)

    by_section: dict[str, float] = {}
    for section in sections:
        kind = str(section["type"])
        if kind not in by_section:
            by_section[kind] = float(round(section["energy"], 3))

    peak = float(np.max(np.abs(mono))) if mono.size else 0.0
    lufs = integrated_lufs(audio.stereo, sr)
    rhythm = rhythm_stats(onset, beat_times, bpm, sr=sr, hop=FAST_HOP)
    overall_energy = float(np.mean(energy_curve)) if energy_curve.size else 0.5

    if audio.duration < 8:
        warnings.append("Beat is shorter than 8 seconds - analysis confidence is limited.")

    # An irregular grid means the tempo is probably a relative of the real pulse.
    if beat_times.size >= 8:
        intervals = np.diff(beat_times)
        irregularity = float(np.std(intervals) / (np.mean(intervals) + 1e-9))
        if irregularity > 0.25:
            warnings.append(
                f"Beat grid is irregular (interval spread {irregularity:.0%}) - the detected tempo may be a "
                "half or double of the real pulse."
            )

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
