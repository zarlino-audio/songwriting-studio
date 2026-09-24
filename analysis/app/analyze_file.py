"""CLI: analyse a local file and print the Beat Profile JSON.

    python -m app.analyze_file path/to/beat.wav > profile.json
"""

from __future__ import annotations

import argparse
import json
import sys

from .analysis import analyse, decode


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Analyse an audio file into a Beat Profile")
    parser.add_argument("path", help="audio file (wav/mp3/m4a/flac/…)")
    parser.add_argument("--beats-per-bar", type=int, default=4)
    parser.add_argument("--compact", action="store_true", help="omit the waveform samples")
    args = parser.parse_args(argv)

    audio = decode(args.path)
    profile = analyse(audio, beats_per_bar=args.beats_per_bar)
    if args.compact:
        profile["technical"]["waveform"] = []
    json.dump(profile, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
