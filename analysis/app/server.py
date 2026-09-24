"""
HTTP entrypoint for the audio-analysis runtime (spec §6).

    GET  /health            -> liveness + engine version
    POST /analyze           -> JSON {"beat_id": "...", "audio_url": "..."} and/or raw audio bytes

The service pulls the audio itself (signed URL) or accepts raw bytes, runs the
DSP, and returns a Beat Profile JSON. It is deliberately dependency-light so it
can run either as a Cloudflare Container or on a small VM.

Run locally:
    python -m app.server --port 8788 --secret <shared>

Auth: when ANALYSIS_SHARED_SECRET (or --secret) is set, callers must send it in
the `x-analysis-key` header.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from .analysis import ENGINE, ENGINE_VERSION, analyse, decode, decode_bytes, download_to_temp

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("analysis.server")

MAX_RAW_BYTES = 600 * 1024 * 1024
MAX_SECONDS = float(os.environ.get("MAX_AUDIO_SECONDS", "1800"))

# One analysis at a time keeps memory predictable on small instances.
ANALYSIS_LOCK = threading.Semaphore(int(os.environ.get("MAX_CONCURRENCY", "1")))


class Handler(BaseHTTPRequestHandler):
    server_version = "ZarlinoAnalysis/0.1"
    shared_secret = os.environ.get("ANALYSIS_SHARED_SECRET", "")

    # --- helpers ---------------------------------------------------------
    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorised(self) -> bool:
        if not self.shared_secret:
            return True
        return self.headers.get("x-analysis-key", "") == self.shared_secret

    def log_message(self, fmt: str, *args) -> None:  # keep logs compact
        log.info("%s - %s", self.address_string(), fmt % args)

    # --- routes ----------------------------------------------------------
    def do_GET(self) -> None:  # noqa: N802 (stdlib naming)
        path = urlparse(self.path).path.rstrip("/") or "/"
        if path in ("/health", "/"):
            self._send(
                200,
                {
                    "ok": True,
                    "engine": ENGINE,
                    "version": ENGINE_VERSION,
                    "max_seconds": MAX_SECONDS,
                    "auth_required": bool(self.shared_secret),
                },
            )
            return
        self._send(404, {"error": "Not found"})

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path.rstrip("/") or "/"
        if path != "/analyze":
            self._send(404, {"error": "Not found"})
            return
        if not self._authorised():
            self._send(401, {"error": "Invalid analysis key"})
            return

        content_type = self.headers.get("content-type", "")
        beat_id = self.headers.get("x-beat-id", "")
        audio_url: str | None = None
        raw: bytes | None = None

        try:
            if "application/json" in content_type:
                length = int(self.headers.get("content-length", "0"))
                payload = json.loads(self.rfile.read(length) or b"{}")
                beat_id = payload.get("beat_id", beat_id)
                audio_url = payload.get("audio_url")
                if not audio_url:
                    self._send(400, {"error": "audio_url is required in JSON requests"})
                    return
            else:
                length = int(self.headers.get("content-length", "0"))
                if length <= 0:
                    self._send(400, {"error": "Empty body"})
                    return
                if length > MAX_RAW_BYTES:
                    self._send(413, {"error": "Audio payload too large"})
                    return
                raw = self.rfile.read(length)

            with ANALYSIS_LOCK:
                temp_path: str | None = None
                try:
                    if raw is not None:
                        audio = decode_bytes(raw, max_seconds=MAX_SECONDS)
                    else:
                        assert audio_url is not None
                        temp_path = download_to_temp(audio_url)
                        audio = decode(temp_path, max_seconds=MAX_SECONDS)

                    log.info(
                        "analysing beat=%s duration=%.1fs sr=%d channels=%d",
                        beat_id or "?",
                        audio.duration,
                        audio.sample_rate,
                        audio.channels,
                    )
                    profile = analyse(audio)
                    profile["beat_id"] = beat_id
                    self._send(200, {"profile": profile, "engine": ENGINE, "engine_version": ENGINE_VERSION})
                finally:
                    if temp_path:
                        try:
                            os.unlink(temp_path)
                        except OSError:
                            pass
        except ValueError as error:
            log.warning("bad request: %s", error)
            self._send(400, {"error": str(error)})
        except Exception as error:  # pragma: no cover - defensive
            log.error("analysis failed: %s\n%s", error, traceback.format_exc())
            self._send(500, {"error": f"Analysis failed: {error}"})


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Zarlino audio-analysis service")
    parser.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8788")))
    parser.add_argument("--secret", default=os.environ.get("ANALYSIS_SHARED_SECRET", ""))
    args = parser.parse_args(argv)

    Handler.shared_secret = args.secret
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    log.info("analysis service listening on %s:%d (auth=%s)", args.host, args.port, bool(args.secret))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("shutting down")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
