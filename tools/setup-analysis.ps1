# Creates a local venv for the audio-analysis service and installs its deps.
#   npm run analysis:setup
#
# Python 3.11 is preferred (numpy/scipy/PyAV wheels are guaranteed there).

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$target = Join-Path $root "analysis"

if (-not (Test-Path $target)) {
    throw "analysis/ folder not found at $target"
}

$python = "python"
try {
    $py311 = (py -3.11 -c "import sys; print(sys.executable)" 2>$null)
    if ($py311) { $python = $py311 }
} catch {
    Write-Host "python 3.11 not found via py launcher, using 'python' from PATH" -ForegroundColor Yellow
}

$venv = Join-Path $target ".venv"
if (-not (Test-Path $venv)) {
    Write-Host "creating venv at $venv using $python" -ForegroundColor Cyan
    & $python -m venv $venv
}

$venvPython = Join-Path $venv "Scripts\python.exe"
if (-not (Test-Path $venvPython)) { $venvPython = Join-Path $venv "bin/python" }

Write-Host "installing analysis dependencies" -ForegroundColor Cyan
& $venvPython -m pip install --upgrade pip --quiet
& $venvPython -m pip install -r (Join-Path $target "requirements-dev.txt")
if ($LASTEXITCODE -ne 0) {
    throw "dependency installation failed (exit $LASTEXITCODE)"
}

$decoder = "unknown"
Push-Location $target
try {
    $decoder = (& $venvPython -c "from app.analysis.io import decoder_name; print(decoder_name())" 2>$null | Select-Object -Last 1)
} catch {
    $decoder = "unknown"
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "analysis environment ready: $venvPython" -ForegroundColor Green
Write-Host "audio decoder: $decoder" -ForegroundColor Gray
Write-Host "next: npm run analysis:test   |   npm run analysis:serve" -ForegroundColor Gray
