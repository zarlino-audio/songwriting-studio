"""
Quick synthetic check: can the engine identify keys and tempos it should?

    python -m app.probe

Builds beats with known ground truth and prints what the analyser says.
Useful when a real beat disagrees with its producer tag.
"""

from __future__ import annotations

import sys

import numpy as np

from .analysis import analyse
from .synth import SR, render

def describe_evidence(audio) -> str:
    """Print the chroma / bass / root evidence behind the key decision."""
    from .analysis.features import (
        FINE_FRAME,
        FINE_HOP,
        PITCH_CLASSES,
        bass_chromagram,
        bass_root_histogram,
        chromagram,
        estimate_key,
        key_scores,
        loudness_weights,
        stft_magnitude,
        sustained_mask,
    )

    magnitude, freqs = stft_magnitude(audio.mono, FINE_FRAME, FINE_HOP, audio.analysis_rate)
    chroma = chromagram(magnitude, freqs)
    bass_chroma = bass_chromagram(magnitude, freqs)
    sustained = sustained_mask(magnitude, freqs, hop=FINE_HOP, sr=audio.analysis_rate)
    weights = loudness_weights(audio.mono, chroma.shape[0], FINE_HOP, FINE_FRAME)
    keep = weights > 0.25 * float(np.median(weights))
    chroma_used = chroma[keep] if int(np.count_nonzero(keep)) >= 8 else chroma
    bass_used = bass_chroma[sustained] if int(np.count_nonzero(sustained)) >= 8 else bass_chroma
    roots = bass_root_histogram(magnitude, freqs, sustained=sustained)

    def pct(vector) -> str:
        total = float(np.sum(vector)) or 1.0
        return "".join(f"{100.0 * float(v) / total:6.1f}" for v in vector)

    lines = [
        "           " + "".join(f"{name:>6}" for name in PITCH_CLASSES),
        "  full     " + pct(chroma_used.mean(axis=0)),
        "  bass     " + pct(bass_used.mean(axis=0)),
        "  roots    " + pct(roots),
    ]
    for score, tonic, mode in key_scores(chroma_used, bass_used, roots)[:4]:
        lines.append(f"    {PITCH_CLASSES[tonic]} {mode:<6} {score:+.4f}")
    key, confidence, _scale = estimate_key(chroma_used, bass_used, roots)
    lines.append(f"  -> {key} (conf {confidence:.2f})")
    return "\n".join(lines)


def roundtrip(bpm: float = 94.0, progression: list[str] | None = None, root: str = "F") -> int:
    """Encode a rendered beat to MP3 at 44.1 kHz and check the estimate survives.

    The estimations are all done on 22.05 kHz mono, so anything that depends on
    the file's own sample rate or on lossy encoding shows up here and nowhere else.
    """
    import os
    import subprocess
    import tempfile

    import imageio_ffmpeg
    from scipy.io import wavfile

    from .analysis.io import decode

    audio = render(bpm, progression or ["Fm", "D#", "A#", "Cm"], root)
    directory = tempfile.mkdtemp(prefix="zarlino-probe-")
    wav_path = os.path.join(directory, "beat.wav")
    mp3_path = os.path.join(directory, "beat.mp3")

    stereo = np.stack([audio.mono, audio.mono], axis=1)
    wavfile.write(wav_path, SR, (np.clip(stereo, -1.0, 1.0) * 32767).astype(np.int16))
    subprocess.run(
        [imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error", "-i", wav_path, "-ar", "44100", "-b:a", "192k", mp3_path],
        check=True,
    )

    decoded = decode(mp3_path)
    profile = analyse(decoded)
    ok = abs(profile["bpm"] - bpm) <= 1.0
    print(
        f"MP3 round trip ({bpm:.1f} BPM {root} minor, 44.1 kHz stereo -> {decoded.sample_rate} Hz "
        f"{decoded.channels}ch via {decoded.decoder}):\n"
        f"  detected {profile['bpm']:.2f} BPM, {profile['key']} "
        f"(engine {profile['engine']} {profile['engine_version']}) -> {'OK' if ok else 'OFF BY ' + format(profile['bpm'] - bpm, '+.2f')}"
    )
    return 0 if ok else 1


def main(argv: list[str] | None = None) -> int:
    args = list(argv or [])
    if "--roundtrip" in args:
        return roundtrip()
    verbose = "--verbose" in args
    cases = [
        ("F minor @ 94", 94.0, ["Fm", "D#", "A#", "Cm"], "F"),
        ("F major @ 94", 94.0, ["F", "A#", "C"], "F"),
        ("A minor @ 104", 104.0, ["Am", "F", "C", "G"], "A"),
        ("C minor @ 76", 76.0, ["Cm", "G#", "A#"], "C"),
        ("D minor @ 140", 140.0, ["Dm", "A#", "F", "C"], "D"),
    ]

    failures = 0
    for label, bpm, progression, root in cases:
        audio = render(bpm, progression, root)
        profile = analyse(audio)
        detected_bpm = profile["bpm"]
        detected_key = profile["key"]
        bpm_ok = abs(detected_bpm - bpm) <= 3
        key_ok = detected_key.split()[0] == root and ("minor" in detected_key) == ("minor" in label)
        failures += 0 if (bpm_ok and key_ok) else 1
        print(
            f"{label:<14} -> {detected_bpm:7.2f} BPM  {detected_key:<10} "
            f"conf {profile['bpm_confidence']:.2f}/{profile['key_confidence']:.2f}  "
            f"{'OK' if bpm_ok and key_ok else 'MISMATCH'}   "
            f"({len(profile['sections'])} sections, {profile['rhythm']['bar_count']} bars)"
        )
        if verbose:
            print(describe_evidence(audio))

    print(f"\n{len(cases) - failures}/{len(cases)} synthetic cases matched")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
