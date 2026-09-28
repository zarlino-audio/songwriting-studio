# Downloads an object from the beats bucket (or any bucket) for offline inspection.
#   powershell -ExecutionPolicy Bypass -File ./tools/fetch-r2-object.ps1 -Key audio/original/... -Out C:\temp\beat.mp3
#
# Useful for re-running the analyser locally against real beats.

param(
    [Parameter(Mandatory = $true)][string]$Key,
    [Parameter(Mandatory = $true)][string]$Out,
    [string]$Bucket = "songwriting-beats"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$wrangler = Join-Path $root "node_modules\.bin\wrangler.cmd"
if (-not (Test-Path $wrangler)) { throw "wrangler not installed - run npm install first" }

$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

$env:CI = "1"
Push-Location $root
try {
    & $wrangler r2 object get "$Bucket/$Key" --file $Out --remote
    if ($LASTEXITCODE -ne 0) { throw "download failed (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}

$item = Get-Item $Out
Write-Host ("saved {0} ({1:N0} bytes)" -f $item.FullName, $item.Length) -ForegroundColor Green
