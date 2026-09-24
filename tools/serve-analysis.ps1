# Runs the audio-analysis service locally on http://127.0.0.1:8788
#   npm run analysis:serve
#
# Point the Worker at it with ANALYSIS_URL (wrangler.toml [vars]) - matching the
# ANALYSIS_SHARED_SECRET secret when one is set.

param(
    [int]$Port = 8788,
    [string]$Secret = $env:ANALYSIS_SHARED_SECRET
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$target = Join-Path $root "analysis"
$venvPython = Join-Path $target ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPython)) { $venvPython = Join-Path $target ".venv/bin/python" }

if (-not (Test-Path $venvPython)) {
    throw "analysis venv missing - run 'npm run analysis:setup' first"
}

$env:PYTHONUNBUFFERED = "1"
$env:MAX_AUDIO_SECONDS = if ($env:MAX_AUDIO_SECONDS) { $env:MAX_AUDIO_SECONDS } else { "1800" }
$env:ANALYSIS_SHARED_SECRET = $Secret

Push-Location $target
try {
    & $venvPython -m app.server --host 127.0.0.1 --port $Port --secret $Secret
} finally {
    Pop-Location
}
