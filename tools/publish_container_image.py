"""Build the analysis container image and publish it to the Cloudflare registry.

Why this exists
---------------
`wrangler deploy` builds container images with Docker, and Cloudflare's own docs say
Docker must run wherever you deploy from. This machine cannot run Docker (firmware
virtualization is off, 3.8 GB RAM), and the goal is that *nothing* in production or
deployment needs a workstation. So this script does the same thing wrangler does,
in Python, over plain HTTPS:

  1. pull the base image (`python:3.11-slim`, linux/amd64) from Docker Hub,
  2. build one extra layer: the analysis wheels unpacked into site-packages, plus
     the application source exactly where the Dockerfile would put it,
  3. mint short-lived registry credentials through the Cloudflare API,
  4. push blobs + manifest to registry.cloudflare.com with the Docker Registry v2 API.

Afterwards `wrangler deploy --config wrangler.containers.toml` needs no Docker at all,
because the image is referenced by digest/tag in the registry (Cloudflare docs:
"if `image` is a registry reference ... you do not need Docker at deploy time").

Usage
-----
    python tools/publish_container_image.py --tag 0.4.0 [--dry-run]

Credentials come from the local wrangler login (`wrangler whoami` refreshes it) or
from CLOUDFLARE_API_TOKEN. Tokens are never printed.
"""

from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ANALYSIS = ROOT / "analysis"
WRANGLER_CONFIG = Path(os.environ.get("APPDATA", "")) / "xdg.config" / ".wrangler" / "config" / "default.toml"

REGISTRY = "registry.cloudflare.com"
BASE_REPO = "library/python"
BASE_TAG = "3.11-slim"
TARGET_PY = "3.11"
SITE_PACKAGES = f"/usr/local/lib/python3.11/site-packages"
IMAGE_NAME = "zarlino-songwriting-analysis"
MANIFEST_ACCEPT = ", ".join(
    [
        "application/vnd.docker.distribution.manifest.v2+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.oci.image.index.v1+json",
    ]
)

PLATFORM = {"architecture": "amd64", "os": "linux"}


def log(message: str) -> None:
    print(f"[image] {message}", flush=True)


def http(
    url: str,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    data: bytes | None = None,
    expect: tuple[int, ...] = (200, 201, 202, 204),
) -> tuple[int, dict[str, str], bytes]:
    request = urllib.request.Request(url, method=method, data=data, headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            body = response.read()
            if response.status not in expect:
                raise RuntimeError(f"{method} {url} -> {response.status}: {body[:400]!r}")
            return response.status, dict(response.headers), body
    except urllib.error.HTTPError as error:  # surface the registry's reason verbatim
        detail = error.read()[:400]
        raise RuntimeError(f"{method} {url} -> {error.code}: {detail!r}") from None


# ---------------------------------------------------------------------------
# Cloudflare credentials
# ---------------------------------------------------------------------------
def cloudflare_token() -> str:
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    if token:
        return token
    if not WRANGLER_CONFIG.exists():
        raise SystemExit("No CLOUDFLARE_API_TOKEN and no wrangler login found — run `npx wrangler login`.")
    text = WRANGLER_CONFIG.read_text(encoding="utf-8", errors="replace")
    match = re.search(r'^oauth_token\s*=\s*"([^"]+)"', text, re.MULTILINE)
    if not match:
        raise SystemExit(f"Could not read an OAuth token from {WRANGLER_CONFIG}")
    return match.group(1)


def account_id() -> str:
    from_config = ""
    for path in (ROOT / "wrangler.containers.toml", ROOT / "wrangler.toml"):
        if path.exists():
            found = re.search(r'^account_id\s*=\s*"([^"]+)"', path.read_text(encoding="utf-8"), re.MULTILINE)
            if found:
                from_config = found.group(1)
                break
    return os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip() or from_config


def registry_credentials(token: str, account: str) -> tuple[str, str]:
    url = f"https://api.cloudflare.com/client/v4/accounts/{account}/containers/registries/{REGISTRY}/credentials"
    payload = json.dumps({"expiration_minutes": 30, "permissions": ["push", "pull"]}).encode()
    _status, _headers, body = http(
        url,
        method="POST",
        headers={"authorization": f"Bearer {token}", "content-type": "application/json"},
        data=payload,
    )
    parsed = json.loads(body)
    if not parsed.get("success", True) and "result" not in parsed:
        raise SystemExit(f"Registry credentials refused: {parsed.get('errors')}")
    result = parsed.get("result", parsed)
    username = result.get("username") or "v1"
    password = result.get("password") or result.get("token")
    if not password:
        raise SystemExit("Registry credentials response had no password/token field.")
    log(f"registry credentials minted for {REGISTRY} (username {username}, password length {len(password)})")
    return username, password


# ---------------------------------------------------------------------------
# Docker Hub (base image)
# ---------------------------------------------------------------------------
def docker_hub_token() -> str:
    url = f"https://auth.docker.io/token?service=registry.docker.io&scope=repository:{BASE_REPO}:pull"
    _status, _headers, body = http(url)
    return json.loads(body)["token"]


def hub_get(path: str, token: str, accept: str | None = None) -> tuple[dict[str, str], bytes]:
    headers = {"authorization": f"Bearer {token}"}
    if accept:
        headers["accept"] = accept
    _status, response_headers, body = http(f"https://registry-1.docker.io/v2/{BASE_REPO}/{path}", headers=headers)
    return response_headers, body


def resolve_base(token: str) -> dict:
    """Return the linux/amd64 manifest plus its config for the base image."""
    headers, body = hub_get(f"manifests/{BASE_TAG}", token, MANIFEST_ACCEPT)
    manifest = json.loads(body)
    media_type = headers.get("content-type", manifest.get("mediaType", ""))

    if "list" in media_type or "index" in media_type or manifest.get("manifests"):
        entry = next(
            (
                item
                for item in manifest["manifests"]
                if item.get("platform", {}).get("architecture") == PLATFORM["architecture"]
                and item.get("platform", {}).get("os") == PLATFORM["os"]
            ),
            None,
        )
        if entry is None:
            raise SystemExit("Base image has no linux/amd64 variant.")
        _headers, body = hub_get(f"manifests/{entry['digest']}", token, MANIFEST_ACCEPT)
        manifest = json.loads(body)

    config_digest = manifest["config"]["digest"]
    _headers, blob = hub_get(f"blobs/{config_digest}", token)
    image_config = json.loads(blob)
    log(
        f"base image {BASE_REPO}:{BASE_TAG} linux/amd64 — {len(manifest['layers'])} layers, "
        f"cmd={image_config.get('config', {}).get('Cmd')}"
    )
    return {"manifest": manifest, "config": image_config, "config_blob": blob}


# ---------------------------------------------------------------------------
# Our layer
# ---------------------------------------------------------------------------
def download_wheels(destination: Path) -> list[Path]:
    """Fetch linux/amd64 cp311 wheels for the container requirements."""
    python = sys.executable
    command = [
        python,
        "-m",
        "pip",
        "download",
        "--only-binary=:all:",
        "--python-version",
        TARGET_PY.replace(".", ""),
        "--implementation",
        "cp",
        "--abi",
        "cp311",
        "--platform",
        "manylinux2014_x86_64",
        "--platform",
        "manylinux_2_17_x86_64",
        "--platform",
        "manylinux_2_28_x86_64",
        "--platform",
        "manylinux_2_34_x86_64",
        "--dest",
        str(destination),
        "-r",
        str(ANALYSIS / "requirements.txt"),
    ]
    log("downloading wheels: " + " ".join(command[-3:]))
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise SystemExit(f"pip download failed:\n{result.stdout[-2000:]}\n{result.stderr[-2000:]}")
    wheels = sorted(destination.glob("*.whl"))
    if not wheels:
        raise SystemExit("pip download produced no wheels.")
    for wheel in wheels:
        log(f"  {wheel.name} ({wheel.stat().st_size / 1e6:.1f} MB)")
    return wheels


def tar_add_bytes(tar: tarfile.TarFile, name: str, data: bytes, mode: int = 0o644) -> None:
    info = tarfile.TarInfo(name)
    info.size = len(data)
    info.mode = mode
    info.mtime = 0
    tar.addfile(info, io.BytesIO(data))


def tar_add_dir(tar: tarfile.TarFile, name: str, mode: int = 0o755) -> None:
    info = tarfile.TarInfo(name.rstrip("/") + "/")
    info.type = tarfile.DIRTYPE
    info.mode = mode
    info.mtime = 0
    tar.addfile(info)


def add_wheel(tar: tarfile.TarFile, wheel: Path, added_dirs: set[str]) -> int:
    """Unpack a wheel into site-packages the way pip would."""
    count = 0
    with zipfile.ZipFile(wheel) as archive:
        for entry in archive.infolist():
            if entry.is_dir():
                continue
            relative = entry.filename
            if ".data/" in relative and "/scripts/" in relative:
                continue  # console scripts are not needed by this service
            target = f"{SITE_PACKAGES.lstrip('/')}/{relative}"
            parts = target.split("/")[:-1]
            for index in range(1, len(parts) + 1):
                directory = "/".join(parts[:index])
                if directory and directory not in added_dirs:
                    tar_add_dir(tar, directory)
                    added_dirs.add(directory)
            mode = 0o755 if (entry.external_attr >> 16) & 0o111 else 0o644
            tar_add_bytes(tar, target, archive.read(entry), mode)
            count += 1
    return count


def build_layer(wheels: list[Path]) -> bytes:
    """Gzipped tar with the wheels unpacked plus the app source."""
    buffer = io.BytesIO()
    added_dirs: set[str] = set()
    with tarfile.open(fileobj=buffer, mode="w:gz", compresslevel=6) as tar:
        for directory in ("usr", "usr/local", "usr/local/lib", "usr/local/lib/python3.11", SITE_PACKAGES.lstrip("/")):
            tar_add_dir(tar, directory)
            added_dirs.add(directory)

        total = 0
        for wheel in wheels:
            total += add_wheel(tar, wheel, added_dirs)
        log(f"unpacked {total} files from {len(wheels)} wheels")

        tar_add_dir(tar, "app")
        app_files = 0
        for path in sorted((ANALYSIS / "app").rglob("*")):
            if path.is_dir() or "__pycache__" in path.parts:
                continue
            relative = path.relative_to(ANALYSIS)  # e.g. app/analysis/features.py
            parts = str(relative).split(os.sep)
            for index in range(1, len(parts) + 1):
                directory = "app/" + "/".join(parts[: index - 1]) if index > 1 else "app"
                if directory and directory not in added_dirs:
                    tar_add_dir(tar, directory)
                    added_dirs.add(directory)
            tar_add_bytes(tar, f"app/{relative.as_posix()}", path.read_bytes(), 0o644)
            app_files += 1
        tar_add_bytes(tar, "app/requirements.txt", (ANALYSIS / "requirements.txt").read_bytes(), 0o644)
        log(f"added {app_files} application files")

    return buffer.getvalue()


def image_config(base_config: dict, layer_diff_id: str) -> dict:
    """Base image config with the env/cmd/workdir/healthcheck from analysis/Dockerfile."""
    config = base_config.get("config", {})
    environment = [entry for entry in config.get("Env", []) if not entry.startswith(("PYTHONUNBUFFERED=", "PYTHONDONTWRITEBYTECODE=", "PORT="))]
    environment += ["PYTHONUNBUFFERED=1", "PYTHONDONTWRITEBYTECODE=1", "PORT=8080"]

    healthcheck_command = (
        "import urllib.request,sys; "
        "sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=4).status==200 else 1)"
    )
    new_config = dict(base_config)
    new_config["config"] = {
        **config,
        "Env": environment,
        "WorkingDir": "/app",
        "ExposedPorts": {"8080/tcp": {}},
        "Cmd": ["python3", "-m", "app.server", "--host", "0.0.0.0", "--port", "8080"],
        "Healthcheck": {
            "Test": ["CMD", "python3", "-c", healthcheck_command],
            "Interval": 30_000_000_000,
            "Timeout": 5_000_000_000,
            "StartPeriod": 20_000_000_000,
            "Retries": 3,
        },
    }
    history = list(new_config.get("history", []))
    history.append({"created_by": "COPY app / install -r requirements.txt (publish_container_image.py)"})
    history.append({"created_by": "CMD python -m app.server", "empty_layer": True})
    new_config["history"] = history
    new_config["rootfs"] = {
        "type": "layers",
        "diff_ids": list(new_config.get("rootfs", {}).get("diff_ids", [])) + [layer_diff_id],
    }
    new_config.pop("container", None)
    new_config.pop("docker_version", None)
    return new_config


def digest_of(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


# ---------------------------------------------------------------------------
# Registry push
# ---------------------------------------------------------------------------
class Registry:
    def __init__(self, repository: str, username: str, password: str) -> None:
        self.repository = repository
        self.auth = base64.b64encode(f"{username}:{password}".encode()).decode()

    def _headers(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        headers = {"authorization": f"Basic {self.auth}"}
        headers.update(extra or {})
        return headers

    def has_blob(self, digest: str) -> bool:
        try:
            http(
                f"https://{REGISTRY}/v2/{self.repository}/blobs/{digest}",
                method="HEAD",
                headers=self._headers(),
                expect=(200,),
            )
            return True
        except RuntimeError:
            return False

    def push_blob(self, digest: str, data: bytes) -> None:
        if self.has_blob(digest):
            log(f"  blob {digest[:19]}… already present")
            return
        _status, headers, _body = http(
            f"https://{REGISTRY}/v2/{self.repository}/blobs/uploads/",
            method="POST",
            headers=self._headers(),
            expect=(201, 202),
        )
        location = headers.get("location") or headers.get("Location")
        if not location:
            raise RuntimeError("Registry did not return an upload location.")
        if location.startswith("/"):
            location = f"https://{REGISTRY}{location}"
        separator = "&" if "?" in location else "?"
        started = time.time()
        http(
            f"{location}{separator}digest={digest}",
            method="PUT",
            headers=self._headers({"content-type": "application/octet-stream", "content-length": str(len(data))}),
            data=data,
            expect=(201, 202),
        )
        log(f"  pushed {digest[:19]}… ({len(data) / 1e6:.1f} MB in {time.time() - started:.0f}s)")

    def push_manifest(self, tag: str, manifest: dict) -> None:
        body = json.dumps(manifest).encode()
        _status, _headers, _body = http(
            f"https://{REGISTRY}/v2/{self.repository}/manifests/{tag}",
            method="PUT",
            headers=self._headers({"content-type": "application/vnd.docker.distribution.manifest.v2+json"}),
            data=body,
            expect=(200, 201),
        )
        log(f"  manifest pushed as {REGISTRY}/{self.repository}:{tag}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Publish the analysis image to the Cloudflare registry without Docker")
    parser.add_argument("--tag", required=True, help="image tag, e.g. 0.4.0")
    parser.add_argument("--image", default=IMAGE_NAME)
    parser.add_argument("--dry-run", action="store_true", help="build the layer and print digests, push nothing")
    parser.add_argument("--keep-wheels", default="", help="reuse wheels already downloaded in this directory")
    args = parser.parse_args(argv)

    account = account_id()
    if not account:
        raise SystemExit("Could not determine the Cloudflare account id (wrangler.toml account_id).")
    repository = f"{account}/{args.image}"

    with tempfile.TemporaryDirectory(prefix="zarlino-image-") as temporary:
        wheels_dir = Path(args.keep_wheels) if args.keep_wheels else Path(temporary) / "wheels"
        wheels_dir.mkdir(parents=True, exist_ok=True)
        wheels = sorted(wheels_dir.glob("*.whl"))
        if not wheels:
            wheels = download_wheels(wheels_dir)

        hub_token = docker_hub_token()
        base = resolve_base(hub_token)

        layer = build_layer(wheels)
        layer_digest = digest_of(layer)
        log(f"layer built: {len(layer) / 1e6:.1f} MB compressed")

        # The config's rootfs.diff_ids are digests of the *uncompressed* layer tars.
        uncompressed = gzip.decompress(layer)
        layer_diff_id = digest_of(uncompressed)
        log(f"layer diff_id {layer_diff_id[:19]}… ({len(uncompressed) / 1e6:.1f} MB uncompressed)")

        config = image_config(base["config"], layer_diff_id)
        config_blob = json.dumps(config, separators=(",", ":")).encode()
        config_digest = digest_of(config_blob)

        base_layers = [
            {
                "mediaType": entry.get("mediaType", "application/vnd.docker.image.rootfs.diff.tar.gzip"),
                "size": entry["size"],
                "digest": entry["digest"],
            }
            for entry in base["manifest"]["layers"]
        ]
        manifest = {
            "schemaVersion": 2,
            "mediaType": "application/vnd.docker.distribution.manifest.v2+json",
            "config": {"mediaType": "application/vnd.docker.container.image.v1+json", "size": len(config_blob), "digest": config_digest},
            "layers": base_layers
            + [
                {
                    "mediaType": "application/vnd.docker.image.rootfs.diff.tar.gzip",
                    "size": len(layer),
                    "digest": layer_digest,
                }
            ],
        }

        log(f"config {config_digest[:19]}…, manifest references {len(manifest['layers'])} layers")
        if args.dry_run:
            log("dry run: nothing pushed")
            return 0

        username, password = registry_credentials(cloudflare_token(), account)
        registry = Registry(repository, username, password)
        log(f"pushing to {REGISTRY}/{repository}:{args.tag}")
        for index, layer_json in enumerate(base["manifest"]["layers"]):
            _headers, blob = hub_get(f"blobs/{layer_json['digest']}", hub_token)
            log(f"  base layer {index + 1}/{len(base['manifest']['layers'])} ({len(blob) / 1e6:.1f} MB)")
            registry.push_blob(layer_json["digest"], blob)
        registry.push_blob(config_digest, config_blob)
        registry.push_blob(layer_digest, layer)
        registry.push_manifest(args.tag, manifest)

    log(f"\nimage reference: {REGISTRY}/{repository}:{args.tag}")
    log("set `image` in wrangler.containers.toml to that value, then deploy without Docker.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
