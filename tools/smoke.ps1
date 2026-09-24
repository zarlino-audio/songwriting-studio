# Live smoke test: starts the analysis worker, runs the end-to-end checks, stops the worker.
#   powershell -ExecutionPolicy Bypass -File ./tools/smoke.ps1 [-Url https://... ] [-Wait 90]

param(
    [string]$Url = "https://zarlino-songwriting-studio.zarlino001.workers.dev",
    [int]$Wait = 90,
    [string]$Email = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$analysis = Join-Path $root "analysis"
$venvPython = Join-Path $analysis ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPython)) { $venvPython = Join-Path $analysis ".venv/bin/python" }

$devVars = Join-Path $root ".dev.vars"
if (-not (Test-Path $devVars)) { throw "missing .dev.vars (ANALYSIS_MACHINE_TOKEN)" }
$tokenLine = (Get-Content $devVars | Select-String '^ANALYSIS_MACHINE_TOKEN=' | Select-Object -First 1)
if (-not $tokenLine) { throw "ANALYSIS_MACHINE_TOKEN missing from .dev.vars" }
$machineToken = ($tokenLine.Line -replace '^ANALYSIS_MACHINE_TOKEN=', '').Trim()

Write-Host "starting analysis worker against $Url" -ForegroundColor Cyan
$job = Start-Job -ScriptBlock {
    param($dir, $python, $url, $token)
    Set-Location $dir
    & $python -m app.worker --url $url --token $token --interval 3
} -ArgumentList $analysis, $venvPython, $Url, $machineToken

try {
    Start-Sleep -Seconds 3
    $nodeArgs = @("tools/smoke.mjs", "--url", $Url, "--wait", "$Wait")
    if ($Email) { $nodeArgs += @("--email", $Email) }
    Push-Location $root
    try {
        node @nodeArgs
        $exit = $LASTEXITCODE
    } finally {
        Pop-Location
    }
} finally {
    Write-Host ""
    Write-Host "--- analysis worker log ---" -ForegroundColor DarkGray
    Receive-Job $job | Select-Object -Last 12
    Stop-Job $job -ErrorAction SilentlyContinue
    Remove-Job $job -Force -ErrorAction SilentlyContinue
}

exit $exit
