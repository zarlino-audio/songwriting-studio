"""
Polling analysis worker — runs the DSP on this machine and reports back.

    python -m app.worker --url https://<worker> --token <ANALYSIS_MACHINE_TOKEN>

The worker claims queued jobs from D1 (via the Worker API), downloads the beat
from a signed URL, analyses it with the same engine the container runs, and
submits the profile. That is how real analysis works before (or instead of) a
Cloudflare Container deployment.

Flags:
  --once        process at most one job and exit
  --interval N  seconds between polls when idle (default 5)
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
import urllib.error
import urllib.request

from .analysis import ENGINE, ENGINE_VERSION, analyse, decode, download_to_temp

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s worker: %(message)s")
log = logging.getLogger("analysis.worker")


def api(url: str, token: str, payload: dict, path: str) -> dict:
    request = urllib.request.Request(
        f"{url.rstrip('/')}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "content-type": "application/json",
            "authorization": f"Bearer {token}",
            "user-agent": "zarlino-analysis-worker/0.1",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", "ignore")[:300]
        raise RuntimeError(f"{path} failed: HTTP {error.code} {body}") from error


def download(url: str, token: str) -> str:
    """Fetch a beat over HTTP.

    Signed R2 URLs need no auth; the Worker's machine route requires the token.
    """
    request = urllib.request.Request(url, headers={"user-agent": "zarlino-analysis-worker/0.1"})
    if "/api/" in url:
        request.add_header("authorization", f"Bearer {token}")
    with urllib.request.urlopen(request, timeout=600) as response:
        import tempfile

        with tempfile.NamedTemporaryFile(delete=False, suffix=".audio") as handle:
            while True:
                chunk = response.read(1 << 20)
                if not chunk:
                    break
                handle.write(chunk)
            return handle.name


def process(api_url: str, token: str) -> bool:
    claim = api(api_url, token, {}, "/api/analysis/claim")
    job = claim.get("job")
    if not job:
        return False

    job_id = job["id"]
    log.info("claimed %s — %s", job_id, job.get("title", "beat"))
    path: str | None = None
    try:
        audio_source = job.get("audioUrl")
        if audio_source:
            path = download(audio_source, token)
        else:
            path = download(f"{api_url.rstrip('/')}/api/analysis/beat-audio/{job['beatId']}", token)

        started = time.time()
        audio = decode(path)
        profile = analyse(audio)
        elapsed = time.time() - started
        log.info(
            "analysed %s in %.1fs → %.1f BPM, %s",
            job_id,
            elapsed,
            profile["bpm"],
            profile["key"],
        )

        api(
            api_url,
            token,
            {
                "jobId": job_id,
                "profile": profile,
                "engine": ENGINE,
                "engineVersion": ENGINE_VERSION,
            },
            "/api/analysis/submit",
        )
    except Exception as error:  # report honestly instead of leaving the job hanging
        log.error("job %s failed: %s", job_id, error)
        try:
            api(api_url, token, {"jobId": job_id, "error": str(error)}, "/api/analysis/submit")
        except Exception as report_error:  # pragma: no cover - network failure
            log.error("could not report the failure: %s", report_error)
    finally:
        if path and os.path.exists(path):
            try:
                os.unlink(path)
            except OSError:
                pass
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Polling analysis worker")
    parser.add_argument("--url", default=os.environ.get("ANALYSIS_API_URL", ""), help="Worker base URL")
    parser.add_argument("--token", default=os.environ.get("ANALYSIS_MACHINE_TOKEN", ""))
    parser.add_argument("--interval", type=float, default=float(os.environ.get("ANALYSIS_POLL_SECONDS", "5")))
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args(argv)

    if not args.url or not args.token:
        log.error("both --url and --token (or ANALYSIS_API_URL / ANALYSIS_MACHINE_TOKEN) are required")
        return 2

    log.info("polling %s for analysis jobs", args.url)

    # A workstation loses its network now and then (sleep, Wi-Fi roam, VPN drop).
    # The runtime must not die because of it: back off and keep polling.
    failures = 0
    try:
        while True:
            try:
                worked = process(args.url, args.token)
            except KeyboardInterrupt:
                raise
            except Exception as error:
                failures += 1
                delay = min(args.interval * (2 ** min(failures, 5)), 60.0)
                log.warning("poll failed (%d in a row): %s - retrying in %.0fs", failures, error, delay)
                time.sleep(delay)
                continue

            failures = 0
            if args.once:
                return 0 if worked else 1
            if not worked:
                time.sleep(args.interval)
    except KeyboardInterrupt:
        log.info("stopped")
        return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
