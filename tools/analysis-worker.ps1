# Runs the polling analysis worker against a deployed (or local) Worker.
#   npm run analysis:worker
#
# Requires ANALYSIS_API_URL + ANALYSIS_MACHINE_TOKEN (env vars or parameters).

param(
    [string]$Url = $env:ANALYSIS_API_URL,
    [string]$Token = $env:ANALYSIS_MACHINE_TOKEN,
    [int]$Interval = 5,
    [switch]$Once
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$target = Join-Path $root "analysis"
$venvPython = Join-Path $target ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPython)) { $venvPython = Join-Path $target ".venv/bin/python" }

if (-not (Test-Path $venvPython)) {
    throw "analysis venv missing - run 'npm run analysis:setup' first"
}
if (-not $Url -or -not $Token) {
    throw "set ANALYSIS_API_URL and ANALYSIS_MACHINE_TOKEN (or pass -Url / -Token)"
}

$env:PYTHONUNBUFFERED = "1"
$workerArgs = @("-m", "app.worker", "--url", $Url, "--token", $Token, "--interval", "$Interval")
if ($Once) { $workerArgs += "--once" }

Push-Location $target
try {
    & $venvPython @workerArgs
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
