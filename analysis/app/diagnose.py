"""
Diagnostic tool: shows *why* the analyser believes what it believes.

    python -m app.diagnose path/to/beat.mp3 [--top 8]

Prints tempo candidates and the octave family, beat-grid regularity, the
loudness-weighted full and bass chroma, and the key scores with and without the
bass. Use it before changing the DSP — measure, then fix.
"""

from __future__ import annotations

import argparse
import sys

import numpy as np

from .analysis import decode
from .analysis.features import (
    FAST_HOP,
    FINE_FRAME,
    FINE_HOP,
    PITCH_CLASSES,
    _interpolated_peaks,
    _lattice_alignment,
    bass_chromagram,
    bass_root_histogram,
    beat_grid,
    chromagram,
    detect_sections,
    downbeats_from_bass,
    estimate_key,
    estimate_tempo,
    frame_times,
    key_scores,
    loudness_weights,
    onset_envelope,
    refine_tempo,
    rhythm_stats,
    score_tempo,
    stft_magnitude,
    sustained_mask,
    bar_features,
    bar_energy,
    bar_times_from_beats,
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Diagnose the analysis engine on a real file")
    parser.add_argument("path")
    parser.add_argument("--top", type=int, default=6)
    args = parser.parse_args(argv)

    audio = decode(args.path)
    magnitude, freqs = stft_magnitude(audio.mono)
    times = frame_times(magnitude.shape[0])
    onset = onset_envelope(magnitude, freqs)
    bpm, confidence, period = estimate_tempo(onset)

    print(f"file            : {args.path}")
    print(f"decoder         : {audio.decoder}")
    print(f"duration        : {audio.duration:.1f}s  sr={audio.sample_rate}  channels={audio.channels}")
    print(f"frames          : {magnitude.shape[0]} ({magnitude.shape[0] / audio.duration:.1f} fps)")
    print(f"tempo           : {bpm:.2f} BPM (confidence {confidence:.3f}, period {period:.4f}s)")
    print("                  family: " + "  ".join(
        f"{label}={bpm * factor:.2f}" for factor, label in ((0.5, "half"), (2.0, "double"), (1.5, "x1.5"), (0.8, "x0.8"), (1.25, "x1.25"))
    ))

    # --- beats ------------------------------------------------------------
    beats = beat_grid(onset, period)
    low_mask = (freqs >= 30) & (freqs <= 160)
    low_energy = magnitude[:, low_mask].sum(axis=1) if np.any(low_mask) else np.zeros(magnitude.shape[0])
    downbeats = downbeats_from_bass(low_energy, beats, magnitude.shape[0])
    stats = rhythm_stats(onset, beats, bpm)

    intervals = np.diff(beats) if beats.size > 2 else np.array([])
    print(f"\nbeat grid       : {beats.size} beats, first {beats[:4].round(3).tolist()}")
    if intervals.size:
        print(
            f"intervals       : mean {intervals.mean():.4f}s  std {intervals.std():.4f}s  "
            f"spread {intervals.std() / max(intervals.mean(), 1e-9):.1%}"
        )
        if beats.size > 8:
            print(
                f"drift           : {beats.size} beats over {beats[-1] - beats[0]:.2f}s -> "
                f"{60.0 * (beats.size - 1) / max(beats[-1] - beats[0], 1e-9):.2f} BPM "
                "(a wrong tempo family drifts by whole beats over this span)"
            )
    print(f"downbeats       : {downbeats.size}  (bars ~{max(downbeats.size - 1, 0)})")
    print(
        "rhythm          : density %.2f  syncopation %.2f  transient/s %.2f  groove %s"
        % (stats["density"], stats["syncopation"], stats["transient_density"], stats["groove"])
    )

    # --- tempo families ---------------------------------------------------
    # The octave question ("is this 66 or 132?") is the one a producer notices
    # first, so it gets its own table: coarse score and refined lattice score per
    # family member.
    print("\ntempo families  : coarse score / lattice alignment after refinement")
    peaks, weights_peaks = _interpolated_peaks(onset, audio.analysis_rate / FAST_HOP)
    for factor, label in ((0.5, "half"), (0.8, "x0.8"), (2.0 / 3.0, "x2/3"), (1.0, "as-is"), (1.25, "x1.25"), (1.5, "x1.5"), (2.0, "double")):
        candidate = bpm * factor
        if not (40.0 <= candidate <= 220.0):
            continue
        coarse = score_tempo(onset, candidate, sr=audio.analysis_rate, hop=FAST_HOP)
        refined = refine_tempo(onset, candidate, sr=audio.analysis_rate, hop=FAST_HOP)
        lattice = _lattice_alignment(peaks, weights_peaks, refined) if peaks.size else float("nan")
        marker = "  <- chosen" if abs(candidate - bpm) < 0.05 else ""
        print(f"  {label:<7} {candidate:7.2f} -> refined {refined:7.2f}  coarse {coarse['score']:.4f}  lattice {lattice:.3f}{marker}")

    # --- chroma / key (fine pass, exactly as the engine does it) ----------
    fine_magnitude, fine_freqs = stft_magnitude(audio.mono, FINE_FRAME, FINE_HOP, audio.analysis_rate)
    sustained = sustained_mask(fine_magnitude, fine_freqs, hop=FINE_HOP, sr=audio.analysis_rate)
    chroma = chromagram(fine_magnitude, fine_freqs)
    bass_chroma = bass_chromagram(fine_magnitude, fine_freqs)
    weights = loudness_weights(audio.mono, chroma.shape[0], FINE_HOP, FINE_FRAME)
    keep = weights > 0.25 * float(np.median(weights) + 1e-9)
    if int(np.count_nonzero(keep)) > 8:
        chroma_used = chroma[keep]
    else:
        chroma_used = chroma
    bass_used = bass_chroma[sustained] if int(np.count_nonzero(sustained)) > 8 else bass_chroma

    def percent(vector: np.ndarray) -> np.ndarray:
        total = float(np.sum(vector)) or 1.0
        return 100.0 * np.asarray(vector, dtype=float) / total

    full_pct = percent(chroma_used.mean(axis=0))
    bass_pct = percent(bass_used.mean(axis=0))
    roots = bass_root_histogram(fine_magnitude, fine_freqs, sustained=sustained)
    roots_pct = percent(roots)
    print(
        f"\nchroma (% of energy) fine pass {FINE_FRAME}/{FINE_HOP}, "
        f"{int(np.count_nonzero(keep))}/{weights.size} loud frames, "
        f"{int(np.count_nonzero(sustained))}/{sustained.size} sustained frames:"
    )
    print("        " + "".join(f"{name:>6}" for name in PITCH_CLASSES))
    print("full    " + "".join(f"{value:6.1f}" for value in full_pct))
    print("bass    " + "".join(f"{value:6.1f}" for value in bass_pct))
    print("b-roots " + "".join(f"{value:6.1f}" for value in roots_pct))

    tonic_index = int(np.argmax(roots)) if float(np.sum(roots)) > 0 else int(np.argmax(full_pct))
    minor_third = float(full_pct[(tonic_index + 3) % 12])
    major_third = float(full_pct[(tonic_index + 4) % 12])
    root_third = float(roots_pct[(tonic_index + 3) % 12]) - float(roots_pct[(tonic_index + 4) % 12])
    print(
        f"root tonic {PITCH_CLASSES[tonic_index]} (kick-free roots): "
        f"third full {minor_third:.1f} minor vs {major_third:.1f} major "
        f"({'+' if minor_third > major_third else '-'}), roots {root_third:+.1f} pts"
    )

    key, key_confidence, scale = estimate_key(chroma_used, bass_used, roots)
    print(f"\nkey (full + bass + roots): {key} (conf {key_confidence:.3f}) [{scale}]")
    print("scores with bass + roots:")
    for score, tonic, mode in key_scores(chroma_used, bass_used, roots)[: args.top]:
        print(f"  {PITCH_CLASSES[tonic]} {mode:<6} {score:.4f}")
    print("scores without bass:")
    for score, tonic, mode in key_scores(chroma_used)[: args.top]:
        print(f"  {PITCH_CLASSES[tonic]} {mode:<6} {score:.4f}")

    # --- sections ---------------------------------------------------------
    bars = bar_times_from_beats(downbeats, audio.duration)
    energy = bar_energy(audio.mono, bars, audio.analysis_rate)
    fine_times = frame_times(fine_magnitude.shape[0], FINE_HOP, FINE_FRAME, audio.analysis_rate)
    features = bar_features(chroma, fine_times, fine_magnitude, fine_freqs, bars, energy)
    sections = detect_sections(features, energy, bars, confidence)
    print(f"\nsections        : {len(sections)}")
    for section in sections:
        print(
            f"  {section['type']:<13} bars {section['bars'][0]:>3}-{section['bars'][1]:<3} "
            f"{section['start']:7.1f}s-{section['end']:7.1f}s  energy {section['energy']:.2f}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
