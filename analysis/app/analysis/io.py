"""Audio loading.

Two decoder backends, chosen automatically:

  1. PyAV (``av``) — ships FFmpeg's demuxers/decoders as wheels. This is what the
     container image uses.
  2. FFmpeg CLI (``imageio-ffmpeg`` or ``ffmpeg`` on PATH) — used on platforms
     where PyAV has no wheel (e.g. Windows + Python 3.11), and as a fallback.

Both produce the same result: audio decoded to 22.05 kHz mono float32 for
analysis, plus the original sample rate and channel count.
"""

from __future__ import annotations

import io
import logging
import os
import re
import shutil
import subprocess
import tempfile
import urllib.request
from dataclasses import dataclass
from typing import BinaryIO

import numpy as np

log = logging.getLogger("analysis.io")

TARGET_SR = 22050


@dataclass
class Audio:
    """Decoded audio used for analysis."""

    mono: np.ndarray  # float32, shape (n,)
    stereo: np.ndarray  # float32, shape (channels, n) — 1 row when mono
    sample_rate: int  # original sample rate
    channels: int
    duration: float
    decoder: str = "unknown"

    @property
    def analysis_rate(self) -> int:
        return TARGET_SR


# ---------------------------------------------------------------------------
# Backend selection
# ---------------------------------------------------------------------------
def pyav_available() -> bool:
    try:
        import av  # noqa: F401

        return True
    except Exception:  # pragma: no cover - import environment differences
        return False


def ffmpeg_executable() -> str | None:
    override = os.environ.get("FFMPEG_BINARY")
    if override and os.path.exists(override):
        return override
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return shutil.which("ffmpeg")


def decoder_name() -> str:
    if pyav_available():
        return "pyav"
    if ffmpeg_executable():
        return "ffmpeg-cli"
    return "none"


# ---------------------------------------------------------------------------
# PyAV backend
# ---------------------------------------------------------------------------
def _channel_count(stream) -> int:
    try:
        layout = stream.codec_context.layout
        if layout is not None and getattr(layout, "nb_channels", 0):
            return int(layout.nb_channels)
    except Exception:  # pragma: no cover - PyAV version differences
        pass
    for attr in ("channels", "nb_channels"):
        value = getattr(stream, attr, None)
        if isinstance(value, int) and value > 0:
            return value
    return 1


def _decode_pyav(source: str | BinaryIO, target_sr: int, max_seconds: float | None) -> Audio:
    import av

    with av.open(source, mode="r") as container:
        if not container.streams.audio:
            raise ValueError("No audio stream found in the file")

        stream = container.streams.audio[0]
        original_sr = int(stream.codec_context.sample_rate or stream.rate or target_sr)
        channels = _channel_count(stream)

        resampler = av.AudioResampler(format="fltp", layout="mono", rate=target_sr)
        blocks: list[np.ndarray] = []

        for frame in container.decode(stream):
            for resampled in resampler.resample(frame):
                blocks.append(np.asarray(resampled.to_ndarray(), dtype=np.float32).reshape(-1))
            if max_seconds is not None and sum(block.size for block in blocks) >= max_seconds * target_sr:
                break

        try:  # flush the resampler so the tail of the file is not lost
            for resampled in resampler.resample(None):
                blocks.append(np.asarray(resampled.to_ndarray(), dtype=np.float32).reshape(-1))
        except Exception:  # pragma: no cover - older PyAV raises on flush
            pass

    if not blocks:
        raise ValueError("The file decoded to zero samples — is it really audio?")

    mono = np.concatenate(blocks).astype(np.float32, copy=False)
    if max_seconds is not None:
        mono = mono[: int(max_seconds * target_sr)]

    return Audio(
        mono=mono - float(np.mean(mono)),
        stereo=mono.reshape(1, -1) if channels == 1 else np.stack([mono, mono], axis=0),
        sample_rate=original_sr,
        channels=channels,
        duration=float(mono.size / target_sr),
        decoder="pyav",
    )


# ---------------------------------------------------------------------------
# FFmpeg CLI backend
# ---------------------------------------------------------------------------
def _probe_with_ffmpeg(exe: str, path: str) -> tuple[int, int]:
    """Parse `ffmpeg -i` output for the original sample rate and channel count."""
    try:
        result = subprocess.run(
            [exe, "-hide_banner", "-i", path],
            capture_output=True,
            text=True,
            timeout=60,
        )
        text = f"{result.stdout}\n{result.stderr}"
        for line in text.splitlines():
            if "Audio:" not in line:
                continue
            rate_match = re.search(r"(\d+)\s*Hz", line)
            sample_rate = int(rate_match.group(1)) if rate_match else TARGET_SR
            if re.search(r"\bstereo\b", line, re.IGNORECASE):
                channels = 2
            else:
                channel_match = re.search(r"(\d+)\s*channels", line)
                channels = int(channel_match.group(1)) if channel_match else 1
            return sample_rate, channels
    except Exception as error:  # pragma: no cover - probe is best-effort
        log.debug("ffmpeg probe failed: %s", error)
    return TARGET_SR, 1


def _decode_ffmpeg_cli(source: str | BinaryIO, target_sr: int, max_seconds: float | None) -> Audio:
    exe = ffmpeg_executable()
    if not exe:
        raise RuntimeError(
            "No audio decoder available. Install PyAV (`pip install av`) or provide an FFmpeg binary "
            "(`pip install imageio-ffmpeg`)."
        )

    cleanup: str | None = None
    if isinstance(source, (str, os.PathLike)):
        path = str(source)
    else:
        handle = tempfile.NamedTemporaryFile(delete=False, suffix=".audio")
        handle.write(source.read())
        handle.close()
        cleanup = handle.name
        path = handle.name

    try:
        original_sr, channels = _probe_with_ffmpeg(exe, path)
        command = [exe, "-nostdin", "-v", "error"]
        if max_seconds is not None:
            command += ["-t", f"{max_seconds:.3f}"]
        command += [
            "-i",
            path,
            "-f",
            "f32le",
            "-acodec",
            "pcm_f32le",
            "-ac",
            "1",
            "-ar",
            str(target_sr),
            "-",
        ]
        result = subprocess.run(command, capture_output=True, timeout=900)
        if result.returncode != 0:
            detail = result.stderr.decode("utf-8", "ignore")[:300]
            raise ValueError(f"FFmpeg could not decode this file: {detail}")
        mono = np.frombuffer(result.stdout, dtype=np.float32).copy()
    finally:
        if cleanup:
            try:
                os.unlink(cleanup)
            except OSError:
                pass

    if mono.size == 0:
        raise ValueError("The file decoded to zero samples — is it really audio?")

    # Remove pathological DC offset, which would distort every energy feature.
    mono = mono - float(np.mean(mono))

    return Audio(
        mono=mono,
        stereo=mono.reshape(1, -1) if channels == 1 else np.stack([mono, mono], axis=0),
        sample_rate=int(original_sr),
        channels=int(channels),
        duration=float(mono.size / target_sr),
        decoder="ffmpeg-cli",
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
def decode(source: str | BinaryIO, target_sr: int = TARGET_SR, max_seconds: float | None = None) -> Audio:
    """Decode a file path or file-like object into mono + channel data."""
    forced = os.environ.get("DECODER", "").lower()
    errors: list[str] = []

    if forced != "ffmpeg" and pyav_available():
        try:
            return _decode_pyav(source, target_sr, max_seconds)
        except Exception as error:
            errors.append(f"pyav: {error}")
            if not isinstance(source, (str, os.PathLike)):
                raise  # a stream cannot be rewound, so retrying would decode garbage
            log.warning("PyAV failed (%s) — falling back to the FFmpeg CLI", error)

    try:
        return _decode_ffmpeg_cli(source, target_sr, max_seconds)
    except Exception as error:
        errors.append(f"ffmpeg: {error}")
        raise RuntimeError("Could not decode the audio — " + " | ".join(errors))


def download_to_temp(url: str, timeout: float = 120.0, max_bytes: int = 1_000_000_000) -> str:
    """Fetch a (signed) audio URL to a temp file and return the path.

    The service pulls the object itself, so the audio never travels through the
    application Worker (spec §6).
    """
    request = urllib.request.Request(url, headers={"User-Agent": "zarlino-analysis/0.1"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".audio") as handle:
            written = 0
            while True:
                chunk = response.read(1 << 20)
                if not chunk:
                    break
                written += len(chunk)
                if written > max_bytes:
                    raise ValueError("Audio object exceeds the maximum supported size")
                handle.write(chunk)
            return handle.name


def decode_bytes(payload: bytes, target_sr: int = TARGET_SR, max_seconds: float | None = None) -> Audio:
    return decode(io.BytesIO(payload), target_sr=target_sr, max_seconds=max_seconds)
