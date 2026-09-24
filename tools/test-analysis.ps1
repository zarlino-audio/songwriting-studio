# Runs the analysis engine test suite (synthetic signals, no real audio needed).
#   npm run analysis:test

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$target = Join-Path $root "analysis"
$venvPython = Join-Path $target ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPython)) { $venvPython = Join-Path $target ".venv/bin/python" }

if (-not (Test-Path $venvPython)) {
    throw "analysis venv missing - run 'npm run analysis:setup' first"
}

Push-Location $target
try {
    & $venvPython -m pytest tests -q
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
